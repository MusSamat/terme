import { z } from 'zod';

/**
 * Cursor pagination helper — matches TZ §19.1 "Cursor-based: ?cursor=xxx&limit=20".
 * The cursor is the opaque id of the last item from the previous page.
 */

export const CursorPaginationQuery = z.object({
  cursor: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

export type CursorPaginationInput = z.infer<typeof CursorPaginationQuery>;

/**
 * Build Prisma args for the common pattern: take+1 to detect "has more",
 * optional cursor with skip:1 to exclude the cursor row itself.
 */
export function cursorArgs(input: CursorPaginationInput): {
  take: number;
  cursor?: { id: string };
  skip?: number;
} {
  const take = input.limit + 1;
  if (input.cursor) {
    return { take, cursor: { id: input.cursor }, skip: 1 };
  }
  return { take };
}

export function sliceAndNext<T extends { id: string }>(
  rows: T[],
  limit: number,
): { data: T[]; nextCursor: string | null } {
  const hasMore = rows.length > limit;
  const data = hasMore ? rows.slice(0, limit) : rows;
  return {
    data,
    nextCursor: hasMore ? (data[data.length - 1]?.id ?? null) : null,
  };
}

// Search lists page three ways: id cursors (time / price / rating sorts),
// 'o_<offset>' (sort=nearest) and 't_<offset>' (target_time ranking).
type SearchMode = 'id' | 'o_' | 't_';
export function searchMode(q: { target_time?: string; sort?: string }): SearchMode {
  return q.target_time ? 't_' : q.sort === 'nearest' ? 'o_' : 'id';
}
export function cursorMode(cursor: string): SearchMode {
  return cursor.startsWith('o_') ? 'o_' : cursor.startsWith('t_') ? 't_' : 'id';
}
