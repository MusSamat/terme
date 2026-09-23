import { Router } from 'express';
import type { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { createAuthService } from './auth.service.js';
import type { TelegramSender } from './auth.otp.js';
import {
  AdminChangePasswordBody,
  AdminLoginBody,
  AdminRefreshBody,
  AppleLoginBody,
  CheckPhoneBody,
  GoogleLoginBody,
  LogoutBody,
  PhoneLoginBody,
  RefreshBody,
  RegisterBody,
  SendOtpBody,
  TelegramLoginBody,
  VerifyOtpBody,
} from './auth.schemas.js';
import { validate } from '@/middleware/validate.js';
import { asyncHandler } from '@/middleware/errorHandler.js';
import { requireAdmin } from '@/middleware/auth.js';
import { requireAuth } from '@/middleware/auth.js';
import {
  adminLoginLimit,
  sendOtpDailyLimit,
  sendOtpMinuteLimit,
  telegramAuthLimit,
  verifyOtpLimit,
} from '@/middleware/rateLimit.js';
import { verifyAccessOrProvisional } from '@/lib/jwt.js';
import type { Notifier } from '@/lib/notifier.js';
import { Errors } from '@/lib/errors.js';
import { REFRESH_COOKIE, clearRefreshCookie, readCookie, webRefreshCookie } from '@/lib/cookies.js';

export function createAuthRouter(
  prisma: PrismaClient,
  notifier: Notifier,
  bot: TelegramSender | null = null,
): Router {
  const router = Router();
  const service = createAuthService(prisma, notifier, bot);

  // For channel='web', deliver the refresh token via an HttpOnly cookie and
  // strip it from the JSON body (TZ §5/§26.1). Mobile is untouched.
  router.use(webRefreshCookie());

  // ─── OAuth / Telegram logins ──────────────────────────────────────
  router.post(
    '/telegram',
    telegramAuthLimit,
    validate({ body: TelegramLoginBody }),
    asyncHandler(async (req, res) => {
      const { initData } = req.body as { initData: string };
      const result = await service.loginWithTelegram(
        initData,
        req.header('user-agent')?.slice(0, 300),
      );
      res.status(200).json(result);
    }),
  );

  router.post(
    '/google',
    telegramAuthLimit, // same 10/min/IP cap per TZ §7.6
    validate({ body: GoogleLoginBody }),
    asyncHandler(async (req, res) => {
      const result = await service.loginWithGoogle(
        req.body as { idToken: string },
        req.header('user-agent')?.slice(0, 300),
      );
      res.status(200).json(result);
    }),
  );

  router.post(
    '/apple',
    telegramAuthLimit,
    validate({ body: AppleLoginBody }),
    asyncHandler(async (req, res) => {
      const result = await service.loginWithApple(
        req.body as { identityToken: string },
        req.header('user-agent')?.slice(0, 300),
      );
      res.status(200).json(result);
    }),
  );

  router.post(
    '/phone/login',
    telegramAuthLimit,
    validate({ body: PhoneLoginBody }),
    asyncHandler(async (req, res) => {
      const result = await service.loginWithPhonePassword(
        req.body as { phone: string; password: string },
        req.header('user-agent')?.slice(0, 300),
      );
      res.status(200).json(result);
    }),
  );

  // ─── Classical registration (phone + Telegram OTP + profile + password) ──
  router.post(
    '/register',
    telegramAuthLimit,
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

  // ─── Phone verification (accepts provisional or unauth) ───────────
  router.post(
    '/phone/send-otp',
    sendOtpMinuteLimit,
    sendOtpDailyLimit,
    validate({ body: SendOtpBody }),
    asyncHandler(async (req, res) => {
      const { phone } = req.body as { phone: string };
      const result = await service.sendOtp(phone);
      res.status(200).json(result);
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

      // If caller holds a provisional token, bind phone to THAT user.
      // Otherwise, /verify is the phone-only registration path (find-or-create).
      const auth = req.header('authorization');
      let provisionalUserId: string | null = null;
      let provider: 'phone' | 'telegram' | 'google' | 'apple' = 'phone';
      if (auth?.startsWith('Bearer ')) {
        const res = verifyAccessOrProvisional(auth.slice(7));
        if (res.kind === 'provisional') {
          provisionalUserId = res.decoded.sub;
          provider = res.decoded.provider;
        }
      }

      const result = await service.verifyOtp(
        phone,
        code,
        provisionalUserId,
        provider,
        deviceInfo ?? ua,
      );
      res.status(200).json(result);
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

  // ─── Check phone existence + capabilities ────────────────────────────
  router.post(
    '/check-phone',
    telegramAuthLimit,
    validate({ body: CheckPhoneBody }),
    asyncHandler(async (req, res) => {
      const { phone } = req.body as { phone: string };
      res.status(200).json(await service.checkPhone(phone));
    }),
  );

  // ─── Telegram registration link (RETIRED — C1) ──────────────────────
  // This deep-link flow used to deliver the OTP to the requester's OWN Telegram
  // chat for an arbitrary phone → account takeover. OTP is now WhatsApp-only, so
  // the init/status endpoints are retired. Clients must use /auth/phone/send-otp
  // (WhatsApp) or the request_contact registration flow instead. Kept as 410 so
  // stale clients get a clear signal rather than a silent dead deep-link.
  router.post(
    '/telegram/link/init',
    asyncHandler(async (_req, _res) => {
      throw Errors.serviceUnavailable('telegram_link_flow_retired');
    }),
  );

  router.get(
    '/telegram/link/status',
    asyncHandler(async (_req, _res) => {
      throw Errors.serviceUnavailable('telegram_link_flow_retired');
    }),
  );

  // ─── Telegram bot magic-link login ───────────────────────────────────
  router.post(
    '/telegram/bot-login/init',
    telegramAuthLimit,
    asyncHandler(async (_req, res) => {
      res.status(200).json(await service.initBotLogin());
    }),
  );

  router.get(
    '/telegram/bot-login/status',
    validate({ query: z.object({ token: z.string().min(1).max(100) }) }),
    asyncHandler(async (req, res) => {
      const { token } = req.query as { token: string };
      res.status(200).json(await service.getBotLoginStatus(token));
    }),
  );

  router.post(
    '/telegram/bot-login/claim',
    telegramAuthLimit,
    validate({ body: z.object({ token: z.string().min(1).max(100) }) }),
    asyncHandler(async (req, res) => {
      const { token } = req.body as { token: string };
      const deviceInfo = req.headers['user-agent'];
      res.status(200).json(await service.claimBotLogin(token, deviceInfo));
    }),
  );

  // ─── Telegram Bot OTP (login without password / forgot password) ─────
  router.post(
    '/telegram/otp/send',
    sendOtpMinuteLimit,
    sendOtpDailyLimit,
    validate({ body: SendOtpBody }),
    asyncHandler(async (req, res) => {
      const { phone } = req.body as { phone: string };
      res.status(200).json(await service.sendTelegramOtp(phone));
    }),
  );

  // ─── Password reset (post-OTP flow — no current password required) ─
  // M2: requires a FRESH OTP proof (phone + code) in addition to the access
  // token. The code must be for the caller's own verified number; it is consumed
  // single-use with ≤10 min freshness, and all other sessions are revoked.
  router.post(
    '/phone/reset-password',
    requireAuth,
    verifyOtpLimit,
    validate({
      body: z.object({
        phone: z.string().min(5).max(20),
        code: z.string().min(4).max(8),
        newPassword: z.string().min(6).max(128),
      }),
    }),
    asyncHandler(async (req, res) => {
      const { phone, code, newPassword } = req.body as {
        phone: string;
        code: string;
        newPassword: string;
      };
      // resetPassword's phone/code proof params are optional in the AuthService
      // interface (kept 2-arg-assignable), so widen the type here to pass them.
      await (
        service.resetPassword as (
          userId: string,
          newPassword: string,
          phone?: string,
          code?: string,
        ) => Promise<void>
      )(req.user!.id, newPassword, phone, code);
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
      const result = await service.adminLogin(email, password, totp);
      res.status(200).json(result);
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

  // Export the shared service factory so sibling modules (e.g. users) can
  // reach the password / phone / provider flows without duplicating wiring.
  (router as unknown as { _authService?: ReturnType<typeof createAuthService> })._authService =
    service;
  void Errors; // keep import for asyncHandler guards used elsewhere
  return router;
}
