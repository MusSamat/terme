import type { PrismaClient } from '@prisma/client';
import { logger } from '@/lib/logger.js';

// Platforms we attribute presence to. Header `X-Client-Platform` carries it.
export type Platform = 'web' | 'mini' | 'mobile';
const PLATFORMS: readonly Platform[] = ['web', 'mini', 'mobile'];

export function normalizePlatform(raw: string | undefined | null): Platform | null {
  if (!raw) return null;
  const v = raw.toLowerCase().trim();
  return (PLATFORMS as readonly string[]).includes(v) ? (v as Platform) : null;
}

// Tunables (env-overridable). These vars are NOT in src/config/env.ts's zod
// schema, so a typo (e.g. PRESENCE_WINDOW_SEC="6o") would make Number() → NaN
// and silently break the cutoffs. Parse defensively: fall back to the default
// and warn if the override is present but not a positive number.
function envSec(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    logger.warn({ env: name, raw, fallback }, 'invalid presence tunable — using default');
    return fallback;
  }
  return n;
}

const WINDOW_SEC = envSec('PRESENCE_WINDOW_SEC', 60); // "online" = seen within this
const THROTTLE_SEC = envSec('PRESENCE_THROTTLE_SEC', 20); // skip redundant writes
const CACHE_MS = envSec('PRESENCE_CACHE_MS', 10_000); // online-count in-memory cache

export interface PresenceService {
  ping(userId: string, platform: Platform | null): Promise<void>;
  onlineCount(): Promise<number>;
}

export function createPresenceService(prisma: PrismaClient): PresenceService {
  // Process-local cache so the public /online endpoint hits the DB at most once
  // per CACHE_MS regardless of request volume.
  let cache: { value: number; at: number } | null = null;

  async function ping(userId: string, platform: Platform | null): Promise<void> {
    const now = new Date();
    const cutoff = new Date(now.getTime() - THROTTLE_SEC * 1000);
    // Throttled, single-statement write: updates at most once per THROTTLE_SEC
    // per user (WHERE last_seen_at < cutoff). One indexed UPDATE by PK — cheap.
    await prisma.user.updateMany({
      where: {
        id: userId,
        deletedAt: null,
        OR: [{ lastSeenAt: null }, { lastSeenAt: { lt: cutoff } }],
      },
      data: { lastSeenAt: now, ...(platform ? { lastPlatform: platform } : {}) },
    });
  }

  async function onlineCount(): Promise<number> {
    const now = Date.now();
    if (cache && now - cache.at < CACHE_MS) return cache.value;
    const since = new Date(now - WINDOW_SEC * 1000);
    const value = await prisma.user.count({
      where: { deletedAt: null, lastSeenAt: { gte: since } },
    });
    cache = { value, at: now };
    return value;
  }

  return { ping, onlineCount };
}
