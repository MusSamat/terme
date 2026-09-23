import type { Prisma, PrismaClient } from '@prisma/client';
import { Errors } from '@/lib/errors.js';
import * as password from '@/lib/bcrypt.js';
import { generateOtp, generateUuid } from '@/lib/random.js';
import { recordSent } from '@/lib/sms.js';
import { whatsappEnabled, sendWhatsappOtp } from '@/lib/whatsapp.js';
// OTP is delivered via WhatsApp for now (see deliverOtp). The other channels —
// Telegram Gateway and Dexatel — are commented out; re-enable their imports and
// the branches in sendTelegramOtp / consumeOtp when we bring them back.
// import { sendGatewayVerification } from '@/lib/telegramGateway.js';
// import { dexatelEnabled, dexatelSendVerification, dexatelCheckCode } from '@/lib/dexatel.js';
import { logger } from '@/lib/logger.js';
import { env } from '@/config/env.js';
import type { Provider } from '@/lib/jwt.js';
import type { AuthResult } from './auth.types.js';
import { issueFullAuthForUser } from './auth.helpers.js';
import {
  PHONE_CHANGE_DAILY_CAP,
  OTP_TTL_SEC,
  OTP_MAX_ATTEMPTS,
  OTP_BRUTEFORCE_BLOCK_MIN,
  OTP_DAILY_CAP,
  OTP_MIN_GAP_SEC,
  TELEGRAM_LINK_TOKEN_TTL_SEC,
} from './auth.constants.js';

// Minimal Telegram bot interface — grammy Bot satisfies this at runtime.
export interface TelegramSender {
  api: { sendMessage(chatId: number, text: string): Promise<unknown> };
}

// Persistent per-phone throttle: ≤1 code / OTP_MIN_GAP_SEC and ≤OTP_DAILY_CAP /
// day. DB-backed so the cost cap survives restarts / multiple instances (the
// route limiter is only an in-memory safety net). Every send path — local OR
// Dexatel — MUST go through this before spending a paid message.
async function assertOtpSendAllowed(prisma: PrismaClient, phone: string): Promise<void> {
  const lastOtp = await prisma.otpCode.findFirst({
    where: { phone },
    orderBy: { createdAt: 'desc' },
  });
  const now = Date.now();
  if (lastOtp && now - lastOtp.createdAt.getTime() < OTP_MIN_GAP_SEC * 1000) {
    throw Errors.rateLimited({ bucket: 'otp_send_min', reason: 'too_soon' });
  }
  const dayAgo = new Date(now - 24 * 60 * 60_000);
  const dayCount = await prisma.otpCode.count({
    where: { phone, createdAt: { gte: dayAgo } },
  });
  if (dayCount >= OTP_DAILY_CAP) {
    throw Errors.rateLimited({ bucket: 'otp_send_day', limit: OTP_DAILY_CAP });
  }
}

// Module-level so both createOtpMethods and handleTelegramLinkToken can use it.
async function createOtpRecord(prisma: PrismaClient, phone: string): Promise<string> {
  await assertOtpSendAllowed(prisma, phone);
  const code = generateOtp();
  const codeHash = await password.hash(code);
  const expiresAt = new Date(Date.now() + OTP_TTL_SEC * 1000);
  await prisma.otpCode.create({ data: { phone, codeHash, expiresAt } });
  return code;
}

// Single OTP delivery channel. Primary: WhatsApp authentication template.
// When WhatsApp isn't configured (dev / CI / tests) we capture the code locally
// so those environments keep working without a live Cloud API. `text` is only
// used by that local fallback — the WhatsApp template renders its own copy.
async function deliverOtp(phone: string, code: string, text: string): Promise<void> {
  if (whatsappEnabled()) {
    await sendWhatsappOtp(phone, code);
    return;
  }
  recordSent(phone, text);
  logger.info({ phone }, '[MOCK OTP] captured locally (WhatsApp not configured)');
}

// Called by the grammy /start handler when the user opens the `reg_` deep-link.
//
// SECURITY (C1): this used to create an OTP for record.phone and deliver it to
// the REQUESTER's OWN Telegram chat. An attacker could request a link for any
// victim's phone, press Start, receive the victim's code in their own chat, and
// complete /auth/phone/verify → full account takeover. The Telegram chat proves
// nothing about ownership of record.phone.
//
// Fix: never deliver an OTP to a Telegram chat for an unproven phone. All OTP
// now goes via WhatsApp (see deliverOtp). The `reg_` deep-link OTP flow is
// retired — this handler only tells the user to continue in the browser (where
// /auth/phone/send-otp delivers the code to the real phone via WhatsApp) or, for
// a phone-less Telegram registration, to use the request_contact flow
// (handleBotLoginToken → registerFromTelegramContact) which verifies the shared
// contact's phone_number belongs to the Telegram account.
export async function handleTelegramLinkToken(
  prisma: PrismaClient,
  bot: TelegramSender,
  token: string,
  telegramId: number,
): Promise<void> {
  const record = await prisma.telegramLinkToken.findUnique({ where: { token } });
  if (!record || record.expiresAt.getTime() <= Date.now()) {
    await bot.api.sendMessage(telegramId, 'Ссылка устарела. Начните регистрацию заново.');
    return;
  }
  await bot.api.sendMessage(
    telegramId,
    'Код подтверждения отправляется на ваш номер в WhatsApp. Вернитесь в браузер и введите его там.',
  );
}

export type BotStartOutcome =
  | 'logged_in'      // existing account — token marked done
  | 'need_contact'   // new Telegram — ask for phone via request_contact
  | 'expired'
  | 'already'
  | 'blocked';

export async function handleBotLoginToken(
  prisma: PrismaClient,
  bot: TelegramSender,
  token: string,
  telegramId: number,
): Promise<BotStartOutcome> {
  const record = await prisma.telegramBotLoginToken.findUnique({ where: { token } });
  if (!record || record.expiresAt.getTime() <= Date.now()) {
    await bot.api.sendMessage(telegramId, 'Ссылка устарела. Попробуйте снова.');
    return 'expired';
  }
  if (record.status !== 'waiting') {
    await bot.api.sendMessage(telegramId, 'Вход уже выполнен. Вернитесь в приложение.');
    return 'already';
  }
  const user = await prisma.user.findFirst({
    where: { telegramId: BigInt(telegramId), deletedAt: null },
  });
  if (!user) {
    // No account yet → free registration: remember which Telegram is completing
    // THIS token, then the caller asks for the phone via request_contact.
    await prisma.telegramBotLoginToken.update({
      where: { token },
      data: { telegramId: BigInt(telegramId) },
    });
    return 'need_contact';
  }
  if (user.isBlocked) {
    await prisma.telegramBotLoginToken.update({
      where: { token },
      data: { status: 'not_found' },
    });
    await bot.api.sendMessage(telegramId, 'Ваш аккаунт заблокирован. Обратитесь в поддержку.');
    return 'blocked';
  }
  if (!user.phoneVerifiedAt) {
    // Existing account logged in via Telegram but with NO verified number yet
    // (provisional account). Ask for the phone via request_contact before
    // finishing — in a plain browser this is the only way to obtain it, since
    // Mini App requestContact is unavailable there. The token stays 'waiting'
    // so registerFromTelegramContact binds the number to THIS account.
    await prisma.telegramBotLoginToken.update({
      where: { token },
      data: { telegramId: BigInt(telegramId) },
    });
    return 'need_contact';
  }
  await prisma.telegramBotLoginToken.update({
    where: { token },
    data: { status: 'done', userId: user.id },
  });
  await bot.api.sendMessage(
    telegramId,
    '✅ Вы вошли! Вернитесь в браузер — через пару секунд вы окажетесь внутри.',
  );
  return 'logged_in';
}

/**
 * Free Telegram registration: the user shared their phone via the bot's
 * request_contact button (Telegram-verified). Create-or-link the account and
 * complete the waiting bot-login token so the browser can claim a session.
 * Returns 'ok' | 'no_pending' | 'blocked'.
 */
export async function registerFromTelegramContact(
  prisma: PrismaClient,
  telegramId: number,
  phoneRaw: string,
  firstName: string | undefined,
  langCode: string | undefined,
): Promise<'ok' | 'no_pending' | 'blocked'> {
  const tgId = BigInt(telegramId);
  const phone = phoneRaw.startsWith('+') ? phoneRaw : `+${phoneRaw}`;
  const pending = await prisma.telegramBotLoginToken.findFirst({
    where: { telegramId: tgId, status: 'waiting', expiresAt: { gt: new Date() } },
    orderBy: { createdAt: 'desc' },
  });
  if (!pending) return 'no_pending';

  const now = new Date();
  const userId = await prisma.$transaction(async (tx) => {
    // Prefer an account already holding this Telegram, then one holding the
    // phone (link Telegram to it), else create fresh.
    let u = await tx.user.findFirst({ where: { telegramId: tgId, deletedAt: null } });
    if (!u) u = await tx.user.findFirst({ where: { phone, deletedAt: null } });
    if (u?.isBlocked) return null;

    if (!u) {
      u = await tx.user.create({
        data: {
          phone,
          name: (firstName ?? 'Новый пользователь').slice(0, 100),
          language: langCode === 'ky' ? 'kg' : 'ru',
          roles: ['passenger'],
          telegramId: tgId,
          phoneVerifiedAt: now,
          termsAcceptedAt: now,
        },
      });
    } else {
      u = await tx.user.update({
        where: { id: u.id },
        data: {
          ...(u.phoneVerifiedAt === null ? { phone, phoneVerifiedAt: now } : {}),
          ...(u.telegramId === null ? { telegramId: tgId } : {}),
        },
      });
    }
    await tx.authProvider.upsert({
      where: { provider_providerUserId: { provider: 'phone', providerUserId: phone } },
      update: {},
      create: { userId: u.id, provider: 'phone', providerUserId: phone },
    });
    await tx.authProvider.upsert({
      where: { provider_providerUserId: { provider: 'telegram', providerUserId: String(telegramId) } },
      update: {},
      create: { userId: u.id, provider: 'telegram', providerUserId: String(telegramId) },
    });
    await tx.telegramBotLoginToken.update({
      where: { id: pending.id },
      data: { status: 'done', userId: u.id, telegramId: null },
    });
    return u.id;
  });
  return userId ? 'ok' : 'blocked';
}

export function createOtpMethods(prisma: PrismaClient, _bot: TelegramSender | null = null) {
  async function sendOtp(phone: string): Promise<{ expiresInSec: number; debug_code?: string }> {
    const code = await createOtpRecord(prisma, phone);
    const text = `Terme: ${code} — код подтверждения. Срок действия: 10 минут.`;
    try {
      await deliverOtp(phone, code, text);
    } catch (err) {
      logger.error({ err, phone }, 'OTP delivery failed');
      throw Errors.serviceUnavailable('OTP delivery failed');
    }
    // L3: only leak the code back to the client when OTP_DEBUG is explicitly on
    // (dev/CI convenience), never merely because NODE_ENV !== 'production'.
    return {
      expiresInSec: OTP_TTL_SEC,
      ...(env.OTP_DEBUG && { debug_code: code }),
    };
  }

  // Login / forgot-password OTP. Delivered via WhatsApp (deliverOtp) like every
  // other code — we generate + hash it locally, so consumeOtp verifies the hash.
  // (The former Dexatel Telegram-Verify path is disabled; re-enable its branch
  // here and in consumeOtp when Dexatel comes back.)
  async function sendTelegramOtp(phone: string): Promise<{ expiresInSec: number }> {
    const code = await createOtpRecord(prisma, phone);
    const text = `Terme: ${code} — код подтверждения. Срок действия: 10 минут.`;
    try {
      await deliverOtp(phone, code, text);
    } catch (err) {
      logger.error({ err, phone }, 'OTP delivery failed');
      throw Errors.serviceUnavailable('OTP delivery failed');
    }
    return { expiresInSec: OTP_TTL_SEC };
  }

  // Send an OTP for `phone` straight to the CURRENT user's Telegram chat — no
  // deep-link / "Start" step. For phone-less Telegram users adding a number from
  // inside the Mini App: avoids opening the bot (which closes the Mini App).
  // Throws reason 'telegram_dm_unavailable' if the bot can't DM the user, so the
  // client can fall back to the deep-link flow.
  // OTP that BINDS phone `phone` to the account must be delivered to that
  // phone (SMS) — delivering it to the requester's own Telegram proved nothing
  // and let anyone claim (and merge into!) an account behind any number they
  // typed. Telegram-DM delivery remains only for login codes to the account's
  // OWN already-verified number (sendTelegramOtp).
  async function sendPhoneAddOtp(
    _userId: string,
    phone: string,
  ): Promise<{ expiresInSec: number }> {
    const since = new Date(Date.now() - 24 * 60 * 60_000);
    const recent = await prisma.otpCode.count({ where: { phone, createdAt: { gte: since } } });
    if (recent >= PHONE_CHANGE_DAILY_CAP) {
      throw Errors.rateLimited({ bucket: 'phone_change_day', limit: PHONE_CHANGE_DAILY_CAP });
    }
    return sendOtp(phone);
  }

  async function initTelegramLink(
    phone: string,
  ): Promise<{ token: string; deepLink: string; expiresInSec: number }> {
    // UUID = 36 chars → "reg_" + 36 = 40 chars, well under Telegram's 64-char limit.
    const token = generateUuid();
    const expiresAt = new Date(Date.now() + TELEGRAM_LINK_TOKEN_TTL_SEC * 1000);
    await prisma.telegramLinkToken.create({ data: { token, phone, expiresAt } });
    const deepLink = `https://t.me/${env.TELEGRAM_BOT_USERNAME}?start=reg_${token}`;
    return { token, deepLink, expiresInSec: TELEGRAM_LINK_TOKEN_TTL_SEC };
  }

  async function getTelegramLinkStatus(
    token: string,
  ): Promise<{ status: 'waiting' | 'sent' | 'expired' }> {
    const record = await prisma.telegramLinkToken.findUnique({ where: { token } });
    if (!record || record.expiresAt.getTime() <= Date.now()) return { status: 'expired' };
    return { status: record.status as 'waiting' | 'sent' | 'expired' };
  }

  /**
   * Tx-scoped core: binds a VERIFIED phone to an authenticated account.
   * Shared by the OTP confirm path and the Telegram requestContact path —
   * possession of the number must already be proven by the caller. Handles
   * the provisional→owner account merge exactly like the OTP flow.
   */
  async function bindPhoneInTx(
    tx: Prisma.TransactionClient,
    userId: string,
    phone: string,
    now: Date,
  ) {
        const existing = await tx.user.findUnique({ where: { id: userId } });
        if (!existing || existing.deletedAt) throw Errors.unauthorized({ reason: 'user_gone' });
        const phoneOwner = await tx.user.findFirst({
          where: { phone, deletedAt: null, NOT: { id: existing.id } },
        });
        if (phoneOwner) {
          // If the provisional user only has a placeholder phone (OAuth/Telegram signup),
          // merge it into the verified phone account: transfer providers + telegramId, then
          // soft-delete the placeholder account so the user ends up with one unified account.
          if (existing.phone.startsWith('+prov:')) {
            const movedTelegramId = existing.telegramId;
            // Release the placeholder's UNIQUE fields (telegram_id, phone) FIRST.
            // Otherwise setting them on phoneOwner while `existing` still holds the
            // same telegram_id collides on the unique index → P2002 → 500.
            const tombstone = `+del:${generateUuid().slice(0, 12)}`;
            await tx.user.update({
              where: { id: existing.id },
              data: { deletedAt: now, phone: tombstone, telegramId: null },
            });
            await tx.refreshToken.updateMany({
              where: { userId: existing.id, revokedAt: null },
              data: { revokedAt: now },
            });
            if (movedTelegramId) {
              await tx.user.update({
                where: { id: phoneOwner.id },
                data: { telegramId: movedTelegramId },
              });
            }
            // Move OAuth/telegram provider links onto the surviving account,
            // skipping any the target already has (avoids the provider unique index).
            const existingLinks = await tx.authProvider.findMany({ where: { userId: existing.id } });
            for (const link of existingLinks) {
              const clash = await tx.authProvider.findUnique({
                where: {
                  provider_providerUserId: {
                    provider: link.provider,
                    providerUserId: link.providerUserId,
                  },
                },
              });
              if (clash && clash.userId !== existing.id) {
                await tx.authProvider.delete({ where: { id: link.id } });
              } else {
                await tx.authProvider.update({
                  where: { id: link.id },
                  data: { userId: phoneOwner.id },
                });
              }
            }
            logger.info({ provisionalId: existing.id, targetId: phoneOwner.id }, 'provisional account merged into phone account');
            return tx.user.findUniqueOrThrow({ where: { id: phoneOwner.id } });
          }
          // L2: do NOT leak the owning account id to the client — it enables
          // account enumeration. Log it server-side instead for support triage.
          logger.info(
            { phone, existingUserId: phoneOwner.id },
            'phone bind rejected — already linked to another account',
          );
          throw Errors.conflict('Phone already linked to another account', {
            reason: 'phone_taken',
          });
        }
        return tx.user.update({ where: { id: existing.id }, data: { phone, phoneVerifiedAt: now } });
  }

  /** Standalone wrapper for callers outside an existing transaction. */
  async function bindVerifiedPhone(userId: string, phone: string) {
    return prisma.$transaction(async (tx) => bindPhoneInTx(tx, userId, phone, new Date()));
  }

  // Validate + consume an OTP for `phone`. With Dexatel the check is delegated to
  // the provider (it owns generation, expiry, single-use). Without a key we fall
  // back to the local bcrypt otpCode table (dev/tests). Throws on any mismatch.
  async function consumeOtp(phone: string, code: string): Promise<void> {
    // Code is generated + bcrypt-hashed locally and delivered via WhatsApp, so
    // we always verify against the stored hash. (Dexatel server-side check is
    // disabled — re-enable its branch here when Dexatel comes back.)
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
    const match = await password.verify(code, recent.codeHash);
    if (!match) {
      await prisma.otpCode.update({ where: { id: recent.id }, data: { attempts: { increment: 1 } } });
      throw Errors.otpWrong();
    }
    await prisma.otpCode.update({ where: { id: recent.id }, data: { usedAt: now, attempts: { increment: 1 } } });
  }

  // Classical registration: verify the OTP, then create (or complete) the account
  // with name/surname/password and issue a full session. Rejects if the phone is
  // already registered with a password.
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
    // Passwordless registration (mobile): no password → passwordHash stays NULL,
    // the account logs in via phone+OTP only. Web still sends a password.
    const passwordHash = plainPassword ? await password.hash(plainPassword) : null;
    const pwFields = passwordHash ? { passwordHash, lastPasswordChangedAt: now } : {};

    const user = await prisma.$transaction(async (tx) => {
      const existing = await tx.user.findFirst({ where: { phone, deletedAt: null } });
      if (existing?.passwordHash) {
        throw Errors.conflict('Phone already registered', { reason: 'already_registered' });
      }
      const u = existing
        ? await tx.user.update({
            where: { id: existing.id },
            data: {
              name,
              surname,
              phoneVerifiedAt: existing.phoneVerifiedAt ?? now,
              termsAcceptedAt: existing.termsAcceptedAt ?? now,
              ...pwFields,
            },
          })
        : await tx.user.create({
            data: {
              phone,
              name,
              surname,
              language: 'ru',
              roles: ['passenger'],
              phoneVerifiedAt: now,
              termsAcceptedAt: now,
              ...pwFields,
            },
          });
      await tx.authProvider.upsert({
        where: { provider_providerUserId: { provider: 'phone', providerUserId: phone } },
        update: {},
        create: { userId: u.id, provider: 'phone', providerUserId: phone },
      });
      return u;
    });

    if (user.isBlocked) throw Errors.forbidden({ reason: 'blocked' });
    return issueFullAuthForUser(prisma, user.id, 'phone', deviceInfo);
  }

  async function verifyOtp(
    phone: string,
    code: string,
    provisionalUserId: string | null,
    provider: Provider,
    deviceInfo?: string,
  ): Promise<AuthResult> {
    const now = new Date();
    await consumeOtp(phone, code);

    const user = await prisma.$transaction(async (tx) => {
      if (provisionalUserId) {
        return bindPhoneInTx(tx, provisionalUserId, phone, now);
      }
      // SECURITY (C1): we no longer auto-bind a telegramId harvested from a
      // telegramLinkToken here. That binding trusted an UNVERIFIED link record
      // (no expiry/status check, no proof the Telegram account owns this phone)
      // and, combined with the retired `reg_` deep-link OTP delivery, allowed an
      // attacker to attach their Telegram to a victim's freshly-verified phone
      // account. Telegram is now linked ONLY through proven-ownership paths:
      // /auth/telegram (signed initData) and the request_contact registration
      // flow (registerFromTelegramContact), which verify the Telegram identity.
      let u = await tx.user.findFirst({ where: { phone, deletedAt: null } });
      if (!u) {
        u = await tx.user.create({
          data: {
            phone,
            name: 'Новый пользователь',
            language: 'ru',
            roles: ['passenger'],
            phoneVerifiedAt: now,
            termsAcceptedAt: now,
          },
        });
      } else if (!u.phoneVerifiedAt) {
        u = await tx.user.update({
          where: { id: u.id },
          data: { phoneVerifiedAt: now },
        });
      }
      await tx.authProvider.upsert({
        where: { provider_providerUserId: { provider: 'phone', providerUserId: phone } },
        update: {},
        create: { userId: u.id, provider: 'phone', providerUserId: phone },
      });
      return u;
    });

    if (user.isBlocked) throw Errors.forbidden({ reason: 'blocked' });
    return issueFullAuthForUser(prisma, user.id, provider, deviceInfo);
  }

  const BOT_LOGIN_TTL_SEC = 5 * 60;

  async function initBotLogin(): Promise<{ token: string; deepLink: string; expiresInSec: number }> {
    const token = generateUuid();
    const expiresAt = new Date(Date.now() + BOT_LOGIN_TTL_SEC * 1000);
    await prisma.telegramBotLoginToken.create({ data: { token, expiresAt } });
    const deepLink = `https://t.me/${env.TELEGRAM_BOT_USERNAME}?start=bl_${token}`;
    return { token, deepLink, expiresInSec: BOT_LOGIN_TTL_SEC };
  }

  async function getBotLoginStatus(token: string): Promise<{ status: 'waiting' | 'done' | 'expired' | 'not_found' }> {
    const record = await prisma.telegramBotLoginToken.findUnique({ where: { token } });
    if (!record || record.expiresAt.getTime() <= Date.now()) return { status: 'expired' };
    return { status: record.status as 'waiting' | 'done' | 'expired' | 'not_found' };
  }

  async function claimBotLogin(token: string, deviceInfo?: string): Promise<AuthResult> {
    const record = await prisma.telegramBotLoginToken.findUnique({ where: { token } });
    if (!record || record.status !== 'done' || !record.userId || record.expiresAt.getTime() <= Date.now()) {
      throw Errors.unauthorized({ reason: 'bot_login_invalid' });
    }
    // Atomic single-use: two concurrent claims both pass the read above; only
    // the one whose conditional update wins may issue a session.
    const claimed = await prisma.telegramBotLoginToken.updateMany({
      where: { token, status: 'done' },
      data: { status: 'used', expiresAt: new Date(0) },
    });
    if (claimed.count !== 1) {
      throw Errors.unauthorized({ reason: 'bot_login_invalid' });
    }
    return issueFullAuthForUser(prisma, record.userId, 'telegram', deviceInfo);
  }

  return { sendOtp, sendTelegramOtp, sendPhoneAddOtp, bindVerifiedPhone, consumeOtp, initTelegramLink, getTelegramLinkStatus, verifyOtp, registerWithPhone, initBotLogin, getBotLoginStatus, claimBotLogin };
}
