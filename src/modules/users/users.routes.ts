import { Router } from 'express';
import type { PrismaClient } from '@prisma/client';
import { createUsersService } from './users.service.js';
import { createLikesService } from './likes.service.js';
import { LikesQuery, RatingsQuery, UpdateMeBody, UserIdParam } from './users.schemas.js';
import { validate } from '@/middleware/validate.js';
import { asyncHandler } from '@/middleware/errorHandler.js';
import { requireAuth } from '@/middleware/auth.js';
import { sendOtpDailyLimit, sendOtpMinuteLimit } from '@/middleware/rateLimit.js';
import { uploadMemory } from '@/lib/uploads.js';
import { webRefreshCookie } from '@/lib/cookies.js';
import { Errors } from '@/lib/errors.js';
import { createAuthService } from '@/modules/auth/auth.service.js';
import {
  ChangePasswordBody,
  ConfirmPhoneChangeBody,
  StartPhoneChangeBody,
} from '@/modules/auth/auth.schemas.js';
import type { Notifier } from '@/lib/notifier.js';

export function createUsersRouter(prisma: PrismaClient, notifier: Notifier): Router {
  const router = Router();
  const service = createUsersService(prisma);
  const likes = createLikesService(prisma);
  const auth = createAuthService(prisma, notifier);

  // Phone-change re-issues tokens — route the web refresh token into a cookie.
  router.use(webRefreshCookie());

  router.get(
    '/me',
    requireAuth,
    asyncHandler(async (req, res) => {
      const me = await service.getSelf(req.user!.id);
      res.json(me);
    }),
  );

  router.patch(
    '/me',
    requireAuth,
    validate({ body: UpdateMeBody }),
    asyncHandler(async (req, res) => {
      const updated = await service.updateSelf(
        req.user!.id,
        req.body as { name?: string; language?: 'ru' | 'kg'; termsAccepted?: true },
      );
      res.json(updated);
    }),
  );

  router.delete(
    '/me',
    requireAuth,
    asyncHandler(async (req, res) => {
      await service.deleteSelf(req.user!.id);
      res.status(204).send();
    }),
  );

  // TZ §24.4 — data portability export. Must be BEFORE /:id.
  router.get(
    '/me/export',
    requireAuth,
    asyncHandler(async (req, res) => {
      const dump = await service.exportData(req.user!.id);
      res
        .setHeader(
          'Content-Disposition',
          `attachment; filename="terme-export-${req.user!.id}.json"`,
        )
        .setHeader('Content-Type', 'application/json; charset=utf-8')
        .send(JSON.stringify(dump, null, 2));
    }),
  );

  // Liked listings («Избранное»). Must be BEFORE /:id.
  router.get(
    '/me/likes',
    requireAuth,
    validate({ query: LikesQuery }),
    asyncHandler(async (req, res) => {
      const { type, limit, cursor } = req.query as unknown as {
        type: 'trip' | 'passenger_request';
        limit: number;
        cursor?: string;
      };
      res.json(await likes.listLiked(req.user!.id, type, limit, cursor));
    }),
  );

  router.get(
    '/:id',
    validate({ params: UserIdParam }),
    asyncHandler(async (req, res) => {
      const profile = await service.getPublicProfile(req.params.id!);
      res.json(profile);
    }),
  );

  router.get(
    '/:id/ratings',
    validate({ params: UserIdParam, query: RatingsQuery }),
    asyncHandler(async (req, res) => {
      const { limit, cursor } = req.query as unknown as {
        limit: number;
        cursor?: string;
      };
      const result = await service.listRatings(req.params.id!, limit, cursor);
      res.json(result);
    }),
  );

  router.post(
    '/avatar',
    requireAuth,
    uploadMemory.single('avatar'),
    asyncHandler(async (req, res) => {
      if (!req.file) throw Errors.validation({ reason: 'missing_file', field: 'avatar' });
      const result = await service.setAvatar(req.user!.id, req.file);
      res.json(result);
    }),
  );

  router.patch(
    '/me/password',
    requireAuth,
    validate({ body: ChangePasswordBody }),
    asyncHandler(async (req, res) => {
      const { currentPassword, newPassword } = req.body as {
        currentPassword: string;
        newPassword: string;
      };
      await auth.changePassword(req.user!.id, currentPassword, newPassword);
      res.status(204).send();
    }),
  );

  // ─── Phone change: WhatsApp code to the new number ─────────────────
  router.patch(
    '/me/phone',
    requireAuth,
    sendOtpMinuteLimit,
    sendOtpDailyLimit,
    validate({ body: StartPhoneChangeBody }),
    asyncHandler(async (req, res) => {
      const { newPhone } = req.body as { newPhone: string };
      res.json(await auth.startPhoneChange(req.user!.id, newPhone));
    }),
  );

  router.patch(
    '/me/phone/confirm',
    requireAuth,
    validate({ body: ConfirmPhoneChangeBody }),
    asyncHandler(async (req, res) => {
      const { newPhone, code } = req.body as { newPhone: string; code: string };
      const ua = req.header('user-agent')?.slice(0, 300);
      const result = await auth.confirmPhoneChange(req.user!.id, newPhone, code, ua);
      res.json(result);
    }),
  );

  return router;
}
