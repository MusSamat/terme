import type { PrismaClient } from '@prisma/client';
import { authenticator } from 'otplib';
import { env } from '@/config/env.js';
import { Errors } from '@/lib/errors.js';
import * as password from '@/lib/bcrypt.js';
import { validateTelegramContactResponse, validateTelegramInitData } from '@/lib/telegram.js';
import { verifyGoogleIdToken } from '@/lib/oauth/google.js';
import { verifyAppleIdentityToken } from '@/lib/oauth/apple.js';
import { issueFullAuthForUser } from './auth.helpers.js';
import { sha256Hex } from '@/lib/random.js';
import { signAdminAccessToken, signAdminRefreshToken, refreshTtlSeconds } from '@/lib/jwt.js';
import { assertActiveUser } from '@/lib/assertUser.js';
import type { StartPhoneChangeInput } from './auth.schemas.js';
import type { AdminAuthResult, AuthResult } from './auth.types.js';
import type { createOtpMethods } from './auth.otp.js';
import { PHONE_CHANGE_DAILY_CAP } from './auth.constants.js';

// L1: a cost-12 dummy bcrypt hash of a random string. Comparing against this on
// unknown accounts costs the SAME as a real verify (cost 12), so response timing
// no longer leaks whether an email/phone exists. (The old '$2a$04$…' placeholder
// verified at cost 4 — an order of magnitude faster — which was a timing oracle.)
// Value is a valid bcrypt hash that nothing can match (random plaintext).
const DUMMY_BCRYPT_HASH_COST12 =
  '$2a$12$C6UzMDM.H6dfI/f/IKcEeODuLXk1UT9UyN3Ci7q2ZfP8i8VqQ0y8W';

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

export function createPasswordMethods(
  prisma: PrismaClient,
  otp: ReturnType<typeof createOtpMethods>,
) {
  async function setPassword(
    userId: string,
    newPassword: string,
    currentPassword?: string,
  ): Promise<void> {
    const user = await assertActiveUser(userId, prisma);
    if (user.passwordHash) {
      if (!currentPassword) {
        throw Errors.unauthorized({ reason: 'current_password_required' });
      }
      const ok = await password.verify(currentPassword, user.passwordHash);
      if (!ok) throw Errors.unauthorized({ reason: 'current_password_mismatch' });
    }
    const hash = await password.hash(newPassword);
    await prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: userId },
        data: { passwordHash: hash, lastPasswordChangedAt: new Date() },
      });
      await tx.authProvider.upsert({
        where: { provider_providerUserId: { provider: 'phone', providerUserId: user.phone } },
        update: {},
        create: { userId, provider: 'phone', providerUserId: user.phone },
      });
    });
  }

  // M2: reset-password now demands a FRESH OTP proof — a valid access token alone
  // no longer authorises a password reset (a stolen/leaked access token could
  // otherwise take over the account with no possession check). `phone` + `code`
  // are verified via consumeOtp (single-use, freshness ≤ OTP_TTL = 10 min). The
  // OTP must be for the caller's OWN verified number. After the change we revoke
  // ALL of the user's other sessions. `phone`/`code` are optional in the type to
  // stay assignable to the AuthService interface, but are required at runtime.
  async function resetPassword(
    userId: string,
    newPassword: string,
    phone?: string,
    code?: string,
  ): Promise<void> {
    const user = await assertActiveUser(userId, prisma);
    if (!phone || !code) throw Errors.unauthorized({ reason: 'otp_proof_required' });
    if (phone !== user.phone) throw Errors.unauthorized({ reason: 'otp_phone_mismatch' });
    // Consume the OTP first — single-use, enforces freshness and attempt caps.
    await otp.consumeOtp(phone, code);
    const hash = await password.hash(newPassword);
    await prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: userId },
        data: { passwordHash: hash, lastPasswordChangedAt: new Date() },
      });
      await tx.authProvider.upsert({
        where: { provider_providerUserId: { provider: 'phone', providerUserId: user.phone } },
        update: {},
        create: { userId, provider: 'phone', providerUserId: user.phone },
      });
      // logoutAll other sessions — a reset is a security event.
      await tx.refreshToken.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    });
  }

  async function startPhoneChange(
    userId: string,
    body: StartPhoneChangeInput,
  ): Promise<{ expiresInSec: number }> {
    const user = await assertActiveUser(userId, prisma);
    const { reAuthProof, newPhone } = body;

    if (reAuthProof.provider === 'telegram') {
      const validated = validateTelegramInitData(reAuthProof.initData, env.TELEGRAM_BOT_TOKEN);
      if (user.telegramId === null || BigInt(validated.user.id) !== user.telegramId) {
        throw Errors.unauthorized({ reason: 're_auth_telegram_mismatch' });
      }
    } else if (reAuthProof.provider === 'google') {
      const t = await verifyGoogleIdToken(reAuthProof.idToken);
      const linked = await prisma.authProvider.findUnique({
        where: { provider_providerUserId: { provider: 'google', providerUserId: t.sub } },
      });
      if (!linked || linked.userId !== userId) {
        throw Errors.unauthorized({ reason: 're_auth_google_mismatch' });
      }
    } else if (reAuthProof.provider === 'apple') {
      const t = await verifyAppleIdentityToken(reAuthProof.identityToken);
      const linked = await prisma.authProvider.findUnique({
        where: { provider_providerUserId: { provider: 'apple', providerUserId: t.sub } },
      });
      if (!linked || linked.userId !== userId) {
        throw Errors.unauthorized({ reason: 're_auth_apple_mismatch' });
      }
    } else {
      if (!user.passwordHash) throw Errors.unauthorized({ reason: 'password_not_set' });
      const ok = await password.verify(reAuthProof.password, user.passwordHash);
      if (!ok) throw Errors.unauthorized({ reason: 'password_mismatch' });
    }

    const taken = await prisma.user.findFirst({
      where: { phone: newPhone, deletedAt: null, NOT: { id: userId } },
    });
    if (taken) throw Errors.conflict('Phone already in use');

    const since = new Date(Date.now() - 24 * 60 * 60_000);
    const recent = await prisma.otpCode.count({
      where: { phone: newPhone, createdAt: { gte: since } },
    });
    if (recent >= PHONE_CHANGE_DAILY_CAP) {
      throw Errors.rateLimited({ bucket: 'phone_change_day', limit: PHONE_CHANGE_DAILY_CAP });
    }

    return otp.sendOtp(newPhone);
  }

  async function confirmPhoneChange(
    userId: string,
    newPhone: string,
    code: string,
    deviceInfo?: string,
  ): Promise<AuthResult> {
    const user = await assertActiveUser(userId, prisma);
    const oldPhone = user.phone;

    const result = await otp.verifyOtp(newPhone, code, userId, 'phone', deviceInfo);

    await prisma.refreshToken.updateMany({
      where: {
        userId,
        revokedAt: null,
        tokenHash: { not: sha256Hex(result.refreshToken) },
      },
      data: { revokedAt: new Date() },
    });

    // SMS "your number was changed" notice to the OLD number is disabled during
    // the Telegram-only testing period (Telegram Gateway only sends verification
    // codes, not free-text notices). Re-enable with SMS, or DM via the bot.
    // await getSmsProvider().send(oldPhone, 'Terme: номер телефона в вашем аккаунте был изменён…');
    void oldPhone;

    return result;
  }


  /**
   * Telegram requestContact flow: the mini app sends the SIGNED contact
   * payload; Telegram itself verified the number belongs to this account's
   * SIM — no OTP needed. We only accept the caller's OWN contact.
   */
  async function confirmPhoneFromTelegramContact(
    userId: string,
    response: string,
    deviceInfo?: string,
  ): Promise<AuthResult> {
    const user = await assertActiveUser(userId, prisma);
    let contact;
    try {
      contact = validateTelegramContactResponse(response, env.TELEGRAM_BOT_TOKEN, {
        maxAgeSeconds: 300,
      });
    } catch {
      throw Errors.unauthorized({ reason: 'contact_signature_invalid' });
    }
    if (user.telegramId === null || BigInt(contact.user_id) !== user.telegramId) {
      throw Errors.unauthorized({ reason: 'contact_user_mismatch' });
    }
    const phone = contact.phone_number.startsWith('+')
      ? contact.phone_number
      : `+${contact.phone_number}`;

    const bound = await otp.bindVerifiedPhone(userId, phone);
    const result = await issueFullAuthForUser(prisma, bound.id, 'telegram', deviceInfo);
    // Same session hygiene as the OTP confirm: rotate out all other sessions.
    await prisma.refreshToken.updateMany({
      where: { userId: bound.id, revokedAt: null, tokenHash: { not: sha256Hex(result.refreshToken) } },
      data: { revokedAt: new Date() },
    });
    return result;
  }

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

  return { setPassword, resetPassword, startPhoneChange, confirmPhoneChange, confirmPhoneFromTelegramContact, adminLogin, adminChangePassword };
}
