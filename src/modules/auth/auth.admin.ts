import type { Admin, PrismaClient } from '@prisma/client';
import { env } from '@/config/env.js';
import { Errors } from '@/lib/errors.js';
import { logger } from '@/lib/logger.js';
import * as password from '@/lib/bcrypt.js';
import { encryptSecret, decryptSecret } from '@/lib/secretBox.js';
import {
  signAdminAccessToken,
  signAdminRefreshToken,
  adminRefreshTtlSeconds,
  verifyAdminRefreshToken,
} from '@/lib/jwt.js';
import { writeAdminAction } from '@/modules/admin/admin.audit.js';
import type { AdminAuthResult } from './auth.types.js';
import { DUMMY_BCRYPT_HASH_COST12 } from './auth.constants.js';
import {
  activeTotpSecret,
  consumeTotp,
  generateTotpSecret,
  matchTotpStep,
  totpKeyUri,
} from './auth.totp.js';

// H3/M6: in-memory admin-login lockout keyed on email+IP. After
// ADMIN_LOGIN_MAX_FAILS failed attempts (bad password OR bad/missing TOTP) from
// one IP for an email, that pair is locked for ADMIN_LOCK_MS. Keying on the
// pair means a stranger can't lock the real admin out from elsewhere; the
// email-only counter is a soft signal (alert, never a lock). Single-process MVP.
const ADMIN_LOGIN_MAX_FAILS = 5;
const ADMIN_LOCK_MS = 15 * 60_000;
const ADMIN_EMAIL_ALERT_FAILS = 20;

interface FailState {
  count: number;
  firstAt: number;
  lockedUntil: number;
}
const adminLoginFails = new Map<string, FailState>();
const adminEmailFails = new Map<string, FailState>();

function lockState(map: Map<string, FailState>, key: string): FailState {
  const now = Date.now();
  const cur = map.get(key);
  if (!cur) return { count: 0, firstAt: now, lockedUntil: 0 };
  // Reset once the lock (or the counting window) has elapsed.
  const expired = cur.lockedUntil
    ? now >= cur.lockedUntil
    : now - cur.firstAt >= ADMIN_LOCK_MS;
  if (expired) {
    map.delete(key);
    return { count: 0, firstAt: now, lockedUntil: 0 };
  }
  return cur;
}

function recordAdminFail(email: string, ip: string): void {
  const pairKey = `${email}|${ip}`;
  const s = lockState(adminLoginFails, pairKey);
  const count = s.count + 1;
  const lockedUntil = count >= ADMIN_LOGIN_MAX_FAILS ? Date.now() + ADMIN_LOCK_MS : 0;
  adminLoginFails.set(pairKey, { count, firstAt: s.firstAt, lockedUntil });

  const e = lockState(adminEmailFails, email);
  const emailCount = e.count + 1;
  adminEmailFails.set(email, { count: emailCount, firstAt: e.firstAt, lockedUntil: 0 });
  if (emailCount === ADMIN_EMAIL_ALERT_FAILS) {
    logger.error(
      { event: 'admin.login_spray', email, fails: emailCount, windowMin: ADMIN_LOCK_MS / 60_000 },
      'ALERT: many failed admin logins for one email from several IPs',
    );
  }
}

function adminView(admin: Admin): AdminAuthResult['admin'] {
  return {
    id: admin.id,
    email: admin.email,
    name: admin.name,
    role: admin.role as 'admin' | 'superadmin',
    mustChangePassword: admin.mustChangePassword,
    totpEnabled: admin.totpEnabled,
    totpEnrollmentRequired: env.ADMIN_TOTP_REQUIRED && !admin.totpEnabled,
  };
}

function issueAdminTokens(admin: Admin): AdminAuthResult {
  const role = admin.role as 'admin' | 'superadmin';
  const payload = { sub: admin.id, email: admin.email, role };
  const refreshTtl = adminRefreshTtlSeconds();
  return {
    accessToken: signAdminAccessToken(payload),
    refreshToken: signAdminRefreshToken({ ...payload, ep: admin.tokenEpoch }, refreshTtl),
    accessTokenExpiresIn: env.JWT_ACCESS_TTL_MIN * 60,
    refreshTokenExpiresIn: refreshTtl,
    admin: adminView(admin),
  };
}

const TOTP_RESET = {
  totpEnabled: false,
  totpSecret: null,
  totpSecretEnc: null,
  totpPendingEnc: null,
  totpLastStep: null,
  tokenEpoch: { increment: 1 },
} as const;

export function createAdminAuthMethods(prisma: PrismaClient) {
  async function loadActive(adminId: string): Promise<Admin> {
    const admin = await prisma.admin.findUnique({ where: { id: adminId } });
    if (!admin || !admin.isActive) throw Errors.unauthorized({ reason: 'admin_credentials' });
    return admin;
  }

  async function adminLogin(
    email: string,
    plainPassword: string,
    totp: string | undefined,
    ip: string,
  ): Promise<AdminAuthResult> {
    const normalizedEmail = email.toLowerCase();
    // Reject early while locked out, without touching the DB or bcrypt.
    if (lockState(adminLoginFails, `${normalizedEmail}|${ip}`).lockedUntil > Date.now()) {
      throw Errors.rateLimited({ bucket: 'admin_login', reason: 'locked_out' });
    }
    const admin = await prisma.admin.findUnique({ where: { email: normalizedEmail } });
    // L1: cost-12 dummy hash so unknown-email timing matches a real verify.
    const compareAgainst = admin?.passwordHash ?? DUMMY_BCRYPT_HASH_COST12;
    const passwordOk = await password.verify(plainPassword, compareAgainst);
    if (!admin || !passwordOk || !admin.isActive) {
      recordAdminFail(normalizedEmail, ip);
      throw Errors.unauthorized({ reason: 'admin_credentials' });
    }
    if (admin.totpEnabled) {
      const secret = activeTotpSecret(admin);
      if (!secret) throw Errors.internal('TOTP misconfigured');
      // H2: a missing or wrong code gets the SAME generic answer as a wrong
      // password (and counts as a failure) — the response never confirms that
      // the password was right.
      if (!totp || !(await consumeTotp(prisma, admin.id, secret, totp))) {
        recordAdminFail(normalizedEmail, ip);
        throw Errors.unauthorized({ reason: 'admin_credentials' });
      }
      // Lazy migration of a legacy plaintext secret into the encrypted column.
      if (!admin.totpSecretEnc) {
        await prisma.admin.update({
          where: { id: admin.id },
          data: { totpSecretEnc: encryptSecret(secret), totpSecret: null },
        });
      }
    }
    adminLoginFails.delete(`${normalizedEmail}|${ip}`);
    const updated = await prisma.admin.update({
      where: { id: admin.id },
      data: { lastLoginAt: new Date() },
    });
    return issueAdminTokens(updated);
  }

  async function adminChangePassword(
    adminId: string,
    currentPassword: string,
    newPassword: string,
  ): Promise<void> {
    const admin = await loadActive(adminId);
    const ok = await password.verify(currentPassword, admin.passwordHash);
    if (!ok) throw Errors.unauthorized({ reason: 'admin_credentials' });
    // M6: bumping token_epoch revokes every outstanding admin refresh token.
    await prisma.admin.update({
      where: { id: adminId },
      data: {
        passwordHash: await password.hash(newPassword),
        mustChangePassword: false,
        tokenEpoch: { increment: 1 },
      },
    });
  }

  // M6: sign-out with a valid admin refresh token bumps the epoch (revokes all
  // of this admin's refresh tokens). Invalid / stale tokens are ignored.
  async function adminLogout(token: string): Promise<void> {
    let decoded: ReturnType<typeof verifyAdminRefreshToken>;
    try {
      decoded = verifyAdminRefreshToken(token);
    } catch {
      return;
    }
    await prisma.admin.updateMany({
      where: { id: decoded.sub, tokenEpoch: decoded.ep },
      data: { tokenEpoch: { increment: 1 } },
    });
  }

  // ─── H2: TOTP enrolment ────────────────────────────────────────────
  async function adminTotpSetup(adminId: string): Promise<{ secret: string; otpauthUri: string }> {
    const admin = await loadActive(adminId);
    if (admin.totpEnabled) throw Errors.conflict('TOTP already enabled', { reason: 'totp_already_enabled' });
    const secret = generateTotpSecret();
    await prisma.admin.update({
      where: { id: adminId },
      data: { totpPendingEnc: encryptSecret(secret) },
    });
    return { secret, otpauthUri: totpKeyUri(admin.email, secret) };
  }

  // Confirming rotates the token epoch (all other sessions end) and returns a
  // fresh token pair so the current session continues.
  async function adminTotpConfirm(adminId: string, code: string): Promise<AdminAuthResult> {
    const admin = await loadActive(adminId);
    if (admin.totpEnabled) throw Errors.conflict('TOTP already enabled', { reason: 'totp_already_enabled' });
    if (!admin.totpPendingEnc) {
      throw Errors.conflict('TOTP setup not started', { reason: 'totp_setup_not_started' });
    }
    const step = matchTotpStep(decryptSecret(admin.totpPendingEnc), code);
    if (step === null) throw Errors.validation({ reason: 'totp_invalid' });
    const updated = await prisma.admin.update({
      where: { id: adminId },
      data: {
        totpSecretEnc: admin.totpPendingEnc,
        totpPendingEnc: null,
        totpSecret: null,
        totpEnabled: true,
        totpLastStep: step,
        tokenEpoch: { increment: 1 },
      },
    });
    return issueAdminTokens(updated);
  }

  // Self: needs a current code. Another admin: superadmin only (lost device).
  async function adminTotpDisable(
    actor: { id: string; role: 'admin' | 'superadmin' },
    input: { adminId?: string; code?: string },
    ip: string | null,
  ): Promise<void> {
    const targetId = input.adminId ?? actor.id;
    if (targetId !== actor.id) {
      if (actor.role !== 'superadmin') throw Errors.forbidden({ reason: 'superadmin_only' });
      const target = await prisma.admin.findUnique({ where: { id: targetId } });
      if (!target) throw Errors.notFound('Admin');
      await prisma.admin.update({ where: { id: targetId }, data: TOTP_RESET });
      await writeAdminAction(prisma, {
        adminId: actor.id,
        action: 'disable_admin_totp',
        targetId,
        targetType: 'admin',
        ipAddress: ip,
      });
      return;
    }
    const admin = await loadActive(actor.id);
    if (!admin.totpEnabled) throw Errors.conflict('TOTP not enabled', { reason: 'totp_not_enabled' });
    const secret = activeTotpSecret(admin);
    if (!secret || !input.code || !(await consumeTotp(prisma, admin.id, secret, input.code))) {
      throw Errors.validation({ reason: 'totp_invalid' });
    }
    await prisma.admin.update({ where: { id: admin.id }, data: TOTP_RESET });
  }

  return {
    adminLogin,
    adminChangePassword,
    adminLogout,
    adminTotpSetup,
    adminTotpConfirm,
    adminTotpDisable,
  };
}
