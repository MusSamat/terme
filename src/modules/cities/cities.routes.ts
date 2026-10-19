import { Router } from 'express';
import type { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { asyncHandler } from '@/middleware/errorHandler.js';
import { validate } from '@/middleware/validate.js';
import { publicReadLimit } from '@/middleware/rateLimit.js';
import { createCitiesService } from './cities.service.js';

/**
 * Public settlements directory (official SOATE) for pickers and maps.
 *
 * GET /cities?q=биш&limit=10         → autocomplete (max 20); no q → top places
 * GET /cities/nearest?lat=..&lng=..  → the settlement a GPS point is in
 * GET /cities/popular-routes         → popular routes with live trip counts
 * GET /cities/:id/spots?q=          → meeting spots + жилмассивы (Бишкек, Ош)
 * GET /cities/airports               → airports + the city each one serves
 */
const SearchQuery = z.object({
  q: z.string().trim().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(20).default(10),
});

const NearestQuery = z.object({
  lat: z.coerce.number().min(39).max(43.5),
  lng: z.coerce.number().min(69).max(81),
});

export function createCitiesRouter(prisma: PrismaClient): Router {
  const router = Router();
  const service = createCitiesService(prisma);

  router.get(
    '/popular-routes',
    asyncHandler(async (_req, res) => {
      res.json({ data: await service.popularRoutes() });
    }),
  );

  router.get(
    '/airports',
    asyncHandler(async (_req, res) => {
      res.json({ data: await service.airports() });
    }),
  );

  router.get(
    '/nearest',
    validate({ query: NearestQuery }),
    asyncHandler(async (req, res) => {
      const { lat, lng } = req.query as unknown as { lat: number; lng: number };
      res.json({ data: await service.nearest(lat, lng) });
    }),
  );

  router.get(
    '/:id/spots',
    validate({
      params: z.object({ id: z.coerce.number().int().positive() }),
      query: z.object({ q: z.string().trim().max(100).optional() }),
    }),
    asyncHandler(async (req, res) => {
      const { q } = req.query as { q?: string };
      res.json({ data: await service.spots(Number(req.params.id), q) });
    }),
  );

  router.get(
    '/',
    publicReadLimit,
    validate({ query: SearchQuery }),
    asyncHandler(async (req, res) => {
      const { q, limit } = req.query as unknown as { q?: string; limit: number };
      res.json({ data: q ? await service.search(q, limit) : await service.top(limit) });
    }),
  );

  return router;
}
