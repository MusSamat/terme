import type { Prisma, PrismaClient } from '@prisma/client';
import { cursorArgs, sliceAndNext } from '@/lib/pagination.js';
import type { Notifier } from '@/lib/notifier.js';

// ─── Tier thresholds (TZ §Этап 3) ───────────────────────────────────
export const TIERS = [
  { name: 'elite',     min: 600 },
  { name: 'expert',    min: 300 },
  { name: 'traveler',  min: 100 },
  { name: 'novice',    min: 0   },
] as const;

export type LoyaltyTier = (typeof TIERS)[number]['name'];

export const POINTS_PER_TRIP = 10;

export function tierForPoints(points: number): LoyaltyTier {
  for (const t of TIERS) {
    if (points >= t.min) return t.name;
  }
  return 'novice';
}

/**
 * Idempotently award trip-completion points to one participant, inside the
 * caller's transaction. Safe against double completion (manual complete() vs the
 * auto_complete cron) via the loyalty_transactions (userId, tripId, source)
 * UNIQUE — createMany({ skipDuplicates }) inserts the row at most once.
 *
 * Returns true only when a row was actually inserted (points/tier/totalTrips were
 * applied); false when it was a duplicate (nothing changed). totalTrips lives on
 * driver_profiles, so the bump is an updateMany — a no-op for passengers who have
 * no profile.
 */
export async function awardTripCompletion(
  tx: Prisma.TransactionClient,
  userId: string,
  tripId: string,
  points: number,
): Promise<boolean> {
  const { count } = await tx.loyaltyTransaction.createMany({
    data: [{ userId, tripId, points, source: 'trip_completed' }],
    skipDuplicates: true,
  });
  if (count !== 1) return false; // duplicate → already awarded

  const user = await tx.user.update({
    where: { id: userId },
    data: { loyaltyPoints: { increment: points } },
    select: { loyaltyPoints: true, loyaltyTier: true },
  });

  await tx.driverProfile.updateMany({
    where: { userId },
    data: { totalTrips: { increment: 1 } },
  });

  const newTier = tierForPoints(user.loyaltyPoints);
  if (newTier !== user.loyaltyTier) {
    await tx.user.update({ where: { id: userId }, data: { loyaltyTier: newTier } });
  }
  return true;
}

export interface LoyaltyStatus {
  points: number;
  tier: LoyaltyTier;
  nextTier: LoyaltyTier | null;
  pointsToNextTier: number | null;
}

export interface LoyaltyTransaction {
  id: string;
  points: number;
  source: string;
  tripId: string | null;
  note: string | null;
  createdAt: Date;
}

export interface LoyaltyService {
  getStatus(userId: string): Promise<LoyaltyStatus>;
  listTransactions(
    userId: string,
    query: { cursor?: string; limit: number },
  ): Promise<{ data: LoyaltyTransaction[]; nextCursor: string | null }>;
  /** Award points for a completed trip. Called by autoCompleteTrips cron. */
  awardTripPoints(
    userId: string,
    tripId: string,
    prismaOrTx?: PrismaClient,
  ): Promise<void>;
}

export function createLoyaltyService(prisma: PrismaClient, notifier: Notifier): LoyaltyService {
  async function getStatus(userId: string): Promise<LoyaltyStatus> {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { loyaltyPoints: true, loyaltyTier: true },
    });
    const points = user?.loyaltyPoints ?? 0;
    const tier = tierForPoints(points) as LoyaltyTier;

    const tierIndex = TIERS.findIndex((t) => t.name === tier);
    const nextTierDef = tierIndex > 0 ? TIERS[tierIndex - 1] : null;
    const nextTier = nextTierDef ? (nextTierDef.name as LoyaltyTier) : null;
    const pointsToNextTier = nextTierDef ? nextTierDef.min - points : null;

    return { points, tier, nextTier, pointsToNextTier };
  }

  async function listTransactions(
    userId: string,
    query: { cursor?: string; limit: number },
  ) {
    const rows = await prisma.loyaltyTransaction.findMany({
      where: { userId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      ...cursorArgs({ cursor: query.cursor, limit: query.limit }),
    });
    return sliceAndNext(
      rows.map((r) => ({
        id: r.id,
        points: r.points,
        source: r.source,
        tripId: r.tripId,
        note: r.note,
        createdAt: r.createdAt,
      })),
      query.limit,
    );
  }

  async function awardTripPoints(
    userId: string,
    tripId: string,
    tx?: PrismaClient,
  ): Promise<void> {
    // Read the tier before so we can fire the tier-change notification only when
    // an award actually happened (the helper is idempotent and returns false on
    // a duplicate). The helper persists points/tier/totalTrips atomically.
    const before = await (tx ?? prisma).user.findUnique({
      where: { id: userId },
      select: { loyaltyTier: true },
    });

    const awarded = tx
      ? await awardTripCompletion(tx, userId, tripId, POINTS_PER_TRIP)
      : await prisma.$transaction((t) => awardTripCompletion(t, userId, tripId, POINTS_PER_TRIP));
    if (!awarded) return;

    const after = await (tx ?? prisma).user.findUnique({
      where: { id: userId },
      select: { loyaltyPoints: true, loyaltyTier: true },
    });
    if (after && before && after.loyaltyTier !== before.loyaltyTier) {
      await notifier.loyaltyTierChanged(userId, {
        tier: after.loyaltyTier,
        points: after.loyaltyPoints,
      });
    }
  }

  return { getStatus, listTransactions, awardTripPoints };
}
