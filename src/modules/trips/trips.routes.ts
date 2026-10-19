import { Router } from 'express';
import { z } from 'zod';
import type { PrismaClient } from '@prisma/client';
import { createTripsService } from './trips.service.js';
import { createContactsService } from '../contacts/contacts.service.js';
import type { Notifier } from '@/lib/notifier.js';
import {
  IdempotencyHeader,
  MyTripsQuery,
  PriceSuggestionQuery,
  SeatsAdjustBody,
  TripCancelBody,
  TripCalendarQuery,
  TripCreateBody,
  TripIdParam,
  TripPatchBody,
  TripSearchQuery,
} from './trips.schemas.js';
import { validate } from '@/middleware/validate.js';
import { asyncHandler } from '@/middleware/errorHandler.js';
import { optionalAuth, requireAuth } from '@/middleware/auth.js';
import {
  contactIpLimit,
  publicReadLimit,
  tripCreateLimit,
  viewIpLimit,
} from '@/middleware/rateLimit.js';
import { Errors } from '@/lib/errors.js';

export function createTripsRouter(prisma: PrismaClient, notifier?: Notifier): Router {
  const router = Router();
  const service = createTripsService(prisma, notifier);
  const contacts = createContactsService(prisma);

  router.get(
    '/',
    optionalAuth,
    publicReadLimit,
    validate({ query: TripSearchQuery }),
    asyncHandler(async (req, res) => {
      const result = await service.search(
        req.query as unknown as Parameters<typeof service.search>[0],
        req.user?.id ?? null,
      );
      res.json(result);
    }),
  );

  // POST /trips — only verified drivers. Idempotency-Key header required.
  router.post(
    '/',
    requireAuth,
    tripCreateLimit,
    validate({ body: TripCreateBody, headers: IdempotencyHeader }),
    asyncHandler(async (req, res) => {
      const key = req.header('idempotency-key');
      if (!key) throw Errors.validation({ reason: 'missing_idempotency_key' });
      const { trip, reused } = await service.create(
        req.user!.id,
        req.body as Parameters<typeof service.create>[1],
        key,
      );
      res.status(reused ? 200 : 201).json(trip);
    }),
  );

  // GET /trips/my — must come before /:id to avoid "my" being parsed as a UUID.
  router.get(
    '/my',
    requireAuth,
    validate({ query: MyTripsQuery }),
    asyncHandler(async (req, res) => {
      const result = await service.myTrips(
        req.user!.id,
        req.query as unknown as Parameters<typeof service.myTrips>[1],
      );
      res.json(result);
    }),
  );

  // POST /trips/:id/seats — manual ±1 seat adjust (phone deals happen off-
  // platform; the driver keeps availability honest). Owner only.
  router.post(
    '/:id/seats',
    requireAuth,
    validate({ params: TripIdParam, body: SeatsAdjustBody }),
    asyncHandler(async (req, res) => {
      const trip = await service.adjustSeats(
        req.params.id!,
        req.user!.id,
        (req.body as { delta: 1 | -1 }).delta,
      );
      res.json(trip);
    }),
  );

  // POST /trips/:id/contact — reveal the driver's phone («Позвонить»).
  // Auth-gated + audited + daily-limited; see contacts.service.
  router.post(
    '/:id/contact',
    contactIpLimit,
    requireAuth,
    validate({ params: TripIdParam }),
    asyncHandler(async (req, res) => {
      const contact = await contacts.revealForTrip(req.params.id!, req.user!.id);
      res.json(contact);
    }),
  );

  // GET /trips/calendar — per-day counts for the date picker (before /:id).
  router.get(
    '/calendar',
    validate({ query: TripCalendarQuery }),
    asyncHandler(async (req, res) => {
      const result = await service.calendar(
        req.query as unknown as Parameters<typeof service.calendar>[0],
      );
      res.json(result);
    }),
  );

  router.get(
    '/:id',
    optionalAuth,
    publicReadLimit,
    validate({ params: TripIdParam }),
    asyncHandler(async (req, res) => {
      const trip = await service.getById(req.params.id!, req.user?.id ?? null);
      res.json(trip);
    }),
  );

  // Like / unlike a trip (any authenticated user).
  router.post(
    '/:id/like',
    requireAuth,
    validate({ params: TripIdParam }),
    asyncHandler(async (req, res) => {
      res.json(await service.like(req.params.id!, req.user!.id));
    }),
  );

  router.delete(
    '/:id/like',
    requireAuth,
    validate({ params: TripIdParam }),
    asyncHandler(async (req, res) => {
      res.json(await service.unlike(req.params.id!, req.user!.id));
    }),
  );

  // Record a unique view on detail open. Public (lists/details are open to all):
  // authenticated → counted by user; anonymous → counted by client anonId.
  router.post(
    '/:id/view',
    viewIpLimit,
    optionalAuth,
    validate({ params: TripIdParam, body: z.object({ anonId: z.string().uuid().optional() }) }),
    asyncHandler(async (req, res) => {
      const { anonId } = req.body as { anonId?: string };
      await service.recordView(req.params.id!, {
        userId: req.user?.id ?? null,
        anonId: anonId ?? null,
      });
      res.status(204).send();
    }),
  );

  router.patch(
    '/:id',
    requireAuth,
    validate({ params: TripIdParam, body: TripPatchBody }),
    asyncHandler(async (req, res) => {
      const updated = await service.patch(
        req.params.id!,
        req.user!.id,
        req.body as Parameters<typeof service.patch>[2],
      );
      res.json(updated);
    }),
  );

  router.patch(
    '/:id/complete',
    requireAuth,
    validate({ params: TripIdParam }),
    asyncHandler(async (req, res) => {
      const result = await service.complete(req.params.id!, req.user!.id);
      res.json(result);
    }),
  );

  router.delete(
    '/:id',
    requireAuth,
    validate({ params: TripIdParam, body: TripCancelBody }),
    asyncHandler(async (req, res) => {
      const { reason } = req.body as { reason?: string };
      const result = await service.cancel(req.params.id!, req.user!.id, reason);
      res.json(result);
    }),
  );

  return router;
}

// Separate router for /routes/* because the path doesn't belong under /trips —
// same service though.
export function createRoutesRouter(prisma: PrismaClient): Router {
  const router = Router();
  const service = createTripsService(prisma);

  router.get(
    '/price-suggestion',
    requireAuth,
    validate({ query: PriceSuggestionQuery }),
    asyncHandler(async (req, res) => {
      const { from_id, to_id } = req.query as unknown as { from_id: number; to_id: number };
      const result = await service.priceSuggestion(from_id, to_id);
      res.json(result);
    }),
  );

  return router;
}
