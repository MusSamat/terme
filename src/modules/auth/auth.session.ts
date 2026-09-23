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

// Grace window for refresh rotation: a token replayed within this window is
// treated as a legit client retry (concurrent refresh, or an app restart/update
// that killed the process before the rotated cookie was persisted). We return
// the SAME pair we already minted for that rotation instead of either minting a
// brand-new pair on every replay (H2 — token sprawl / weak single-use) or
// logging the user out (false positive). Outside the window, a replay of an
// already-rotated token is a real reuse → revoke everything.
const GRACE_MS = 60_000;

// In-memory replay cache: rotated tokenId → the pair we issued for it (+ when).
// Bounded and swept so it can't grow unbounded. A cache miss inside the grace
// window (e.g. after a process restart clears it) simply mints a fresh pair for
// that single rotation — still safe, just not deduplicated.
interface CachedPair {
  pair: TokenPair;
  at: number;
}
const replayCache = new Map<string, CachedPair>();
const REPLAY_CACHE_MAX = 5_000;

function cachePair(rotatedTokenId: string, pair: TokenPair): void {
  const now = Date.now();
  if (replayCache.size >= REPLAY_CACHE_MAX) {
    for (const [k, v] of replayCache) {
      if (now - v.at >= GRACE_MS) replayCache.delete(k);
    }
    // Still full of fresh entries → drop the oldest to bound memory.
    if (replayCache.size >= REPLAY_CACHE_MAX) {
      const oldest = replayCache.keys().next().value;
      if (oldest !== undefined) replayCache.delete(oldest);
    }
  }
  replayCache.set(rotatedTokenId, { pair, at: now });
}

function cachedPairWithinGrace(rotatedTokenId: string): TokenPair | null {
  const hit = replayCache.get(rotatedTokenId);
  if (!hit) return null;
  if (Date.now() - hit.at >= GRACE_MS) {
    replayCache.delete(rotatedTokenId);
    return null;
  }
  return hit.pair;
}

export function createSessionMethods(prisma: PrismaClient, notifier: Notifier) {
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

    const alreadyRotated = stored.usedAt != null || stored.revokedAt != null;
    const withinGrace =
      stored.usedAt != null && Date.now() - stored.usedAt.getTime() < GRACE_MS;

    if (alreadyRotated) {
      if (withinGrace) {
        // Legit retry: hand back the exact pair we already issued for this
        // rotation so the client converges on one token instead of spawning a
        // new pair on every replay.
        const cached = cachedPairWithinGrace(stored.id);
        if (cached) return cached;
        // Cache miss inside grace (e.g. after a restart) → fall through and mint
        // a single fresh pair for this rotation, then cache it.
      } else {
        // Real reuse: a token rotated long ago is being replayed → someone holds
        // a stolen/stale token. Revoke ALL of the user's refresh tokens and
        // reject. (TOKEN_REUSE_DETECTED — do not spam the user, just secure.)
        await prisma.refreshToken.updateMany({
          where: { userId: stored.userId, revokedAt: null },
          data: { revokedAt: new Date() },
        });
        replayCache.delete(stored.id);
        logger.warn(
          { userId: stored.userId, tokenId: stored.id, ip },
          'refresh token reuse detected — all sessions revoked',
        );
        // Real reuse outside the grace window — the grace window already absorbs
        // legit client retries, so this is a genuine security event worth a
        // one-off alert (not spam). Fire-and-forget so a notifier hiccup can't
        // turn the 401 into a 500.
        void notifier
          .securityAlertReuse(stored.userId, { reusedAt: new Date(), ip })
          .catch((err) => logger.error({ err, userId: stored.userId }, 'reuse alert failed'));
        throw Errors.unauthorized({ reason: 'token_reuse_detected', code: 'TOKEN_REUSE_DETECTED' });
      }
    }

    if (stored.expiresAt.getTime() <= Date.now()) {
      throw Errors.unauthorized({ reason: 'refresh_expired' });
    }

    if (!alreadyRotated) {
      const markRes = await prisma.refreshToken.updateMany({
        where: { id: stored.id, usedAt: null, revokedAt: null },
        data: { usedAt: new Date(), revokedAt: new Date() },
      });
      if (markRes.count !== 1) {
        // Lost the mark race by a hair — the winning refresh already rotated it
        // within the same tick. Prefer returning ITS cached pair so both callers
        // converge; if not yet cached, fall through and mint one for this tick.
        const cached = cachedPairWithinGrace(stored.id);
        if (cached) return cached;
        logger.warn(
          { userId: stored.userId, tokenId: stored.id },
          'refresh mark race — issuing fresh pair (grace)',
        );
      }
    }

    const user = await prisma.user.findUnique({ where: { id: stored.userId } });
    if (!user || user.deletedAt) throw Errors.unauthorized({ reason: 'user_gone' });
    if (user.isBlocked) throw Errors.forbidden({ reason: 'blocked' });

    const primaryProvider = (await inferPrimaryProvider(prisma, user.id)) ?? 'phone';

    const pair = await issueTokenPair(
      prisma,
      user.id,
      user.phone,
      user.roles as Role[],
      user.telegramId ? user.telegramId.toString() : null,
      primaryProvider,
      deviceInfo ?? stored.deviceInfo,
    );
    // Remember this rotation so a replay of `stored` inside the grace window
    // returns THIS pair rather than minting another.
    cachePair(stored.id, pair);
    return pair;
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

  // Admin refresh — verifies the JWT signature, checks the admin is still active,
  // and (M1) enforces a revocation epoch: any refresh token minted BEFORE the
  // admin row's last update (which includes password changes, see
  // adminChangePassword) is rejected. This makes admin refresh tokens revocable
  // on password change without a per-token store (no schema change): the JWT
  // `iat` is compared against admin.updatedAt.
  async function adminRefresh(token: string): Promise<AdminRefreshResult> {
    const decoded = verifyAdminRefreshToken(token);
    const admin = await prisma.admin.findUnique({ where: { id: decoded.sub } });
    if (!admin || !admin.isActive) throw Errors.unauthorized({ reason: 'admin_gone' });
    // `iat` is seconds; drop sub-second on updatedAt so same-second issuance
    // (sign right after the row's own update) isn't spuriously rejected.
    if (decoded.iat * 1000 < Math.floor(admin.updatedAt.getTime() / 1000) * 1000) {
      throw Errors.unauthorized({ reason: 'admin_refresh_revoked', code: 'TOKEN_REUSE_DETECTED' });
    }
    const accessToken = signAdminAccessToken({
      sub: admin.id,
      email: admin.email,
      role: admin.role as 'admin' | 'superadmin',
    });
    return { accessToken, accessTokenExpiresIn: env.JWT_ACCESS_TTL_MIN * 60 };
  }

  return { refresh, logout, logoutAll, adminRefresh };
}
