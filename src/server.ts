import express, { type Express } from 'express';
import path from 'node:path';
import cors from 'cors';
import helmet from 'helmet';
import swaggerUi from 'swagger-ui-express';
import type { PrismaClient } from '@prisma/client';
import { env, isProd } from '@/config/env.js';
import { isAllowedOrigin } from '@/lib/cors.js';
import { logger } from '@/lib/logger.js';
import { requestContext } from '@/middleware/requestContext.js';
import { globalIpLimit } from '@/middleware/rateLimit.js';
import { globalErrorHandler, notFoundHandler } from '@/middleware/errorHandler.js';
import { createAuthRouter } from '@/modules/auth/auth.routes.js';
import { createHealthRouter } from '@/modules/health/health.routes.js';
import { createUsersRouter } from '@/modules/users/users.routes.js';
import { createCitiesRouter } from '@/modules/cities/cities.routes.js';
import { createDriversRouter } from '@/modules/drivers/drivers.routes.js';
import { createCarsRouter } from '@/modules/cars/cars.routes.js';
import { createCarCatalogService } from '@/modules/cars/carCatalog.service.js';
import { createAdminRouter } from '@/modules/admin/admin.routes.js';
import { createRoutesRouter, createTripsRouter } from '@/modules/trips/trips.routes.js';
import { createBookingsRouter } from '@/modules/bookings/bookings.routes.js';
import { createChatsRouter, createMessagesRouter } from '@/modules/chat/chat.routes.js';
import { createRatingsRouter } from '@/modules/ratings/ratings.routes.js';
import { createNotificationsRouter } from '@/modules/notifications/notifications.routes.js';
import { createComplaintsRouter } from '@/modules/complaints/complaints.routes.js';
import { createLoyaltyRouter } from '@/modules/loyalty/loyalty.routes.js';
import { createPassengerRequestsRouter } from '@/modules/passenger-requests/passenger-requests.routes.js';
import { createPresenceRouter } from '@/modules/presence/presence.routes.js';
import { createWhatsappRouter } from '@/modules/whatsapp/whatsapp.routes.js';
import { NoopNotifier, type Notifier } from '@/lib/notifier.js';
import type { TelegramSender } from '@/modules/auth/auth.otp.js';
import { openapiDocument } from '@/openapi.js';

/**
 * Build the Express app. Returns a vanilla instance with no side effects —
 * each test can spin up its own app without port binding (Supertest attaches
 * directly to the handler).
 */
export function createApp(
  prisma: PrismaClient,
  notifier: Notifier = new NoopNotifier(),
  bot: TelegramSender | null = null,
): Express {
  const app = express();

  // Behind Nginx — trust X-Forwarded-For so rate-limit and logs see the real IP.
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use(helmet({ contentSecurityPolicy: isProd ? undefined : false }));

  app.use(
    cors({
      // Allowlist (incl. MINI_APP_URL) is shared with Socket.IO — see lib/cors.
      // Disallowed origin → cb(null, false): cors simply omits the ACAO
      // headers and the BROWSER blocks the call with a clear CORS message.
      // cb(new Error(...)) here used to bubble into the error handler as a
      // misleading 500 on the OPTIONS preflight (e.g. stale tunnel origins).
      origin: (origin, cb) => {
        const allowed = isAllowedOrigin(origin);
        if (!allowed) logger.warn({ origin }, 'CORS: origin rejected');
        cb(null, allowed);
      },
      credentials: true,
    }),
  );
  // Capture the raw body so the WhatsApp webhook can verify Meta's
  // X-Hub-Signature-256 HMAC (computed over the exact received bytes).
  app.use(
    express.json({
      limit: '1mb',
      verify: (req, _res, buf) => {
        (req as express.Request & { rawBody?: Buffer }).rawBody = buf;
      },
    }),
  );
  app.use(express.urlencoded({ extended: false, limit: '1mb' }));
  app.use(requestContext);
  app.use(globalIpLimit);

  // Health goes outside /v1 so load balancers can probe it without versioning.
  app.use(createHealthRouter(prisma));

  // Versioned API surface.
  const v1 = express.Router();
  v1.use('/auth', createAuthRouter(prisma, notifier, bot));
  v1.use('/users', createUsersRouter(prisma, notifier, bot));
  v1.use('/cities', createCitiesRouter(prisma));
  v1.use('/drivers', createDriversRouter(prisma));
  const carCatalog = createCarCatalogService(prisma);
  v1.use('/cars', createCarsRouter(prisma, carCatalog));
  v1.use('/trips', createTripsRouter(prisma, notifier));
  v1.use('/routes', createRoutesRouter(prisma));
  v1.use('/bookings', createBookingsRouter(prisma, notifier));
  v1.use('/chats', createChatsRouter(prisma, notifier));
  v1.use('/messages', createMessagesRouter(prisma, notifier));
  v1.use('/ratings', createRatingsRouter(prisma, notifier));
  v1.use('/notifications', createNotificationsRouter(prisma));
  v1.use('/complaints', createComplaintsRouter(prisma, notifier));
  v1.use('/loyalty', createLoyaltyRouter(prisma, notifier));
  v1.use('/passenger-requests', createPassengerRequestsRouter(prisma, notifier));
  v1.use('/presence', createPresenceRouter(prisma));
  v1.use('/whatsapp', createWhatsappRouter(prisma));
  v1.use('/admin', createAdminRouter(prisma, notifier, carCatalog));
  app.use('/v1', v1);

  // Swagger — dev/staging only, gated by ENABLE_SWAGGER.
  if (env.ENABLE_SWAGGER && !isProd) {
    app.use('/docs', swaggerUi.serve, swaggerUi.setup(openapiDocument));
    app.get('/openapi.json', (_req, res) => res.json(openapiDocument));
    logger.info('Swagger enabled at /docs');
  }

  // Serve uploaded files (avatars, driver docs) from FILES_DIR.
  // e.g. GET /avatars/2026/04/xxx.jpg → ./var/files/avatars/2026/04/xxx.jpg
  // Override Helmet's default CORP: same-origin so the web frontend (different port
  // in dev, different subdomain in prod) can load images with plain <img src>.
  app.use(
    express.static(path.resolve(env.FILES_DIR), {
      setHeaders: (res) => {
        res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
      },
    }),
  );

  // 404 + global error handler must be registered last.
  app.use(notFoundHandler);
  app.use(globalErrorHandler);

  return app;
}
