import type { PrismaClient } from '@prisma/client';
import { Errors } from '@/lib/errors.js';
import * as password from '@/lib/bcrypt.js';
import { generateOtp, sha256Hex } from '@/lib/random.js';
import { recordSent } from '@/lib/otpCapture.js';
import { whatsappEnabled, sendWhatsappOtp } from '@/lib/whatsapp.js';
import { assertActiveUser } from '@/lib/assertUser.js';
import { logger, maskPhone } from '@/lib/logger.js';
import { env } from '@/config/env.js';
import type { AuthResult } from './auth.types.js';
import { issueFullAuthForUser } from './auth.helpers.js';
import {
  PHONE_CHANGE_DAILY_CAP,
  OTP_TTL_SEC,
  OTP_MAX_ATTEMPTS,
  OTP_BRUTEFORCE_BLOCK_MIN,
  OTP_DAILY_CAP,
  OTP_MIN_GAP_SEC,
} from './auth.constants.js';

const KG_PREFIX = '+996';

// Persistent throttle: ≤1 code / OTP_MIN_GAP_SEC per phone, ≤OTP_DAILY_CAP / day
// per (phone, ip) and ≤OTP_PHONE_DAILY_CEILING / day per phone. DB-backed so
// the cost cap survives restarts / multiple instances (the route limiters are
// only an in-memory safety net). Keying the daily cap on (phone, ip) means a
// stranger can't burn a victim's quota and lock them out (M5).
async function assertOtpSendAllowed(
  prisma: PrismaClient,
  phone: string,
  ip: string | null,
): Promise<void> {
  const lastOtp = await prisma.otpCode.findFirst({
    where: { phone },
    orderBy: { createdAt: 'desc' },
  });
  const now = Date.now();
  if (lastOtp && now - lastOtp.createdAt.getTime() < OTP_MIN_GAP_SEC * 1000) {
    throw Errors.rateLimited({ bucket: 'otp_send_min', reason: 'too_soon' });
  }
  const dayAgo = new Date(now - 24 * 60 * 60_000);
  const [pairCount, phoneCount] = await Promise.all([
    prisma.otpCode.count({ where: { phone, requestIp: ip, createdAt: { gte: dayAgo } } }),
    prisma.otpCode.count({ where: { phone, createdAt: { gte: dayAgo } } }),
  ]);
  if (pairCount >= OTP_DAILY_CAP) {
    throw Errors.rateLimited({ bucket: 'otp_send_day', limit: OTP_DAILY_CAP });
  }
  if (phoneCount >= env.OTP_PHONE_DAILY_CEILING) {
    throw Errors.rateLimited({ bucket: 'otp_send_day_phone', limit: env.OTP_PHONE_DAILY_CEILING });
  }
  await assertOtpBudget(prisma, phone, dayAgo);
}

// H1: platform-wide daily OTP budget (WhatsApp templates cost money; OTP goes
// to every country, no CAPTCHA). Foreign (non-+996) numbers get a lower budget
// of their own — that's where toll-fraud traffic comes from.
async function assertOtpBudget(prisma: PrismaClient, phone: string, since: Date): Promise<void> {
  const total = await prisma.otpCode.count({ where: { createdAt: { gte: since } } });
  if (total >= env.OTP_GLOBAL_DAILY_CAP) {
    logger.error(
      { event: 'otp.budget_exceeded', scope: 'global', count: total, cap: env.OTP_GLOBAL_DAILY_CAP },
      'ALERT: global daily OTP budget exhausted — OTP sending paused',
    );
    throw Errors.otpBudgetExceeded({ scope: 'global' });
  }
  if (phone.startsWith(KG_PREFIX)) return;
  const foreign = await prisma.otpCode.count({
    where: { createdAt: { gte: since }, NOT: { phone: { startsWith: KG_PREFIX } } },
  });
  if (foreign >= env.OTP_FOREIGN_DAILY_CAP) {
    logger.error(
      { event: 'otp.budget_exceeded', scope: 'foreign', count: foreign, cap: env.OTP_FOREIGN_DAILY_CAP },
      'ALERT: foreign-number daily OTP budget exhausted — non-+996 OTP paused',
    );
    throw Errors.otpBudgetExceeded({ scope: 'foreign' });
  }
}

// WhatsApp authentication template is the only OTP channel. In non-prod with no
// WhatsApp configured the code is captured locally so dev / CI / tests work
// without a live provider (prod refuses to boot without WhatsApp, see env.ts).
async function deliverOtp(phone: string, code: string): Promise<void> {
  if (whatsappEnabled()) {
    await sendWhatsappOtp(phone, code);
    return;
  }
  recordSent(phone, `Terme: ${code} — код подтверждения. Срок действия: 10 минут.`);
  logger.info({ phone: maskPhone(phone) }, '[MOCK OTP] captured locally (WhatsApp not configured)');
}

function normalizeTelegramPhone(raw: string): string {
  return raw.startsWith('+') ? raw : `+${raw}`;
}

export type TelegramContactOutcome =
  | { status: 'ok'; userId: string; created: boolean }
  | { status: 'blocked' }
  // The number already belongs to a web / mobile account this Telegram isn't
  // linked to — mobile numbers get recycled, so prove it with a WhatsApp code.
  | { status: 'needs_otp'; phone: string };

/**
 * Telegram bot sign-in: the user tapped «Поделиться номером» (request_contact)
 * and shared their OWN contact — Telegram has verified the number belongs to
 * this Telegram account, so no OTP is needed. The bot must check
 * contact.user_id === from.id before calling this.
 *
 * Links the Telegram id to the account that owns the phone (web/mobile account)
 * or creates a new account. Linking to an EXISTING account that isn't already
 * this Telegram's needs `otpVerified` (a WhatsApp code to that number). A
 * Telegram id moves to the phone owner if it was attached to another account.
 */
export async function linkTelegramContact(
  prisma: PrismaClient,
  telegramId: number,
  phoneRaw: string,
  firstName: string | undefined,
  langCode: string | undefined,
  otpVerified = false,
): Promise<TelegramContactOutcome> {
  const tgId = BigInt(telegramId);
  const phone = normalizeTelegramPhone(phoneRaw);
  const now = new Date();
  return prisma.$transaction(async (tx) => {
    const owner = await tx.user.findFirst({ where: { phone, deletedAt: null } });
    if (owner?.isBlocked) return { status: 'blocked' as const };
    if (owner && owner.telegramId !== tgId && !otpVerified) return { status: 'needs_otp' as const, phone };

    const holder = await tx.user.findFirst({ where: { telegramId: tgId } });
    if (holder && holder.id !== owner?.id) {
      await tx.user.update({ where: { id: holder.id }, data: { telegramId: null } });
    }

    if (owner) {
      await tx.user.update({
        where: { id: owner.id },
        data: { telegramId: tgId, phoneVerifiedAt: owner.phoneVerifiedAt ?? now },
      });
      return { status: 'ok' as const, userId: owner.id, created: false };
    }
    const created = await tx.user.create({
      data: {
        phone,
        name: (firstName?.trim() || 'Пользователь').slice(0, 100),
        language: langCode === 'ky' ? 'kg' : 'ru',
        roles: ['passenger'],
        telegramId: tgId,
        phoneVerifiedAt: now,
        termsAcceptedAt: now,
      },
    });
    return { status: 'ok' as const, userId: created.id, created: true };
  });
}

export function createOtpMethods(prisma: PrismaClient) {
  // `ip` = requester IP (null for the Telegram bot), see assertOtpSendAllowed.
  async function sendOtp(
    phone: string,
    ip: string | null = null,
  ): Promise<{ expiresInSec: number; debug_code?: string }> {
    await assertOtpSendAllowed(prisma, phone, ip);
    const code = generateOtp();
    const codeHash = await password.hash(code);
    const expiresAt = new Date(Date.now() + OTP_TTL_SEC * 1000);
    await prisma.otpCode.create({ data: { phone, codeHash, expiresAt, requestIp: ip } });
    try {
      await deliverOtp(phone, code);
    } catch (err) {
      logger.error({ err, phone: maskPhone(phone) }, 'OTP delivery failed');
      throw Errors.serviceUnavailable('OTP delivery failed');
    }
    // Only leak the code back when OTP_DEBUG is explicitly on (dev/CI).
    return {
      expiresInSec: OTP_TTL_SEC,
      ...(env.OTP_DEBUG && { debug_code: code }),
    };
  }

  // Validate + consume the latest OTP for `phone` (single-use, TTL, attempt cap).
  async function consumeOtp(phone: string, code: string): Promise<void> {
    const now = new Date();
    const recent = await prisma.otpCode.findFirst({ where: { phone }, orderBy: { createdAt: 'desc' } });
    if (!recent) throw Errors.otpWrong();
    if (
      recent.attempts >= OTP_MAX_ATTEMPTS &&
      now.getTime() - recent.createdAt.getTime() < OTP_BRUTEFORCE_BLOCK_MIN * 60_000
    ) {
      throw Errors.otpTooManyAttempts();
    }
    if (recent.usedAt) throw Errors.otpWrong();
    if (recent.expiresAt.getTime() <= now.getTime()) throw Errors.otpExpired();
    // Count the attempt atomically BEFORE verifying: parallel guesses can't all
    // slip under the cap, and a code can be consumed only once.
    const claimed = await prisma.otpCode.updateMany({
      where: { id: recent.id, usedAt: null, attempts: { lt: OTP_MAX_ATTEMPTS } },
      data: { attempts: { increment: 1 } },
    });
    if (claimed.count !== 1) throw Errors.otpTooManyAttempts();
    if (!(await password.verify(code, recent.codeHash))) throw Errors.otpWrong();
    const used = await prisma.otpCode.updateMany({
      where: { id: recent.id, usedAt: null },
      data: { usedAt: now },
    });
    if (used.count !== 1) throw Errors.otpWrong();
  }

  // Mobile login of an EXISTING account by phone + WhatsApp code. New phones
  // must go through /auth/register (name required) — no nameless accounts.
  async function verifyOtp(phone: string, code: string, deviceInfo?: string): Promise<AuthResult> {
    await consumeOtp(phone, code);
    const user = await prisma.user.findFirst({ where: { phone, deletedAt: null } });
    if (!user) throw Errors.notFound('User');
    if (user.isBlocked) throw Errors.forbidden({ reason: 'blocked' });
    if (!user.phoneVerifiedAt) {
      await prisma.user.update({ where: { id: user.id }, data: { phoneVerifiedAt: new Date() } });
    }
    return issueFullAuthForUser(prisma, user.id, deviceInfo);
  }

  async function registerWithPhone(
    phone: string,
    code: string,
    name: string,
    surname: string,
    plainPassword: string | undefined,
    deviceInfo?: string,
  ): Promise<AuthResult> {
    await consumeOtp(phone, code);
    const now = new Date();
    // Web registers with a password (its login method); mobile doesn't.
    const pw = plainPassword
      ? { passwordHash: await password.hash(plainPassword), lastPasswordChangedAt: now }
      : {};
    const user = await prisma.$transaction(async (tx) => {
      const existing = await tx.user.findFirst({ where: { phone, deletedAt: null } });
      if (existing?.isBlocked) throw Errors.forbidden({ reason: 'blocked' });
      if (existing) {
        // Number already has an account (e.g. created from the Telegram bot):
        // the fresh code proves ownership, so complete the profile and log in.
        // Other sessions must not survive a credential change.
        await tx.refreshToken.updateMany({
          where: { userId: existing.id, revokedAt: null },
          data: { revokedAt: now },
        });
        return tx.user.update({
          where: { id: existing.id },
          data: {
            name,
            surname,
            phoneVerifiedAt: existing.phoneVerifiedAt ?? now,
            termsAcceptedAt: existing.termsAcceptedAt ?? now,
            ...pw,
          },
        });
      }
      return tx.user.create({
        data: {
          phone,
          name,
          surname,
          language: 'ru',
          roles: ['passenger'],
          phoneVerifiedAt: now,
          termsAcceptedAt: now,
          ...pw,
        },
      });
    });
    if (user.isBlocked) throw Errors.forbidden({ reason: 'blocked' });
    return issueFullAuthForUser(prisma, user.id, deviceInfo);
  }

  // Phone change: the session proves who is asking, the code to the NEW number
  // proves its possession.
  async function startPhoneChange(
    userId: string,
    newPhone: string,
    ip: string | null = null,
  ): Promise<{ expiresInSec: number }> {
    await assertActiveUser(userId, prisma);
    const taken = await prisma.user.findFirst({
      where: { phone: newPhone, deletedAt: null, NOT: { id: userId } },
    });
    if (taken) throw Errors.conflict('Phone already in use', { reason: 'phone_taken' });
    const since = new Date(Date.now() - 24 * 60 * 60_000);
    const recent = await prisma.otpCode.count({
      where: { phone: newPhone, createdAt: { gte: since } },
    });
    if (recent >= PHONE_CHANGE_DAILY_CAP) {
      throw Errors.rateLimited({ bucket: 'phone_change_day', limit: PHONE_CHANGE_DAILY_CAP });
    }
    return sendOtp(newPhone, ip);
  }

  async function confirmPhoneChange(
    userId: string,
    newPhone: string,
    code: string,
    deviceInfo?: string,
  ): Promise<AuthResult> {
    await assertActiveUser(userId, prisma);
    await consumeOtp(newPhone, code);
    await prisma.$transaction(async (tx) => {
      const taken = await tx.user.findFirst({
        where: { phone: newPhone, deletedAt: null, NOT: { id: userId } },
      });
      if (taken) throw Errors.conflict('Phone already in use', { reason: 'phone_taken' });
      await tx.user.update({
        where: { id: userId },
        data: { phone: newPhone, phoneVerifiedAt: new Date() },
      });
    });
    const result = await issueFullAuthForUser(prisma, userId, deviceInfo);
    // A phone change is a security event — every other session must re-login.
    await prisma.refreshToken.updateMany({
      where: { userId, revokedAt: null, tokenHash: { not: sha256Hex(result.refreshToken) } },
      data: { revokedAt: new Date() },
    });
    return result;
  }

  return { sendOtp, consumeOtp, verifyOtp, registerWithPhone, startPhoneChange, confirmPhoneChange };
}
