import { Router } from 'express';
import type { PrismaClient } from '@prisma/client';
import { asyncHandler } from '@/middleware/errorHandler.js';
import { validate } from '@/middleware/validate.js';
import { publicReadLimit } from '@/middleware/rateLimit.js';
import {
  MapQuery,
  MapRouteQuery,
  type MapQueryInput,
  type MapRouteQueryInput,
} from '@/modules/cities/cities.schemas.js';
import { createMapService } from './map.service.js';
import { createMapRouteService } from './mapRoute.service.js';

// GET /map?kind=trips|requests&bbox=w,s,e,n&zoom=12[&to_id=][&date=]
export function createMapRouter(prisma: PrismaClient): Router {
  const router = Router();
  const service = createMapService(prisma);
  const routeService = createMapRouteService(prisma);

  // GET /map/route?kind=trips|requests&from_id=&to_id=[&date=][&ride=] — every
  // active listing of the route (cap 500, `truncated`), for the «Карта» tab.
  router.get(
    '/route',
    publicReadLimit,
    validate({ query: MapRouteQuery }),
    asyncHandler(async (req, res) => {
      res.json(await routeService.route(req.query as unknown as MapRouteQueryInput));
    }),
  );

  router.get(
    '/',
    publicReadLimit,
    validate({ query: MapQuery }),
    asyncHandler(async (req, res) => {
      res.json(await service.listings(req.query as unknown as MapQueryInput));
    }),
  );

  return router;
}
