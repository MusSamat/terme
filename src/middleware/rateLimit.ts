import rateLimit, { type Options } from 'express-rate-limit';
import type { Request, RequestHandler } from 'express';

const ipKey = (req: Request): string => req.ip ?? '0.0.0.0';
import { env } from '@/config/env.js';
import { Errors } from '@/lib/errors.js';

/**
 * Rate-limit factory — produces per-endpoint middlewares matching TZ §7.3.
 *
 * Storage: in-memory (single-process MVP). TZ explicitly defers Redis to
 * Stage 2: "Без Redis в MVP · JWT stateless, кэш не нужен при нагрузке до
 * 1k DAU. Добавим на Этапе 2 для сессий чата и rate limiting."  When we move
 * to multi-instance, swap in the Redis store — the call sites don't change.
 */

type BuildOpts = Pick<Options, 'windowMs' | 'limit'> & {
  name: string;
  keyGenerator?: (req: Request) => string;
  /** Only count 2xx responses — a failed attempt (validation/conflict/500) must
   *  NOT burn the user's quota. Used on create limiters so real-world typos or
   *  transient errors don't lock someone out with nothing actually created. */
  skipFailedRequests?: boolean;
};

function build({ name, windowMs, limit, keyGenerator, skipFailedRequests }: BuildOpts): RequestHandler {
  if (env.RATE_LIMIT_DISABLED) return (_req, _res, next) => next();

  return rateLimit({
    windowMs,
    limit,
    standardHeaders: 'draft-7', // RateLimit-* headers (TZ §19.1)
    legacyHeaders: false,
    keyGenerator: keyGenerator ?? ipKey,
    ...(skipFailedRequests ? { skipFailedRequests: true } : {}),
    handler: (_req, _res, next) => {
      next(Errors.rateLimited({ bucket: name }));
    },
  });
}

// ─── IP-based ─────────────────────────────────────────────────────────
// Coarse DoS safety-net only. Kept generous on purpose: in KG many real users
// share ONE public IP via carrier-grade NAT, so a tight per-IP cap would 429
// legitimate traffic. Meaningful throttling is per-user (see below).
export const globalIpLimit = build({
  name: 'global_ip',
  windowMs: 60_000,
  limit: 300,
});

/** TZ §7.3 "POST /auth/telegram · 10 запросов в минуту на IP". */
export const telegramAuthLimit = build({
  name: 'telegram_auth',
  windowMs: 60_000,
  limit: 10,
});

/**
 * H3: strict brute-force cap on /auth/admin/login. Keyed on email+IP so one
 * attacker IP can't spray many admin emails and a distributed attack on one
 * email is also slowed. 5 attempts / 15 min. Only failed attempts count toward
 * the cap (a successful 2xx login shouldn't consume quota).
 */
const adminLoginKey = (req: Request): string => {
  const body = req.body as { email?: string } | undefined;
  const email = (body?.email ?? '').toLowerCase().slice(0, 200);
  return `${email}|${ipKey(req)}`;
};
export const adminLoginLimit = build({
  name: 'admin_login',
  windowMs: 15 * 60_000,
  limit: 5,
  keyGenerator: adminLoginKey,
  skipFailedRequests: false,
});

// ─── Phone-based (OTP) ────────────────────────────────────────────────
// Limits are enforced in the service layer against otp_codes table — this is
// a safety net in front. It keys on phone to defend across IP rotation.
const phoneKey = (req: Request): string => {
  const body = req.body as { phone?: string } | undefined;
  return body?.phone ?? ipKey(req);
};

/** TZ §7.3 "POST /auth/phone/send-otp · 1 запрос в минуту на номер". */
export const sendOtpMinuteLimit = build({
  name: 'otp_send_min',
  windowMs: 60_000,
  limit: 1,
  keyGenerator: phoneKey,
});

/** TZ §7.3 "Максимум 5 SMS в сутки на номер". */
export const sendOtpDailyLimit = build({
  name: 'otp_send_day',
  windowMs: 24 * 60 * 60_000,
  limit: 5,
  keyGenerator: phoneKey,
});

/** TZ §7.3 "POST /auth/phone/verify · 5 попыток на один OTP". */
export const verifyOtpLimit = build({
  name: 'otp_verify',
  windowMs: 15 * 60_000,
  limit: 5,
  keyGenerator: phoneKey,
});

/**
 * TZ §7.3 "POST /complaints · 3 жалобы в час на пользователя". Keyed on the
 * authenticated user id — falls back to IP if unauthenticated (which should
 * never happen in practice since /complaints requires JWT).
 */
export const complaintSubmitLimit = build({
  name: 'complaint_submit',
  windowMs: 60 * 60_000,
  limit: 3,
  keyGenerator: (req: Request) => req.user?.id ?? ipKey(req),
});

// ─── User-based write limits ──────────────────────────────────────────
// Keyed on the authenticated user id, so they MUST be mounted after
// requireAuth in the middleware chain (req.user is populated by then).
const userKey = (req: Request): string => req.user?.id ?? ipKey(req);

/** Anti-flood: successful trips per hour per driver. Failed attempts don't count. */
export const tripCreateLimit = build({
  name: 'trip_create',
  windowMs: 60 * 60_000,
  limit: 10,
  keyGenerator: userKey,
  skipFailedRequests: true,
});

/** Anti-spam: successful passenger requests per hour per user. Failed don't count. */
export const requestCreateLimit = build({
  name: 'request_create',
  windowMs: 60 * 60_000,
  limit: 20,
  keyGenerator: userKey,
  skipFailedRequests: true,
});

/** Anti-spam: successful bookings per hour per passenger. Failed don't count. */
export const bookingCreateLimit = build({
  name: 'booking_create',
  windowMs: 60 * 60_000,
  limit: 20,
  keyGenerator: userKey,
  skipFailedRequests: true,
});
