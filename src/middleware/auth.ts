import type { RequestHandler } from 'express';
import { verifyAccessToken, verifyAdminAccessToken, type Role } from '@/lib/jwt.js';
import { Errors } from '@/lib/errors.js';
import { getPrisma } from '@/db/prisma.js';
import { env } from '@/config/env.js';

// H2: routes reachable before TOTP enrolment (when ADMIN_TOTP_REQUIRED).
const TOTP_ENROLMENT_PATHS = ['/admin/change-password', '/admin/totp/setup', '/admin/totp/confirm'];

function extractBearer(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(\S+)$/.exec(header);
  return match ? (match[1] ?? null) : null;
}

/**
 * Strict auth — 401s when the token is missing or invalid.
 * Runs a fresh is_blocked check against users.  TZ §7.2:
 *   "NEVER put rating/is_blocked in the token — check server-side every time"
 */
export const requireAuth: RequestHandler = async (req, _res, next) => {
  try {
    const token = extractBearer(req.header('authorization'));
    if (!token) return next(Errors.unauthorized({ reason: 'no_token' }));

    const decoded = verifyAccessToken(token);
    const user = await getPrisma().user.findUnique({
      where: { id: decoded.sub },
      select: { id: true, phone: true, roles: true, isBlocked: true, deletedAt: true },
    });
    if (!user || user.deletedAt) return next(Errors.unauthorized({ reason: 'user_not_found' }));
    if (user.isBlocked) return next(Errors.forbidden({ reason: 'blocked' }));

    req.user = { id: user.id, phone: user.phone, roles: user.roles as Role[] };
    next();
  } catch (err) {
    next(err);
  }
};

/**
 * Optional auth — populates req.user when a valid access token is present, but
 * never blocks. For public routes (trip/request search & detail) that want to
 * know the viewer (e.g. "liked by me", skip owner self-views) without forcing login.
 */
export const optionalAuth: RequestHandler = async (req, _res, next) => {
  try {
    const token = extractBearer(req.header('authorization'));
    if (!token) return next();
    const decoded = verifyAccessToken(token);
    const user = await getPrisma().user.findUnique({
      where: { id: decoded.sub },
      select: { id: true, phone: true, roles: true, isBlocked: true, deletedAt: true },
    });
    if (user && !user.deletedAt && !user.isBlocked) {
      req.user = { id: user.id, phone: user.phone, roles: user.roles as Role[] };
    }
  } catch {
    // Invalid/expired token on a public route — ignore, proceed anonymously.
  }
  next();
};

/**
 * Admin auth — separate token kind.
 */
export const requireAdmin: RequestHandler = async (req, _res, next) => {
  try {
    const token = extractBearer(req.header('authorization'));
    if (!token) return next(Errors.unauthorized({ reason: 'no_token' }));

    const decoded = verifyAdminAccessToken(token);
    const admin = await getPrisma().admin.findUnique({
      where: { id: decoded.sub },
      select: {
        id: true,
        email: true,
        role: true,
        isActive: true,
        mustChangePassword: true,
        totpEnabled: true,
      },
    });
    if (!admin || !admin.isActive) {
      return next(Errors.unauthorized({ reason: 'admin_not_found_or_inactive' }));
    }

    // M3: while a forced password change is pending, the admin may ONLY reach the
    // change-password endpoint. Every other admin route is 403'd until the flag
    // clears (adminChangePassword sets mustChangePassword=false).
    if (admin.mustChangePassword && !req.path.endsWith('/admin/change-password')) {
      return next(Errors.forbidden({ reason: 'must_change_password' }));
    }
    // H2: same gating until TOTP is enrolled — only change-password and the
    // TOTP setup/confirm endpoints stay reachable.
    if (
      env.ADMIN_TOTP_REQUIRED &&
      !admin.totpEnabled &&
      !TOTP_ENROLMENT_PATHS.some((p) => req.path.endsWith(p))
    ) {
      return next(Errors.forbidden({ reason: 'totp_enrollment_required' }));
    }

    req.admin = { id: admin.id, email: admin.email, role: admin.role as 'admin' | 'superadmin' };
    next();
  } catch (err) {
    next(err);
  }
};

/**
 * Require one of the listed roles (OR semantics).
 * Must run AFTER requireAuth.
 */
export function requireRole(...roles: Role[]): RequestHandler {
  return (req, _res, next) => {
    if (!req.user) return next(Errors.unauthorized());
    const hasRole = roles.some((r) => req.user!.roles.includes(r));
    if (!hasRole) return next(Errors.forbidden({ required: roles, actual: req.user.roles }));
    next();
  };
}

export function requireAdminRole(...roles: Array<'admin' | 'superadmin'>): RequestHandler {
  return (req, _res, next) => {
    if (!req.admin) return next(Errors.unauthorized());
    if (!roles.includes(req.admin.role)) {
      return next(Errors.forbidden({ required: roles, actual: [req.admin.role] }));
    }
    next();
  };
}
