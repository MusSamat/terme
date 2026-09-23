import type { Prisma, PrismaClient } from '@prisma/client';
import { env } from '@/config/env.js';
import { Errors } from '@/lib/errors.js';
import * as password from '@/lib/bcrypt.js';
import { validateTelegramInitData, type TelegramUser } from '@/lib/telegram.js';
import { verifyGoogleIdToken } from '@/lib/oauth/google.js';
import { verifyAppleIdentityToken } from '@/lib/oauth/apple.js';
import { generateUuid } from '@/lib/random.js';
import type { Provider } from '@/lib/jwt.js';
import type { GoogleLoginInput, AppleLoginInput, PhoneLoginInput, AddProviderInput } from './auth.schemas.js';
import type { AnyAuthResult, AuthResult } from './auth.types.js';
import { issueFullAuthForUser } from './auth.helpers.js';

// L1: cost-12 dummy bcrypt hash (random plaintext, matches nothing) so verifying
// against a non-existent / passwordless account costs the same as a real login —
// no timing oracle for phone enumeration. Must stay cost 12 to match real hashes.
const DUMMY_BCRYPT_HASH_COST12 =
  '$2a$12$C6UzMDM.H6dfI/f/IKcEeODuLXk1UT9UyN3Ci7q2ZfP8i8VqQ0y8W';

export function createProvidersMethods(prisma: PrismaClient) {
  async function continueOAuthLogin(
    provider: Extract<Provider, 'google' | 'apple'>,
    providerUserId: string,
    providerData: Record<string, unknown>,
    deviceInfo?: string,
  ): Promise<AnyAuthResult> {
    const existing = await prisma.authProvider.findUnique({
      where: { provider_providerUserId: { provider, providerUserId } },
      include: { user: true },
    });
    const hintName =
      typeof providerData.name === 'string' && providerData.name
        ? (providerData.name as string)
        : typeof providerData.email === 'string' && providerData.email
          ? (providerData.email as string).split('@')[0]!
          : `${provider} user`;

    if (existing) {
      const user = existing.user;
      if (user.deletedAt) throw Errors.unauthorized({ reason: 'user_deleted' });
      if (user.isBlocked) throw Errors.forbidden({ reason: 'blocked' });
      return issueFullAuthForUser(prisma, user.id, provider, deviceInfo);
    }

    const created = await prisma.$transaction(async (tx) => {
      const newUser = await tx.user.create({
        data: {
          phone: `+prov:${generateUuid().slice(0, 12)}`,
          name: hintName.slice(0, 100),
          language: 'ru',
          roles: ['passenger'],
          termsAcceptedAt: new Date(),
        },
      });
      await tx.authProvider.create({
        data: {
          userId: newUser.id,
          provider,
          providerUserId,
          providerData: providerData as Prisma.InputJsonValue,
        },
      });
      return newUser;
    });

    return issueFullAuthForUser(prisma, created.id, provider, deviceInfo);
  }

  async function loginWithTelegram(initData: string, deviceInfo?: string): Promise<AnyAuthResult> {
    let validated;
    try {
      // 5-min replay window: a captured initData must not stay valid for the
      // library default of 24h.
      validated = validateTelegramInitData(initData, env.TELEGRAM_BOT_TOKEN, { maxAgeSeconds: 300 });
    } catch (err) {
      const reason = err instanceof Error ? err.message : 'invalid';
      throw Errors.unauthorized({ reason: 'telegram_invalid', detail: reason });
    }
    const tg: TelegramUser = validated.user;

    const existing = await prisma.authProvider.findUnique({
      where: { provider_providerUserId: { provider: 'telegram', providerUserId: String(tg.id) } },
      include: { user: true },
    });

    const hintName = tg.first_name + (tg.last_name ? ` ${tg.last_name}` : '') || `Telegram ${tg.id}`;

    if (existing) {
      const user = existing.user;
      if (user.deletedAt) throw Errors.unauthorized({ reason: 'user_deleted' });
      if (user.isBlocked) throw Errors.forbidden({ reason: 'blocked' });
      return issueFullAuthForUser(prisma, user.id, 'telegram', deviceInfo);
    }

    // Legacy accounts may hold user.telegramId without a matching authProvider
    // row. Heal the link and log in — creating a fresh user here would collide
    // on the unique telegram_id index (P2002 → 500) and duplicate the account.
    const byTelegramId = await prisma.user.findFirst({
      where: { telegramId: BigInt(tg.id), deletedAt: null },
    });
    if (byTelegramId) {
      if (byTelegramId.isBlocked) throw Errors.forbidden({ reason: 'blocked' });
      await prisma.authProvider.create({
        data: {
          userId: byTelegramId.id,
          provider: 'telegram',
          providerUserId: String(tg.id),
          providerData: {
            username: tg.username ?? null,
            first_name: tg.first_name ?? null,
            last_name: tg.last_name ?? null,
          } as Prisma.InputJsonValue,
        },
      });
      return issueFullAuthForUser(prisma, byTelegramId.id, 'telegram', deviceInfo);
    }

    const created = await prisma.$transaction(async (tx) => {
      const newUser = await tx.user.create({
        data: {
          phone: `+prov:${generateUuid().slice(0, 12)}`,
          name: hintName.slice(0, 100),
          language: tg.language_code === 'ky' ? 'kg' : 'ru',
          roles: ['passenger'],
          telegramId: BigInt(tg.id),
          termsAcceptedAt: new Date(),
        },
      });
      await tx.authProvider.create({
        data: {
          userId: newUser.id,
          provider: 'telegram',
          providerUserId: String(tg.id),
          providerData: {
            username: tg.username ?? null,
            first_name: tg.first_name ?? null,
            last_name: tg.last_name ?? null,
          } as Prisma.InputJsonValue,
        },
      });
      return newUser;
    });

    return issueFullAuthForUser(prisma, created.id, 'telegram', deviceInfo);
  }

  async function loginWithGoogle(body: GoogleLoginInput, deviceInfo?: string): Promise<AnyAuthResult> {
    let token;
    try {
      token = await verifyGoogleIdToken(body.idToken);
    } catch (err) {
      throw Errors.unauthorized({
        reason: 'google_invalid',
        detail: err instanceof Error ? err.message : 'invalid',
      });
    }
    return continueOAuthLogin('google', token.sub, {
      name: token.name ?? token.given_name ?? null,
      email: token.email ?? null,
      picture: token.picture ?? null,
      locale: token.locale ?? null,
    }, deviceInfo);
  }

  async function loginWithApple(body: AppleLoginInput, deviceInfo?: string): Promise<AnyAuthResult> {
    let token;
    try {
      token = await verifyAppleIdentityToken(body.identityToken);
    } catch (err) {
      throw Errors.unauthorized({
        reason: 'apple_invalid',
        detail: err instanceof Error ? err.message : 'invalid',
      });
    }
    return continueOAuthLogin('apple', token.sub, { email: token.email ?? null }, deviceInfo);
  }

  async function loginWithPhonePassword(body: PhoneLoginInput, deviceInfo?: string): Promise<AuthResult> {
    const user = await prisma.user.findFirst({
      where: { phone: body.phone, deletedAt: null },
    });
    const hashToCheck = user?.passwordHash ?? DUMMY_BCRYPT_HASH_COST12;
    const ok = await password.verify(body.password, hashToCheck);
    if (!user || !user.passwordHash || !ok) {
      throw Errors.unauthorized({ reason: 'invalid_credentials' });
    }
    if (user.isBlocked) throw Errors.forbidden({ reason: 'blocked' });
    if (!user.phoneVerifiedAt) throw Errors.unauthorized({ reason: 'phone_not_verified' });
    return issueFullAuthForUser(prisma, user.id, 'phone', deviceInfo);
  }

  async function addProvider(userId: string, body: AddProviderInput): Promise<{ provider: Provider }> {
    let provider: Provider;
    let providerUserId: string;
    let providerData: Record<string, unknown> = {};

    if (body.provider === 'telegram') {
      const v = validateTelegramInitData(body.initData, env.TELEGRAM_BOT_TOKEN, { maxAgeSeconds: 300 });
      provider = 'telegram';
      providerUserId = String(v.user.id);
      providerData = { username: v.user.username ?? null };
    } else if (body.provider === 'google') {
      const t = await verifyGoogleIdToken(body.idToken);
      provider = 'google';
      providerUserId = t.sub;
      providerData = { email: t.email ?? null };
    } else {
      const t = await verifyAppleIdentityToken(body.identityToken);
      provider = 'apple';
      providerUserId = t.sub;
      providerData = { email: t.email ?? null };
    }

    const existing = await prisma.authProvider.findUnique({
      where: { provider_providerUserId: { provider, providerUserId } },
    });
    if (existing && existing.userId !== userId) {
      throw Errors.conflict('Provider already linked to another account');
    }
    if (existing && existing.userId === userId) return { provider };

    await prisma.$transaction(async (tx) => {
      await tx.authProvider.create({
        data: {
          userId,
          provider,
          providerUserId,
          providerData: providerData as Prisma.InputJsonValue,
        },
      });
      if (provider === 'telegram') {
        await tx.user.update({
          where: { id: userId },
          data: { telegramId: BigInt(providerUserId) },
        });
      }
    });
    return { provider };
  }

  async function removeProvider(userId: string, provider: Provider): Promise<void> {
    const remaining = await prisma.authProvider.count({
      where: { userId, NOT: { provider } },
    });
    if (remaining === 0) {
      throw Errors.conflict('Cannot remove the last auth provider');
    }
    await prisma.$transaction(async (tx) => {
      await tx.authProvider.deleteMany({ where: { userId, provider } });
      if (provider === 'telegram') {
        await tx.user.update({ where: { id: userId }, data: { telegramId: null } });
      }
    });
  }

  return {
    loginWithTelegram,
    loginWithGoogle,
    loginWithApple,
    loginWithPhonePassword,
    addProvider,
    removeProvider,
  };
}
