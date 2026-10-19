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
  const limiter = rateLimit({
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
  // Checked per request (not at build time) so tests can switch limits on.
  return (req, res, next) => (env.RATE_LIMIT_DISABLED ? next() : limiter(req, res, next));
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

/** Login / registration endpoints: 10 requests per minute per IP. */
export const authLimit = build({
  name: 'auth',
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
// Keyed on the number the code goes to (phone change sends it to newPhone).
const phoneKey = (req: Request): string => {
  const body = req.body as { phone?: string; newPhone?: string } | undefined;
  return body?.newPhone ?? body?.phone ?? ipKey(req);
};
// M5: daily / verify caps key on (phone, ip) so a stranger can't lock a
// victim's number out; the DB layer still enforces a per-phone ceiling.
const phoneIpKey = (req: Request): string => `${phoneKey(req)}|${ipKey(req)}`;

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
  keyGenerator: phoneIpKey,
});

/** H1: per-IP caps on every OTP send (send-otp, phone change) — cost guard. */
export const sendOtpIpHourLimit = build({
  name: 'otp_send_ip_hour',
  windowMs: 60 * 60_000,
  limit: env.OTP_IP_HOURLY_CAP,
});

export const sendOtpIpDailyLimit = build({
  name: 'otp_send_ip_day',
  windowMs: 24 * 60 * 60_000,
  limit: env.OTP_IP_DAILY_CAP,
});

/** All OTP-send limiters in mount order. */
export const sendOtpLimits: RequestHandler[] = [
  sendOtpIpHourLimit,
  sendOtpIpDailyLimit,
  sendOtpMinuteLimit,
  sendOtpDailyLimit,
];

/** TZ §7.3 "POST /auth/phone/verify · 5 попыток на один OTP". */
export const verifyOtpLimit = build({
  name: 'otp_verify',
  windowMs: 15 * 60_000,
  limit: 5,
  keyGenerator: phoneIpKey,
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

/** M4: per-IP cap on phone reveals (the per-user cap lives in contacts.service). */
export const contactIpLimit = build({
  name: 'contact_ip',
  windowMs: 60 * 60_000,
  limit: 100,
});

// ─── Read / misc write paths ──────────────────────────────────────────

/** M7: REST chat send — same budget as the socket (20/min per user). */
export const chatSendLimit = build({
  name: 'chat_send',
  windowMs: 60_000,
  limit: 20,
  keyGenerator: userKey,
});

/** M7: all multipart uploads (avatar, verification, car photo) per user. */
export const uploadLimit = build({
  name: 'upload',
  windowMs: 60 * 60_000,
  limit: 30,
  keyGenerator: userKey,
});

/** Data export / account delete — rare, expensive, per user. */
export const accountDataLimit = build({
  name: 'account_data',
  windowMs: 60 * 60_000,
  limit: 5,
  keyGenerator: userKey,
});

/** M9: check-phone answers «does this number have an account» — daily per IP. */
export const checkPhoneDailyLimit = build({
  name: 'check_phone_day',
  windowMs: 24 * 60 * 60_000,
  limit: () => env.CHECK_PHONE_IP_DAILY_CAP,
});

/** Anonymous view-counter inflation brake (POST /…/:id/view) per IP. */
export const viewIpLimit = build({
  name: 'view_ip',
  windowMs: 60_000,
  limit: 60,
});

/**
 * Public reads (search, lists, profiles, map, city search): generous for
 * humans, stops scrapers. Per user when authenticated (mount after
 * optionalAuth), per IP otherwise.
 */
export const publicReadLimit = build({
  name: 'public_read',
  windowMs: 60_000,
  limit: (req: Request) => (req.user ? env.PUBLIC_READ_USER_PER_MIN : env.PUBLIC_READ_IP_PER_MIN),
  keyGenerator: (req: Request) => (req.user ? `u:${req.user.id}` : `ip:${ipKey(req)}`),
});
