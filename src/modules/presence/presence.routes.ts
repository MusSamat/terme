import { Router } from 'express';
import type { PrismaClient } from '@prisma/client';
import { requireAuth } from '@/middleware/auth.js';
import { asyncHandler } from '@/middleware/errorHandler.js';
import { createPresenceService, normalizePlatform } from './presence.service.js';

export function createPresenceRouter(prisma: PrismaClient): Router {
  const router = Router();
  const service = createPresenceService(prisma);

  // Authenticated heartbeat — clients call every ~30s while the app is active.
  // Platform comes from the `X-Client-Platform` header (web | mini | mobile).
  router.post(
    '/ping',
    requireAuth,
    asyncHandler(async (req, res) => {
      const platform = normalizePlatform(req.header('x-client-platform'));
      await service.ping(req.user!.id, platform);
      res.status(204).send();
    }),
  );

  // Public online counter (cached ~10s). Shape: { online: number }.
  router.get(
    '/online',
    asyncHandler(async (_req, res) => {
      const online = await service.onlineCount();
      res.json({ online });
    }),
  );

  return router;
}
