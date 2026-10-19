import { Router } from 'express';
import type { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { validate } from '@/middleware/validate.js';
import { asyncHandler } from '@/middleware/errorHandler.js';
import { requireAuth } from '@/middleware/auth.js';
import { CursorPaginationQuery } from '@/lib/pagination.js';
import { createNotificationsService } from './notifications.service.js';

const ListQuery = CursorPaginationQuery.extend({
  unread: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === 'true')),
});

const IdParam = z.object({ id: z.string().uuid() });

export function createNotificationsRouter(prisma: PrismaClient): Router {
  const router = Router();
  const service = createNotificationsService(prisma);

  router.get(
    '/',
    requireAuth,
    validate({ query: ListQuery }),
    asyncHandler(async (req, res) => {
      const q = req.query as unknown as { cursor?: string; limit: number; unread?: boolean };
      res.json(await service.list(req.user!.id, q));
    }),
  );

  router.patch(
    '/read-all',
    requireAuth,
    asyncHandler(async (req, res) => {
      res.json(await service.markAllRead(req.user!.id));
    }),
  );

  router.patch(
    '/:id/read',
    requireAuth,
    validate({ params: IdParam }),
    asyncHandler(async (req, res) => {
      res.json(await service.markRead(req.params.id!, req.user!.id));
    }),
  );

  return router;
}
