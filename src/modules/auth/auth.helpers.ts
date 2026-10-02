import type { PrismaClient } from '@prisma/client';
import { env } from '@/config/env.js';
import { publicPhone } from '@/lib/errors.js';
import {
  refreshTtlSeconds,
  signAccessToken,
  signRefreshToken,
  type Provider,
  type Role,
} from '@/lib/jwt.js';
import { generateUuid, sha256Hex } from '@/lib/random.js';
import type { AuthResult, TokenPair } from './auth.types.js';

export async function issueTokenPair(
  prisma: PrismaClient,
  userId: string,
  phone: string,
  roles: Role[],
  telegramId: string | null,
  provider: Provider,
  deviceInfo: string | null | undefined,
): Promise<TokenPair> {
  const accessToken = signAccessToken({
    sub: userId,
    phone: publicPhone(phone) || phone,
    roles,
    telegram_id: telegramId,
    provider,
  });
  const tokenId = generateUuid();
  const refreshTtl = refreshTtlSeconds();
  const refreshToken = signRefreshToken({ sub: userId, tokenId }, refreshTtl);

  await prisma.refreshToken.create({
    data: {
      id: tokenId,
      userId,
      tokenHash: sha256Hex(refreshToken),
      deviceInfo: deviceInfo ?? null,
      expiresAt: new Date(Date.now() + refreshTtl * 1000),
    },
  });

  return {
    accessToken,
    refreshToken,
    accessTokenExpiresIn: env.JWT_ACCESS_TTL_MIN * 60,
    refreshTokenExpiresIn: refreshTtl,
  };
}

export async function issueFullAuthForUser(
  prisma: PrismaClient,
  userId: string,
  provider: Provider,
  deviceInfo?: string,
): Promise<AuthResult> {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  const providers = (
    await prisma.authProvider.findMany({
      where: { userId },
      select: { provider: true },
    })
  ).map((p) => p.provider as Provider);
  const pair = await issueTokenPair(
    prisma,
    user.id,
    user.phone,
    user.roles as Role[],
    user.telegramId ? user.telegramId.toString() : null,
    provider,
    deviceInfo,
  );
  const avatarUrl = user.avatarUrl ? `${env.BASE_URL}/${user.avatarUrl}` : null;
  return {
    ...pair,
    user: {
      id: user.id,
      phone: publicPhone(user.phone),
      name: user.name,
      avatarUrl,
      roles: user.roles as Role[],
      language: user.language,
      phoneVerified: user.phoneVerifiedAt !== null,
      telegramLinked: user.telegramId !== null,
      providers,
      termsAcceptedAt: user.termsAcceptedAt,
    },
    kind: 'full',
  };
}

export async function inferPrimaryProvider(
  prisma: PrismaClient,
  userId: string,
): Promise<Provider | null> {
  const row = await prisma.authProvider.findFirst({
    where: { userId },
    orderBy: { createdAt: 'asc' },
    select: { provider: true },
  });
  return (row?.provider as Provider) ?? null;
}
