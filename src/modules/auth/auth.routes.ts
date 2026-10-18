import { Router } from 'express';
import type { PrismaClient } from '@prisma/client';
import { createAuthService } from './auth.service.js';
import {
  AdminChangePasswordBody,
  AdminLoginBody,
  AdminRefreshBody,
  CheckPhoneBody,
  LogoutBody,
  PhoneLoginBody,
  ResetPasswordBody,
  RefreshBody,
  RegisterBody,
  SendOtpBody,
  VerifyOtpBody,
} from './auth.schemas.js';
import { validate } from '@/middleware/validate.js';
import { asyncHandler } from '@/middleware/errorHandler.js';
import { requireAdmin, requireAuth } from '@/middleware/auth.js';
import {
  adminLoginLimit,
  authLimit,
  sendOtpDailyLimit,
  sendOtpMinuteLimit,
  verifyOtpLimit,
} from '@/middleware/rateLimit.js';
import type { Notifier } from '@/lib/notifier.js';
import { Errors } from '@/lib/errors.js';
import { REFRESH_COOKIE, clearRefreshCookie, readCookie, webRefreshCookie } from '@/lib/cookies.js';

// Sign-in flows (phone first, then POST /check-phone decides the next step):
//   new number      → /phone/send-otp → /register (code + name [+ password on web])
//   mobile login    → /phone/send-otp → /phone/verify
//   web login       → /phone/login (password)
//   forgot password → /phone/send-otp → /phone/reset-password
export function createAuthRouter(prisma: PrismaClient, notifier: Notifier): Router {
  const router = Router();
  const service = createAuthService(prisma, notifier);

  // For channel='web', deliver the refresh token via an HttpOnly cookie and
  // strip it from the JSON body. Mobile is untouched.
  router.use(webRefreshCookie());

  router.post(
    '/check-phone',
    authLimit,
    validate({ body: CheckPhoneBody }),
    asyncHandler(async (req, res) => {
      const { phone } = req.body as { phone: string };
      res.status(200).json(await service.checkPhone(phone));
    }),
  );

  router.post(
    '/phone/send-otp',
    sendOtpMinuteLimit,
    sendOtpDailyLimit,
    validate({ body: SendOtpBody }),
    asyncHandler(async (req, res) => {
      const { phone } = req.body as { phone: string };
      res.status(200).json(await service.sendOtp(phone));
    }),
  );

  router.post(
    '/phone/verify',
    verifyOtpLimit,
    validate({ body: VerifyOtpBody }),
    asyncHandler(async (req, res) => {
      const { phone, code, deviceInfo } = req.body as {
        phone: string;
        code: string;
        deviceInfo?: string;
      };
      const ua = req.header('user-agent')?.slice(0, 300);
      res.status(200).json(await service.verifyOtp(phone, code, deviceInfo ?? ua));
    }),
  );

  router.post(
    '/phone/login',
    authLimit,
    validate({ body: PhoneLoginBody }),
    asyncHandler(async (req, res) => {
      const { phone, password } = req.body as { phone: string; password: string };
      const ua = req.header('user-agent')?.slice(0, 300);
      res.status(200).json(await service.loginWithPassword(phone, password, ua));
    }),
  );

  router.post(
    '/phone/reset-password',
    verifyOtpLimit,
    validate({ body: ResetPasswordBody }),
    asyncHandler(async (req, res) => {
      const { phone, code, newPassword } = req.body as {
        phone: string;
        code: string;
        newPassword: string;
      };
      await service.resetPassword(phone, code, newPassword);
      res.status(204).send();
    }),
  );

  router.post(
    '/register',
    authLimit,
    validate({ body: RegisterBody }),
    asyncHandler(async (req, res) => {
      const { phone, code, name, surname, password } = req.body as {
        phone: string;
        code: string;
        name: string;
        surname: string;
        password?: string;
      };
      const result = await service.registerWithPhone(
        phone,
        code,
        name,
        surname,
        password,
        req.header('user-agent')?.slice(0, 300),
      );
      res.status(201).json(result);
    }),
  );

  // ─── Session lifecycle ────────────────────────────────────────────
  router.post(
    '/refresh',
    validate({ body: RefreshBody }),
    asyncHandler(async (req, res) => {
      const body = req.body as { refreshToken?: string; channel?: string };
      const token = body.refreshToken ?? readCookie(req, REFRESH_COOKIE.user);
      if (!token) throw Errors.unauthorized({ reason: 'missing_refresh_token' });
      const pair = await service.refresh(
        token,
        req.header('user-agent')?.slice(0, 300),
        req.ip ?? null,
      );
      res.status(200).json(pair);
    }),
  );

  router.post(
    '/logout',
    validate({ body: LogoutBody }),
    asyncHandler(async (req, res) => {
      const body = req.body as { refreshToken?: string; channel?: string };
      const token = body.refreshToken ?? readCookie(req, REFRESH_COOKIE.user);
      if (token) await service.logout(token);
      if (body.channel === 'web') clearRefreshCookie(res, REFRESH_COOKIE.user, req);
      res.status(204).send();
    }),
  );

  router.post(
    '/logout/all',
    requireAuth,
    asyncHandler(async (req, res) => {
      await service.logoutAll(req.user!.id);
      res.status(204).send();
    }),
  );

  // ─── Admin ─────────────────────────────────────────────────────────
  router.post(
    '/admin/login',
    adminLoginLimit,
    validate({ body: AdminLoginBody }),
    asyncHandler(async (req, res) => {
      const { email, password, totp } = req.body as {
        email: string;
        password: string;
        totp?: string;
      };
      res.status(200).json(await service.adminLogin(email, password, totp));
    }),
  );

  // Change-on-first-login (and voluntary) password change for admins.
  router.post(
    '/admin/change-password',
    requireAdmin,
    validate({ body: AdminChangePasswordBody }),
    asyncHandler(async (req, res) => {
      const { currentPassword, newPassword } = req.body as {
        currentPassword: string;
        newPassword: string;
      };
      await service.adminChangePassword(req.admin!.id, currentPassword, newPassword);
      res.status(204).send();
    }),
  );

  router.post(
    '/admin/refresh',
    validate({ body: AdminRefreshBody }),
    asyncHandler(async (req, res) => {
      const body = req.body as { refreshToken?: string; channel?: string };
      const token = body.refreshToken ?? readCookie(req, REFRESH_COOKIE.admin);
      if (!token) throw Errors.unauthorized({ reason: 'missing_refresh_token' });
      res.status(200).json(await service.adminRefresh(token));
    }),
  );

  return router;
}
