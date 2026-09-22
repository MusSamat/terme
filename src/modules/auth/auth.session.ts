import type { PrismaClient } from '@prisma/client';
import { env } from '@/config/env.js';
import { Errors } from '@/lib/errors.js';
import {
  verifyRefreshToken,
  verifyAdminRefreshToken,
  signAdminAccessToken,
  type Role,
} from '@/lib/jwt.js';
import { sha256Hex } from '@/lib/random.js';
import { logger } from '@/lib/logger.js';
import type { Notifier } from '@/lib/notifier.js';
import type { TokenPair, AdminRefreshResult } from './auth.types.js';
import { issueTokenPair, inferPrimaryProvider } from './auth.helpers.js';

// _notifier kept in the signature (callers pass it) — the reuse security alert
// is intentionally disabled for launch; re-enable in auth.session if needed.
export function createSessionMethods(prisma: PrismaClient, _notifier: Notifier) {
  // Token Reuse Detection per TZ §7.5
  async function refresh(
    token: string,
    deviceInfo: string | undefined,
    ip: string | null,
  ): Promise<TokenPair> {
    const decoded = verifyRefreshToken(token);
    const tokenHash = sha256Hex(token);

    const stored = await prisma.refreshToken.findUnique({ where: { tokenHash } });
    if (!stored || stored.userId !== decoded.sub) {
      throw Errors.unauthorized({ reason: 'refresh_not_found' });
    }

    if (stored.usedAt) {
      // Launch-softened: a stale/already-used refresh token is rejected, but we
      // no longer mass-revoke every session or push a security alert. The
      // «подозрительная активность» notifications were false positives from
      // concurrent refreshes and were logging users out. Just fail this token —
      // the client re-authenticates from its still-valid session.
      logger.warn(
        { userId: stored.userId, tokenId: stored.id, ip },
        'refresh token already used — rejected (no mass-revoke)',
      );
      throw Errors.unauthorized({ reason: 'refresh_reused' });
    }
    if (stored.revokedAt) throw Errors.unauthorized({ reason: 'refresh_revoked' });
    if (stored.expiresAt.getTime() <= Date.now()) {
      throw Errors.unauthorized({ reason: 'refresh_expired' });
    }

    const markRes = await prisma.refreshToken.updateMany({
      where: { id: stored.id, usedAt: null, revokedAt: null },
      data: { usedAt: new Date(), revokedAt: new Date() },
    });
    if (markRes.count !== 1) {
      // Concurrent-refresh race: another request already rotated this token.
      // Reject this retry without mass-revoke / alert — the winning refresh's
      // session stays valid.
      throw Errors.unauthorized({ reason: 'refresh_race' });
    }

    const user = await prisma.user.findUnique({ where: { id: stored.userId } });
    if (!user || user.deletedAt) throw Errors.unauthorized({ reason: 'user_gone' });
    if (user.isBlocked) throw Errors.forbidden({ reason: 'blocked' });

    const primaryProvider = (await inferPrimaryProvider(prisma, user.id)) ?? 'phone';

    return issueTokenPair(
      prisma,
      user.id,
      user.phone,
      user.roles as Role[],
      user.telegramId ? user.telegramId.toString() : null,
      primaryProvider,
      deviceInfo ?? stored.deviceInfo,
    );
  }

  async function logout(token: string): Promise<void> {
    const tokenHash = sha256Hex(token);
    await prisma.refreshToken.updateMany({
      where: { tokenHash, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  async function logoutAll(userId: string): Promise<void> {
    await prisma.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  // Stateless admin refresh — verifies the JWT signature and checks admin is still active.
  async function adminRefresh(token: string): Promise<AdminRefreshResult> {
    const decoded = verifyAdminRefreshToken(token);
    const admin = await prisma.admin.findUnique({ where: { id: decoded.sub } });
    if (!admin || !admin.isActive) throw Errors.unauthorized({ reason: 'admin_gone' });
    const accessToken = signAdminAccessToken({
      sub: admin.id,
      email: admin.email,
      role: admin.role as 'admin' | 'superadmin',
    });
    return { accessToken, accessTokenExpiresIn: env.JWT_ACCESS_TTL_MIN * 60 };
  }

  return { refresh, logout, logoutAll, adminRefresh };
}
