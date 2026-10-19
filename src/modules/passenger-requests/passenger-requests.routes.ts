import { Router } from 'express';
import { z } from 'zod';
import type { PrismaClient } from '@prisma/client';
import type { Notifier } from '@/lib/notifier.js';
import { createPassengerRequestsService, createPassengerRequestResponsesService } from './passenger-requests.service.js';
import { createContactsService } from '../contacts/contacts.service.js';
import {
  CreatePassengerRequestBody,
  ListRequestsQuery,
  RequestCalendarQuery,
  RequestIdParam,
  RespondBody,
  ResponseIdParam,
  UpdatePassengerRequestBody,
} from './passenger-requests.schemas.js';
import { validate } from '@/middleware/validate.js';
import { asyncHandler } from '@/middleware/errorHandler.js';
import { optionalAuth, requireAuth } from '@/middleware/auth.js';
import {
  contactIpLimit,
  publicReadLimit,
  requestCreateLimit,
  viewIpLimit,
} from '@/middleware/rateLimit.js';

export function createPassengerRequestsRouter(prisma: PrismaClient, notifier: Notifier): Router {
  const router = Router();
  const service = createPassengerRequestsService(prisma);
  const responsesService = createPassengerRequestResponsesService(prisma, notifier);
  const contacts = createContactsService(prisma);

  // GET /passenger-requests — open requests list (public, drivers browse)
  router.get(
    '/',
    optionalAuth,
    publicReadLimit,
    validate({ query: ListRequestsQuery }),
    asyncHandler(async (req, res) => {
      const result = await service.list(
        req.query as unknown as Parameters<typeof service.list>[0],
        req.user?.id ?? null,
      );
      res.json(result);
    }),
  );

  // GET /passenger-requests/my — authenticated passenger's own requests
  router.get(
    '/my',
    requireAuth,
    asyncHandler(async (req, res) => {
      const result = await service.listMy(req.user!.id);
      res.json(result);
    }),
  );

  // POST /passenger-requests/:id/contact — reveal the passenger's phone
  // («Позвонить»). Auth-gated + audited + daily-limited.
  router.post(
    '/:id/contact',
    contactIpLimit,
    requireAuth,
    validate({ params: RequestIdParam }),
    asyncHandler(async (req, res) => {
      const contact = await contacts.revealForRequest(req.params.id!, req.user!.id);
      res.json(contact);
    }),
  );

  // GET /passenger-requests/calendar — per-day counts for the date picker
  // (must come before /:id).
  router.get(
    '/calendar',
    validate({ query: RequestCalendarQuery }),
    asyncHandler(async (req, res) => {
      const result = await service.calendar(
        req.query as unknown as Parameters<typeof service.calendar>[0],
      );
      res.json(result);
    }),
  );

  // GET /passenger-requests/:id — single request
  router.get(
    '/:id',
    optionalAuth,
    publicReadLimit,
    validate({ params: RequestIdParam }),
    asyncHandler(async (req, res) => {
      const result = await service.getById(req.params.id!, req.user?.id ?? null);
      res.json(result);
    }),
  );

  // Like / unlike a passenger request (any authenticated user).
  router.post(
    '/:id/like',
    requireAuth,
    validate({ params: RequestIdParam }),
    asyncHandler(async (req, res) => {
      res.json(await service.like(req.params.id!, req.user!.id));
    }),
  );

  router.delete(
    '/:id/like',
    requireAuth,
    validate({ params: RequestIdParam }),
    asyncHandler(async (req, res) => {
      res.json(await service.unlike(req.params.id!, req.user!.id));
    }),
  );

  // Record a unique view on detail open (public: authed → by user, anon → by anonId).
  router.post(
    '/:id/view',
    viewIpLimit,
    optionalAuth,
    validate({ params: RequestIdParam, body: z.object({ anonId: z.string().uuid().optional() }) }),
    asyncHandler(async (req, res) => {
      const { anonId } = req.body as { anonId?: string };
      await service.recordView(req.params.id!, {
        userId: req.user?.id ?? null,
        anonId: anonId ?? null,
      });
      res.status(204).send();
    }),
  );

  // POST /passenger-requests — create (auth required)
  router.post(
    '/',
    requireAuth,
    requestCreateLimit,
    validate({ body: CreatePassengerRequestBody }),
    asyncHandler(async (req, res) => {
      const result = await service.create(
        req.user!.id,
        req.body as Parameters<typeof service.create>[1],
      );
      res.status(201).json(result);
    }),
  );

  // PATCH /passenger-requests/:id — edit own open request (seats/date/comment)
  router.patch(
    '/:id',
    requireAuth,
    validate({ params: RequestIdParam, body: UpdatePassengerRequestBody }),
    asyncHandler(async (req, res) => {
      const updated = await service.update(
        req.params.id!,
        req.user!.id,
        req.body as Parameters<typeof service.update>[2],
      );
      res.json(updated);
    }),
  );

  // DELETE /passenger-requests/:id — cancel own request
  router.delete(
    '/:id',
    requireAuth,
    validate({ params: RequestIdParam }),
    asyncHandler(async (req, res) => {
      await service.cancel(req.params.id!, req.user!.id);
      res.status(204).end();
    }),
  );

  // POST /passenger-requests/:id/respond — driver submits an offer
  router.post(
    '/:id/respond',
    requireAuth,
    validate({ params: RequestIdParam, body: RespondBody }),
    asyncHandler(async (req, res) => {
      const result = await responsesService.respond(
        req.user!.id,
        req.params.id!,
        req.body as Parameters<typeof responsesService.respond>[2],
      );
      res.status(201).json(result);
    }),
  );

  // GET /passenger-requests/:id/responses — passenger views offers on their request
  router.get(
    '/:id/responses',
    requireAuth,
    validate({ params: RequestIdParam }),
    asyncHandler(async (req, res) => {
      const result = await responsesService.listResponses(req.params.id!, req.user!.id);
      res.json(result);
    }),
  );

  // POST /passenger-requests/:id/respond/:responseId/accept — passenger accepts offer
  router.post(
    '/:id/respond/:responseId/accept',
    requireAuth,
    validate({ params: ResponseIdParam }),
    asyncHandler(async (req, res) => {
      const result = await responsesService.acceptResponse(
        req.user!.id,
        req.params.id!,
        req.params.responseId!,
      );
      res.json(result);
    }),
  );

  // POST /passenger-requests/:id/respond/:responseId/decline — passenger declines offer
  router.post(
    '/:id/respond/:responseId/decline',
    requireAuth,
    validate({ params: ResponseIdParam }),
    asyncHandler(async (req, res) => {
      await responsesService.declineResponse(req.user!.id, req.params.id!, req.params.responseId!);
      res.status(204).end();
    }),
  );

  return router;
}
