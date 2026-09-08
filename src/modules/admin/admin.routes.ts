import { Router } from 'express';
import type { PrismaClient } from '@prisma/client';
import { requireAdmin, requireAdminRole } from '@/middleware/auth.js';
import { validate } from '@/middleware/validate.js';
import { asyncHandler } from '@/middleware/errorHandler.js';
import {
  AdminCreateBody,
  AuditLogQuery,
  BlockBody,
  ChartNameParam,
  CarBrandCreateBody,
  CarBrandUpdateBody,
  CarColorCreateBody,
  CarColorUpdateBody,
  CarModelCreateBody,
  CarModelsQuery,
  CarModelUpdateBody,
  CityCreateBody,
  CityIdParam,
  CityUpdateBody,
  SmallIntIdParam,
  ComplaintResolveBody,
  ComplaintsAdminQuery,
  ForceCancelBody,
  IdParam,
  RejectBody,
  RequestDocsBody,
  RequestsAdminQuery,
  type RequestsAdminQueryInput,
  TripIdParam,
  TripsAdminQuery,
  type TripsAdminQueryInput,
  UsersQuery,
  VerificationsQuery,
} from './admin.schemas.js';
import { createAdminVerificationsService } from './adminVerifications.service.js';
import { createAdminUsersService } from './adminUsers.service.js';
import { createAdminCitiesService } from './adminCities.service.js';
import { createAdminAdminsService } from './adminAdmins.service.js';
import { createAdminComplaintsService } from './adminComplaints.service.js';
import { createAdminTripsService } from './adminTrips.service.js';
import { createAdminRequestsService } from './adminRequests.service.js';
import { createAdminAnalyticsService } from './adminAnalytics.service.js';
import { createAdminCarCatalogService } from './adminCarCatalog.service.js';
import { cursorArgs, sliceAndNext } from '@/lib/pagination.js';
import type { Notifier } from '@/lib/notifier.js';
import type { CarCatalogService } from '@/modules/cars/carCatalog.service.js';
import { createWhatsappAdminRouter } from '@/modules/whatsapp/whatsapp.admin.routes.js';

export function createAdminRouter(
  prisma: PrismaClient,
  notifier: Notifier,
  catalog: CarCatalogService,
): Router {
  const router = Router();
  router.use(requireAdmin);

  // WhatsApp inbox admin API → /v1/admin/whatsapp/*
  router.use('/whatsapp', createWhatsappAdminRouter(prisma));

  const verif = createAdminVerificationsService(prisma, notifier);
  const users = createAdminUsersService(prisma, notifier);
  const cities = createAdminCitiesService(prisma);
  const admins = createAdminAdminsService(prisma);
  const complaints = createAdminComplaintsService(prisma);
  const tripsOps = createAdminTripsService(prisma, notifier);
  const requestsOps = createAdminRequestsService(prisma);
  const analytics = createAdminAnalyticsService(prisma);
  const carCatalog = createAdminCarCatalogService(prisma, catalog);

  // ─── Verifications ────────────────────────────────────────────────────
  router.get(
    '/verifications',
    validate({ query: VerificationsQuery }),
    asyncHandler(async (req, res) => {
      const result = await verif.listQueue(
        req.query as unknown as Parameters<typeof verif.listQueue>[0],
      );
      res.json(result);
    }),
  );

  router.get(
    '/verifications/:id',
    validate({ params: IdParam }),
    asyncHandler(async (req, res) => {
      const detail = await verif.getDetail(req.params.id!);
      res.json(detail);
    }),
  );

  router.patch(
    '/verifications/:id/approve',
    validate({ params: IdParam }),
    asyncHandler(async (req, res) => {
      const detail = await verif.approve(req.params.id!, req.admin!.id, req.ip ?? null);
      res.json(detail);
    }),
  );

  router.patch(
    '/verifications/:id/reject',
    validate({ params: IdParam, body: RejectBody }),
    asyncHandler(async (req, res) => {
      const { reason } = req.body as { reason: string };
      const detail = await verif.reject(req.params.id!, req.admin!.id, reason, req.ip ?? null);
      res.json(detail);
    }),
  );

  router.patch(
    '/verifications/:id/request-docs',
    validate({ params: IdParam, body: RequestDocsBody }),
    asyncHandler(async (req, res) => {
      const { docs, note } = req.body as {
        docs: string[];
        note?: string;
      };
      const detail = await verif.requestDocs(
        req.params.id!,
        req.admin!.id,
        docs,
        note,
        req.ip ?? null,
      );
      res.json(detail);
    }),
  );

  // ─── Users ────────────────────────────────────────────────────────────
  router.get(
    '/users',
    validate({ query: UsersQuery }),
    asyncHandler(async (req, res) => {
      const result = await users.list(
        req.query as unknown as Parameters<typeof users.list>[0],
      );
      res.json(result);
    }),
  );

  router.get(
    '/users/:id',
    validate({ params: IdParam }),
    asyncHandler(async (req, res) => {
      const detail = await users.get(req.params.id!);
      res.json(detail);
    }),
  );

  router.patch(
    '/users/:id/block',
    validate({ params: IdParam, body: BlockBody }),
    asyncHandler(async (req, res) => {
      const { reason } = req.body as { reason: string };
      const detail = await users.block(req.params.id!, req.admin!.id, reason, req.ip ?? null);
      res.json(detail);
    }),
  );

  router.patch(
    '/users/:id/unblock',
    validate({ params: IdParam }),
    asyncHandler(async (req, res) => {
      const detail = await users.unblock(req.params.id!, req.admin!.id, req.ip ?? null);
      res.json(detail);
    }),
  );

  // ─── Cities (superadmin write) ────────────────────────────────────────
  router.get(
    '/cities',
    asyncHandler(async (_req, res) => {
      res.json({ data: await cities.list() });
    }),
  );

  router.post(
    '/cities',
    requireAdminRole('superadmin'),
    validate({ body: CityCreateBody }),
    asyncHandler(async (req, res) => {
      const created = await cities.create(
        req.body as Parameters<typeof cities.create>[0],
        req.admin!.id,
        req.ip ?? null,
      );
      res.status(201).json(created);
    }),
  );

  router.patch(
    '/cities/:id',
    requireAdminRole('superadmin'),
    validate({ params: CityIdParam, body: CityUpdateBody }),
    asyncHandler(async (req, res) => {
      const updated = await cities.update(
        Number(req.params.id),
        req.body as Parameters<typeof cities.update>[1],
        req.admin!.id,
        req.ip ?? null,
      );
      res.json(updated);
    }),
  );

  // ─── Car catalog: brands (superadmin write) ──────────────────────────
  router.get(
    '/car-brands',
    asyncHandler(async (_req, res) => {
      res.json({ data: await carCatalog.listBrands() });
    }),
  );
  router.post(
    '/car-brands',
    requireAdminRole('superadmin'),
    validate({ body: CarBrandCreateBody }),
    asyncHandler(async (req, res) => {
      const created = await carCatalog.createBrand(
        req.body as Parameters<typeof carCatalog.createBrand>[0],
        req.admin!.id,
        req.ip ?? null,
      );
      res.status(201).json(created);
    }),
  );
  router.patch(
    '/car-brands/:id',
    requireAdminRole('superadmin'),
    validate({ params: SmallIntIdParam, body: CarBrandUpdateBody }),
    asyncHandler(async (req, res) => {
      const updated = await carCatalog.updateBrand(
        Number(req.params.id),
        req.body as Parameters<typeof carCatalog.updateBrand>[1],
        req.admin!.id,
        req.ip ?? null,
      );
      res.json(updated);
    }),
  );
  router.delete(
    '/car-brands/:id',
    requireAdminRole('superadmin'),
    validate({ params: SmallIntIdParam }),
    asyncHandler(async (req, res) => {
      const deleted = await carCatalog.deleteBrand(Number(req.params.id), req.admin!.id, req.ip ?? null);
      res.json(deleted);
    }),
  );

  // ─── Car catalog: models (superadmin write) ──────────────────────────
  router.get(
    '/car-models',
    validate({ query: CarModelsQuery }),
    asyncHandler(async (req, res) => {
      const brandId = req.query.brandId !== undefined ? Number(req.query.brandId) : undefined;
      res.json({ data: await carCatalog.listModels(brandId) });
    }),
  );
  router.post(
    '/car-models',
    requireAdminRole('superadmin'),
    validate({ body: CarModelCreateBody }),
    asyncHandler(async (req, res) => {
      const created = await carCatalog.createModel(
        req.body as Parameters<typeof carCatalog.createModel>[0],
        req.admin!.id,
        req.ip ?? null,
      );
      res.status(201).json(created);
    }),
  );
  router.patch(
    '/car-models/:id',
    requireAdminRole('superadmin'),
    validate({ params: SmallIntIdParam, body: CarModelUpdateBody }),
    asyncHandler(async (req, res) => {
      const updated = await carCatalog.updateModel(
        Number(req.params.id),
        req.body as Parameters<typeof carCatalog.updateModel>[1],
        req.admin!.id,
        req.ip ?? null,
      );
      res.json(updated);
    }),
  );
  router.delete(
    '/car-models/:id',
    requireAdminRole('superadmin'),
    validate({ params: SmallIntIdParam }),
    asyncHandler(async (req, res) => {
      const deleted = await carCatalog.deleteModel(Number(req.params.id), req.admin!.id, req.ip ?? null);
      res.json(deleted);
    }),
  );

  // ─── Car catalog: colors (superadmin write) ──────────────────────────
  router.get(
    '/car-colors',
    asyncHandler(async (_req, res) => {
      res.json({ data: await carCatalog.listColors() });
    }),
  );
  router.post(
    '/car-colors',
    requireAdminRole('superadmin'),
    validate({ body: CarColorCreateBody }),
    asyncHandler(async (req, res) => {
      const created = await carCatalog.createColor(
        req.body as Parameters<typeof carCatalog.createColor>[0],
        req.admin!.id,
        req.ip ?? null,
      );
      res.status(201).json(created);
    }),
  );
  router.patch(
    '/car-colors/:id',
    requireAdminRole('superadmin'),
    validate({ params: SmallIntIdParam, body: CarColorUpdateBody }),
    asyncHandler(async (req, res) => {
      const updated = await carCatalog.updateColor(
        Number(req.params.id),
        req.body as Parameters<typeof carCatalog.updateColor>[1],
        req.admin!.id,
        req.ip ?? null,
      );
      res.json(updated);
    }),
  );
  router.delete(
    '/car-colors/:id',
    requireAdminRole('superadmin'),
    validate({ params: SmallIntIdParam }),
    asyncHandler(async (req, res) => {
      const deleted = await carCatalog.deleteColor(Number(req.params.id), req.admin!.id, req.ip ?? null);
      res.json(deleted);
    }),
  );

  // ─── Admins (superadmin only) ─────────────────────────────────────────
  router.get(
    '/admins',
    requireAdminRole('superadmin'),
    asyncHandler(async (_req, res) => {
      res.json({ data: await admins.list() });
    }),
  );

  router.post(
    '/admins',
    requireAdminRole('superadmin'),
    validate({ body: AdminCreateBody }),
    asyncHandler(async (req, res) => {
      const created = await admins.create(
        req.body as Parameters<typeof admins.create>[0],
        req.admin!.id,
        req.ip ?? null,
      );
      res.status(201).json(created);
    }),
  );

  // ─── Complaints ──────────────────────────────────────────────────────
  router.get(
    '/complaints',
    validate({ query: ComplaintsAdminQuery }),
    asyncHandler(async (req, res) => {
      const q = req.query as unknown as Parameters<typeof complaints.list>[0];
      res.json(await complaints.list(q));
    }),
  );

  router.get(
    '/complaints/:id',
    validate({ params: IdParam }),
    asyncHandler(async (req, res) => {
      res.json(await complaints.get(req.params.id!));
    }),
  );

  router.patch(
    '/complaints/:id/resolve',
    validate({ params: IdParam, body: ComplaintResolveBody }),
    asyncHandler(async (req, res) => {
      const body = req.body as { status: 'resolved' | 'dismissed'; resolution: string };
      res.json(
        await complaints.resolve(req.params.id!, req.admin!.id, body, req.ip ?? null),
      );
    }),
  );

  // ─── Trips list + detail ─────────────────────────────────────────────
  router.get(
    '/trips',
    validate({ query: TripsAdminQuery }),
    asyncHandler(async (req, res) => {
      const q = req.query as unknown as TripsAdminQueryInput;
      res.json(await tripsOps.listTrips(q));
    }),
  );

  router.get(
    '/trips/:id',
    validate({ params: TripIdParam }),
    asyncHandler(async (req, res) => {
      res.json(await tripsOps.getTripDetail(req.params.id!));
    }),
  );

  // ─── Force-cancel trip ───────────────────────────────────────────────
  router.patch(
    '/trips/:id/cancel',
    validate({ params: IdParam, body: ForceCancelBody }),
    asyncHandler(async (req, res) => {
      const { reason } = req.body as { reason: string };
      res.json(
        await tripsOps.forceCancel(req.params.id!, req.admin!.id, reason, req.ip ?? null),
      );
    }),
  );

  // ─── Passenger requests list + detail + force-cancel ─────────────────
  router.get(
    '/requests',
    validate({ query: RequestsAdminQuery }),
    asyncHandler(async (req, res) => {
      const q = req.query as unknown as RequestsAdminQueryInput;
      res.json(await requestsOps.listRequests(q));
    }),
  );
  router.get(
    '/requests/:id',
    validate({ params: IdParam }),
    asyncHandler(async (req, res) => {
      res.json(await requestsOps.getRequestDetail(req.params.id!));
    }),
  );
  router.patch(
    '/requests/:id/cancel',
    validate({ params: IdParam, body: ForceCancelBody }),
    asyncHandler(async (req, res) => {
      const { reason } = req.body as { reason: string };
      res.json(await requestsOps.forceCancel(req.params.id!, req.admin!.id, reason, req.ip ?? null));
    }),
  );

  // ─── Analytics ───────────────────────────────────────────────────────
  router.get(
    '/analytics/kpi',
    asyncHandler(async (_req, res) => {
      res.json(await analytics.kpi());
    }),
  );

  router.get(
    '/analytics/charts/:name',
    validate({ params: ChartNameParam }),
    asyncHandler(async (req, res) => {
      const days = Number(req.query.days);
      res.json(await analytics.chart(req.params.name!, isNaN(days) ? 30 : days));
    }),
  );

  // ─── Audit log ────────────────────────────────────────────────────────
  router.get(
    '/audit-log',
    validate({ query: AuditLogQuery }),
    asyncHandler(async (req, res) => {
      const q = req.query as unknown as {
        adminId?: string;
        action?: string;
        cursor?: string;
        limit: number;
      };
      // TZ §6.3: admin sees only their own actions; superadmin sees all.
      const effectiveAdminId =
        req.admin!.role === 'superadmin' ? q.adminId : req.admin!.id;

      const rows = await prisma.adminAction.findMany({
        where: {
          ...(effectiveAdminId ? { adminId: effectiveAdminId } : {}),
          ...(q.action ? { action: q.action } : {}),
        },
        orderBy: { createdAt: 'desc' },
        ...cursorArgs(q),
        include: {
          admin: { select: { id: true, email: true, name: true, role: true } },
        },
      });
      res.json(sliceAndNext(rows, q.limit));
    }),
  );

  return router;
}
