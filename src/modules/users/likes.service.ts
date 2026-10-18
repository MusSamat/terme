import type { PrismaClient } from '@prisma/client';
import { toListItem, tripInclude, type TripListItem } from '@/modules/trips/trips.service.js';
import {
  requestInclude,
  toDTO,
  type PassengerRequestDTO,
} from '@/modules/passenger-requests/passenger-requests.service.js';

// GET /users/me/likes — the «Избранное» list. Backs the web/app favorites
// screens; items are serialized with the exact same shape as the trips /
// passenger-requests list endpoints (liked is always true here).

export type LikeTargetType = 'trip' | 'passenger_request';

export interface LikedListResult {
  data: (TripListItem | PassengerRequestDTO)[];
  nextCursor: string | null;
}

export function createLikesService(prisma: PrismaClient) {
  /** Liked listings of one type, newest like first, cursor = listing_likes.id. */
  async function listLiked(
    userId: string,
    type: LikeTargetType,
    limit: number,
    cursor?: string,
  ): Promise<LikedListResult> {
    const likes = await prisma.listingLike.findMany({
      where: { userId, targetType: type },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: { id: true, targetId: true },
    });
    const hasMore = likes.length > limit;
    const page = hasMore ? likes.slice(0, limit) : likes;
    const ids = page.map((l) => l.targetId);

    let items: (TripListItem | PassengerRequestDTO)[] = [];
    if (ids.length > 0) {
      if (type === 'trip') {
        const rows = await prisma.trip.findMany({
          where: { id: { in: ids } },
          include: tripInclude,
        });
        const byId = new Map(rows.map((r) => [r.id, r]));
        // Preserve like order; skip listings that were deleted meanwhile.
        items = page.flatMap((l) => {
          const row = byId.get(l.targetId);
          return row ? [toListItem(row, { liked: true })] : [];
        });
      } else {
        const rows = await prisma.passengerRequest.findMany({
          where: { id: { in: ids } },
          include: requestInclude,
        });
        const byId = new Map(rows.map((r) => [r.id, r]));
        items = page.flatMap((l) => {
          const row = byId.get(l.targetId);
          return row ? [toDTO(row, { liked: true })] : [];
        });
      }
    }

    return {
      data: items,
      nextCursor: hasMore ? (page[page.length - 1]?.id ?? null) : null,
    };
  }

  return { listLiked };
}

export type LikesService = ReturnType<typeof createLikesService>;
