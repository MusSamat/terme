import jwt from 'jsonwebtoken';
import { env } from '@/config/env.js';
import { AppError, Errors } from '@/lib/errors.js';

export type Role = 'passenger' | 'driver' | 'admin' | 'superadmin';

// ─── Payload shapes (TZ v2.1 §7.4) ─────────────────────────────────
export interface AccessTokenPayload {
  sub: string;             // user id (UUID)
  phone: string;           // the user's verified phone
  roles: Role[];
  kind: 'access';
}

export interface RefreshTokenPayload {
  sub: string;       // user id
  tokenId: string;   // jti — maps to refresh_tokens.id
  kind: 'refresh';
}

export interface AdminAccessTokenPayload {
  sub: string;
  email: string;
  role: 'admin' | 'superadmin';
  kind: 'admin_access';
}

export interface AdminRefreshTokenPayload {
  sub: string;
  email: string;
  role: 'admin' | 'superadmin';
  ep: number;        // admins.token_epoch at issue time (M6)
  kind: 'admin_refresh';
}

export interface DecodedAccess extends AccessTokenPayload {
  iat: number;
  exp: number;
}

export interface DecodedRefresh extends RefreshTokenPayload {
  iat: number;
  exp: number;
}

export interface DecodedAdminAccess extends AdminAccessTokenPayload {
  iat: number;
  exp: number;
}

export interface DecodedAdminRefresh extends AdminRefreshTokenPayload {
  iat: number;
  exp: number;
}

const ACCESS_TTL = (): jwt.SignOptions['expiresIn'] =>
  `${env.JWT_ACCESS_TTL_MIN}m` as jwt.SignOptions['expiresIn'];

// ─── Signing ────────────────────────────────────────────────────────
export function signAccessToken(payload: Omit<AccessTokenPayload, 'kind'>): string {
  return jwt.sign({ ...payload, kind: 'access' }, env.JWT_ACCESS_SECRET, {
    algorithm: 'HS256',
    expiresIn: ACCESS_TTL(),
  });
}

export function signRefreshToken(
  payload: Omit<RefreshTokenPayload, 'kind'>,
  ttlSeconds: number,
): string {
  return jwt.sign({ ...payload, kind: 'refresh' }, env.JWT_REFRESH_SECRET, {
    algorithm: 'HS256',
    expiresIn: ttlSeconds,
  });
}

export function signAdminAccessToken(payload: Omit<AdminAccessTokenPayload, 'kind'>): string {
  return jwt.sign({ ...payload, kind: 'admin_access' }, env.JWT_ACCESS_SECRET, {
    algorithm: 'HS256',
    expiresIn: ACCESS_TTL(),
  });
}

export function signAdminRefreshToken(
  payload: Omit<AdminRefreshTokenPayload, 'kind'>,
  ttlSeconds: number,
): string {
  return jwt.sign({ ...payload, kind: 'admin_refresh' }, env.JWT_REFRESH_SECRET, {
    algorithm: 'HS256',
    expiresIn: ttlSeconds,
  });
}

// ─── Verification ───────────────────────────────────────────────────
function mapJwtError(err: unknown): AppError {
  if (err instanceof jwt.TokenExpiredError) return Errors.tokenExpired();
  if (err instanceof jwt.JsonWebTokenError) return Errors.unauthorized({ reason: 'invalid_token' });
  return Errors.unauthorized();
}

export function verifyAccessToken(token: string): DecodedAccess {
  try {
    const decoded = jwt.verify(token, env.JWT_ACCESS_SECRET, { algorithms: ['HS256'] });
    if (typeof decoded === 'string' || decoded.kind !== 'access') {
      throw Errors.unauthorized({ reason: 'wrong_token_kind' });
    }
    return decoded as DecodedAccess;
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw mapJwtError(err);
  }
}

export function verifyRefreshToken(token: string): DecodedRefresh {
  try {
    const decoded = jwt.verify(token, env.JWT_REFRESH_SECRET, { algorithms: ['HS256'] });
    if (typeof decoded === 'string' || decoded.kind !== 'refresh') {
      throw Errors.unauthorized({ reason: 'wrong_token_kind' });
    }
    return decoded as DecodedRefresh;
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw mapJwtError(err);
  }
}

export function verifyAdminAccessToken(token: string): DecodedAdminAccess {
  try {
    const decoded = jwt.verify(token, env.JWT_ACCESS_SECRET, { algorithms: ['HS256'] });
    if (typeof decoded === 'string' || decoded.kind !== 'admin_access') {
      throw Errors.unauthorized({ reason: 'wrong_token_kind' });
    }
    return decoded as DecodedAdminAccess;
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw mapJwtError(err);
  }
}

export function verifyAdminRefreshToken(token: string): DecodedAdminRefresh {
  try {
    const decoded = jwt.verify(token, env.JWT_REFRESH_SECRET, { algorithms: ['HS256'] });
    if (typeof decoded === 'string' || decoded.kind !== 'admin_refresh') {
      throw Errors.unauthorized({ reason: 'wrong_token_kind' });
    }
    return decoded as DecodedAdminRefresh;
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw mapJwtError(err);
  }
}

/**
 * TZ v2.1 §7.3 — refresh tokens have no fixed TTL and extend on activity.
 * `expires_at` on the refresh_tokens row is pushed forward to now + 30 days
 * on every /auth/refresh. The JWT itself is signed with the same horizon so
 * a stale token that hasn't been refreshed for 30d fails signature validation
 * too (belt + suspenders).
 */
export function refreshTtlSeconds(): number {
  return env.JWT_REFRESH_INACTIVITY_DAYS * 24 * 60 * 60;
}

/** M6: admin refresh tokens are short-lived (ADMIN_REFRESH_TTL_HOURS). */
export function adminRefreshTtlSeconds(): number {
  return env.ADMIN_REFRESH_TTL_HOURS * 60 * 60;
}
