import type { PrismaClient } from '@prisma/client';
import { authenticator } from 'otplib';
import { env } from '@/config/env.js';
import { Errors } from '@/lib/errors.js';
import * as password from '@/lib/bcrypt.js';
import { signAdminAccessToken, signAdminRefreshToken, refreshTtlSeconds } from '@/lib/jwt.js';
import type { AdminAuthResult } from './auth.types.js';
import { DUMMY_BCRYPT_HASH_COST12 } from './auth.constants.js';

// H3: in-memory admin-login lockout. After ADMIN_LOGIN_MAX_FAILS failed attempts
// (bad password OR bad TOTP) for an email, further attempts are rejected for
// ADMIN_LOCK_MS regardless of credentials. Single-process MVP (matches the
// in-memory rate limiter). Cleared on a successful login.
const ADMIN_LOGIN_MAX_FAILS = 5;
const ADMIN_LOCK_MS = 15 * 60_000;
const adminLoginFails = new Map<string, { count: number; firstAt: number; lockedUntil: number }>();

function adminLockState(email: string): { count: number; firstAt: number; lockedUntil: number } {
  const now = Date.now();
  const cur = adminLoginFails.get(email);
  if (!cur) return { count: 0, firstAt: now, lockedUntil: 0 };
  // Reset the window once the lock (or the counting window) has elapsed.
  if (cur.lockedUntil && now >= cur.lockedUntil) {
    adminLoginFails.delete(email);
    return { count: 0, firstAt: now, lockedUntil: 0 };
  }
  if (!cur.lockedUntil && now - cur.firstAt >= ADMIN_LOCK_MS) {
    adminLoginFails.delete(email);
    return { count: 0, firstAt: now, lockedUntil: 0 };
  }
  return cur;
}

function recordAdminFail(email: string): void {
  const s = adminLockState(email);
  const count = s.count + 1;
  const lockedUntil = count >= ADMIN_LOGIN_MAX_FAILS ? Date.now() + ADMIN_LOCK_MS : 0;
  adminLoginFails.set(email, { count, firstAt: s.firstAt, lockedUntil });
}

export function createAdminAuthMethods(prisma: PrismaClient) {
  async function adminLogin(
    email: string,
    plainPassword: string,
    totp?: string,
  ): Promise<AdminAuthResult> {
    const normalizedEmail = email.toLowerCase();
    // H3: reject early while locked out, without touching the DB or bcrypt.
    if (adminLockState(normalizedEmail).lockedUntil > Date.now()) {
      throw Errors.rateLimited({ bucket: 'admin_login', reason: 'locked_out' });
    }
    const admin = await prisma.admin.findUnique({ where: { email: normalizedEmail } });
    // L1: cost-12 dummy hash so unknown-email timing matches a real verify.
    const compareAgainst = admin?.passwordHash ?? DUMMY_BCRYPT_HASH_COST12;
    const passwordOk = await password.verify(plainPassword, compareAgainst);
    if (!admin || !passwordOk || !admin.isActive) {
      recordAdminFail(normalizedEmail);
      throw Errors.unauthorized({ reason: 'admin_credentials' });
    }
    if (admin.totpEnabled) {
      if (!admin.totpSecret) throw Errors.internal('TOTP misconfigured');
      if (!totp) throw Errors.unauthorized({ reason: 'totp_required' });
      const ok = authenticator.verify({ token: totp, secret: admin.totpSecret });
      if (!ok) {
        recordAdminFail(normalizedEmail);
        throw Errors.unauthorized({ reason: 'totp_invalid' });
      }
    }
    adminLoginFails.delete(normalizedEmail);
    await prisma.admin.update({ where: { id: admin.id }, data: { lastLoginAt: new Date() } });
    const adminRole = admin.role as 'admin' | 'superadmin';
    const tokenPayload = { sub: admin.id, email: admin.email, role: adminRole };
    const accessToken = signAdminAccessToken(tokenPayload);
    const refreshTtl = refreshTtlSeconds();
    const refreshToken = signAdminRefreshToken(tokenPayload, refreshTtl);
    return {
      accessToken,
      refreshToken,
      accessTokenExpiresIn: env.JWT_ACCESS_TTL_MIN * 60,
      refreshTokenExpiresIn: refreshTtl,
      admin: {
        id: admin.id,
        email: admin.email,
        name: admin.name,
        role: adminRole,
        mustChangePassword: admin.mustChangePassword,
      },
    };
  }

  async function adminChangePassword(
    adminId: string,
    currentPassword: string,
    newPassword: string,
  ): Promise<void> {
    const admin = await prisma.admin.findUnique({ where: { id: adminId } });
    if (!admin || !admin.isActive) throw Errors.unauthorized({ reason: 'admin_credentials' });
    const ok = await password.verify(currentPassword, admin.passwordHash);
    if (!ok) throw Errors.unauthorized({ reason: 'admin_credentials' });
    // M1: this update bumps `updated_at` (@updatedAt). adminRefresh rejects any
    // admin refresh token whose `iat` predates updated_at, so changing the
    // password revokes ALL outstanding admin refresh tokens (no per-token store).
    await prisma.admin.update({
      where: { id: adminId },
      data: { passwordHash: await password.hash(newPassword), mustChangePassword: false },
    });
  }

  return { adminLogin, adminChangePassword };
}
