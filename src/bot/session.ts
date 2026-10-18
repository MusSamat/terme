import type { Prisma, PrismaClient } from '@prisma/client';

// Draft of the multi-step flow the chat is in. Stored as JSON in bot_sessions.
export interface Draft {
  flow?: 'findTrip' | 'needRide' | 'findPassengers' | 'publish' | 'airport' | 'book' | 'offer';
  step?: 'from' | 'to' | 'date' | 'time' | 'seats' | 'price' | 'comment' | 'flight' | 'car' | 'confirm' | 'airportDir' | 'airportPick';
  from?: number;
  to?: number | null;
  date?: string | null; // YYYY-MM-DD, Asia/Bishkek
  time?: string;
  seats?: number;
  maxSeats?: number;
  price?: number;
  comment?: string | null;
  flight?: string | null;
  carId?: string;
  point?: { lat: number; lng: number };
  airportDir?: 'to' | 'from';
  airportId?: number;
  cityId?: number;
  targetId?: string;
  cursor?: string | null;
}

// Drafts older than this are dropped — a stale half-filled flow is confusing.
const SESSION_TTL_MS = 6 * 60 * 60_000;

export function createSessionStore(prisma: PrismaClient) {
  async function get(telegramId: number): Promise<Draft> {
    const row = await prisma.botSession.findUnique({ where: { telegramId: BigInt(telegramId) } });
    if (!row || Date.now() - row.updatedAt.getTime() > SESSION_TTL_MS) return {};
    return (row.data ?? {}) as Draft;
  }

  async function set(telegramId: number, draft: Draft): Promise<void> {
    const data = draft as unknown as Prisma.InputJsonValue;
    const state = draft.flow && draft.step ? `${draft.flow}:${draft.step}` : null;
    await prisma.botSession.upsert({
      where: { telegramId: BigInt(telegramId) },
      update: { data, state },
      create: { telegramId: BigInt(telegramId), data, state },
    });
  }

  async function patch(telegramId: number, changes: Partial<Draft>): Promise<Draft> {
    const next = { ...(await get(telegramId)), ...changes };
    await set(telegramId, next);
    return next;
  }

  async function clear(telegramId: number): Promise<void> {
    await prisma.botSession.deleteMany({ where: { telegramId: BigInt(telegramId) } });
  }

  return { get, set, patch, clear };
}

export type SessionStore = ReturnType<typeof createSessionStore>;
