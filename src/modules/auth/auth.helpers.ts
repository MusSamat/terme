import type { PrismaClient } from '@prisma/client';
import { env } from '@/config/env.js';
import { publicPhone } from '@/lib/errors.js';
import {
  refreshTtlSeconds,
  signAccessToken,
  signRefreshToken,
  type Role,
} from '@/lib/jwt.js';
import { generateUuid, sha256Hex } from '@/lib/random.js';
import type { AuthResult, TokenPair } from './auth.types.js';

export async function issueTokenPair(
  prisma: PrismaClient,
  userId: string,
  phone: string,
  roles: Role[],
  deviceInfo: string | null | undefined,
): Promise<TokenPair> {
  const accessToken = signAccessToken({
    sub: userId,
    phone: publicPhone(phone) || phone,
    roles,
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
  deviceInfo?: string,
): Promise<AuthResult> {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  const pair = await issueTokenPair(prisma, user.id, user.phone, user.roles as Role[], deviceInfo);
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
      termsAcceptedAt: user.termsAcceptedAt,
    },
    kind: 'full',
  };
}
