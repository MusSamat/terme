import { Router } from 'express';
import type { PrismaClient } from '@prisma/client';
import { createBookingsService } from './bookings.service.js';
import {
  BookingCancelBody,
  BookingCreateBody,
  BookingIdParam,
  BookingRejectBody,
  IncomingBookingsQuery,
  MyBookingsQuery,
} from './bookings.schemas.js';
import { validate } from '@/middleware/validate.js';
import { asyncHandler } from '@/middleware/errorHandler.js';
import { requireAuth } from '@/middleware/auth.js';
import { bookingCreateLimit } from '@/middleware/rateLimit.js';
import type { Notifier } from '@/lib/notifier.js';

export function createBookingsRouter(prisma: PrismaClient, notifier: Notifier): Router {
  const router = Router();
  const service = createBookingsService(prisma, notifier);

  router.post(
    '/',
    requireAuth,
    bookingCreateLimit,
    validate({ body: BookingCreateBody }),
    asyncHandler(async (req, res) => {
      const idempotencyKey = req.header('idempotency-key') ?? undefined;
      const { booking, reused } = await service.create(
        req.user!.id,
        req.body as Parameters<typeof service.create>[1],
        idempotencyKey,
      );
      // Replay of a prior key → 200 with the original booking; fresh → 201.
      res.status(reused ? 200 : 201).json(booking);
    }),
  );

  // Listing routes before /:id so they don't get swallowed as UUID params.
  router.get(
    '/my',
    requireAuth,
    validate({ query: MyBookingsQuery }),
    asyncHandler(async (req, res) => {
      const result = await service.listMy(
        req.user!.id,
        req.query as unknown as Parameters<typeof service.listMy>[1],
      );
      res.json(result);
    }),
  );

  router.get(
    '/incoming',
    requireAuth,
    validate({ query: IncomingBookingsQuery }),
    asyncHandler(async (req, res) => {
      const result = await service.listIncoming(
        req.user!.id,
        req.query as unknown as Parameters<typeof service.listIncoming>[1],
      );
      res.json(result);
    }),
  );

  router.get(
    '/:id',
    requireAuth,
    validate({ params: BookingIdParam }),
    asyncHandler(async (req, res) => {
      const booking = await service.getById(req.params.id!, req.user!.id);
      // Fire-and-forget: if the viewer is the driver, stamp viewed_at.
      if (req.user!.roles.includes('driver')) {
        service.markViewed(req.params.id!, req.user!.id).catch(() => undefined);
      }
      res.json(booking);
    }),
  );

  router.patch(
    '/:id/accept',
    requireAuth,
    validate({ params: BookingIdParam }),
    asyncHandler(async (req, res) => {
      const updated = await service.accept(req.params.id!, req.user!.id);
      res.json(updated);
    }),
  );

  router.patch(
    '/:id/reject',
    requireAuth,
    validate({ params: BookingIdParam, body: BookingRejectBody }),
    asyncHandler(async (req, res) => {
      const { reason } = (req.body ?? {}) as { reason?: string };
      const updated = await service.reject(req.params.id!, req.user!.id, reason);
      res.json(updated);
    }),
  );

  router.patch(
    '/:id/cancel',
    requireAuth,
    validate({ params: BookingIdParam, body: BookingCancelBody }),
    asyncHandler(async (req, res) => {
      const updated = await service.cancel(
        req.params.id!,
        req.user!.id,
        (req.body ?? {}) as Parameters<typeof service.cancel>[2],
      );
      res.json(updated);
    }),
  );

  router.patch(
    '/:id/no-show',
    requireAuth,
    validate({ params: BookingIdParam }),
    asyncHandler(async (req, res) => {
      const updated = await service.noShow(req.params.id!, req.user!.id);
      res.json(updated);
    }),
  );

  return router;
}
