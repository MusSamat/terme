import { Router } from 'express';
import { z } from 'zod';
import type { PrismaClient } from '@prisma/client';
import { createCarsService } from './cars.service.js';
import { createCarCatalogService, type CarCatalogService } from './carCatalog.service.js';
import { CarCreateBody, CarIdParam } from './cars.schemas.js';
import { validate } from '@/middleware/validate.js';
import { asyncHandler } from '@/middleware/errorHandler.js';
import { requireAuth } from '@/middleware/auth.js';

export function createCarsRouter(prisma: PrismaClient, catalog?: CarCatalogService): Router {
  const router = Router();
  const service = createCarsService(prisma);
  const catalogSvc = catalog ?? createCarCatalogService(prisma);

  // ─── Car catalog (public reference data — no auth) ───────────────────
  // Defined before '/:id' so the literal paths win. Cached in memory.
  router.get(
    '/catalog/brands',
    asyncHandler(async (_req, res) => {
      res.json({ data: await catalogSvc.listBrands() });
    }),
  );
  router.get(
    '/catalog/brands/:id/models',
    validate({ params: z.object({ id: z.coerce.number().int().positive() }) }),
    asyncHandler(async (req, res) => {
      res.json({ data: await catalogSvc.listModels(Number(req.params.id)) });
    }),
  );
  router.get(
    '/catalog/colors',
    asyncHandler(async (_req, res) => {
      res.json({ data: await catalogSvc.listColors() });
    }),
  );

  // GET /cars — the authed user's garage
  router.get(
    '/',
    requireAuth,
    asyncHandler(async (req, res) => {
      res.json({ data: await service.listMy(req.user!.id) });
    }),
  );

  // POST /cars — add a car (no verification required; Phase 1)
  router.post(
    '/',
    requireAuth,
    validate({ body: CarCreateBody }),
    asyncHandler(async (req, res) => {
      const car = await service.create(req.user!.id, req.body as Parameters<typeof service.create>[1]);
      res.status(201).json(car);
    }),
  );

  // DELETE /cars/:id — soft delete (blocked while active trips ride on it)
  router.delete(
    '/:id',
    requireAuth,
    validate({ params: CarIdParam }),
    asyncHandler(async (req, res) => {
      await service.remove(req.user!.id, req.params.id!);
      res.status(204).end();
    }),
  );

  return router;
}
