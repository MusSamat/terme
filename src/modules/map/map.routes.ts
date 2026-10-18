import { Router } from 'express';
import type { PrismaClient } from '@prisma/client';
import { asyncHandler } from '@/middleware/errorHandler.js';
import { validate } from '@/middleware/validate.js';
import { MapQuery, type MapQueryInput } from '@/modules/cities/cities.schemas.js';
import { createMapService } from './map.service.js';

// GET /map?kind=trips|requests&bbox=w,s,e,n&zoom=12[&to_id=][&date=]
export function createMapRouter(prisma: PrismaClient): Router {
  const router = Router();
  const service = createMapService(prisma);

  router.get(
    '/',
    validate({ query: MapQuery }),
    asyncHandler(async (req, res) => {
      res.json(await service.listings(req.query as unknown as MapQueryInput));
    }),
  );

  return router;
}
