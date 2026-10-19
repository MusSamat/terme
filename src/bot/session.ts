import type { Prisma, PrismaClient } from '@prisma/client';
import { createBotSessionsService } from '@/modules/botSessions/botSessions.service.js';

export type Flow = 'findTrip' | 'needRide' | 'findPassengers' | 'publish' | 'airport' | 'book' | 'offer' | 'link';
export type Step =
  | 'code'
  | 'from'
  | 'to'
  | 'date'
  | 'time'
  | 'seats'
  | 'price'
  | 'comment'
  | 'flight'
  | 'car'
  | 'confirm'
  | 'airportDir'
  | 'airportPick';

// Last search shown — survives a «book» / «offer» flow so «Показать ещё» keeps working.
export interface SearchState {
  kind: 'trips' | 'requests';
  from?: number;
  to?: number | null;
  date?: string | null;
  airport?: boolean;
  cursor: string | null;
}

// Draft of the multi-step flow the chat is in. Stored as JSON in bot_sessions.
export interface Draft {
  flow?: Flow;
  step?: Step;
  history?: Step[]; // steps actually asked, for «Назад»
  from?: number;
  to?: number | null;
  date?: string | null; // YYYY-MM-DD, Asia/Bishkek
  time?: string; // HH:MM; '' = flexible (passenger request)
  seats?: number;
  maxSeats?: number;
  price?: number;
  comment?: string | null;
  flight?: string | null;
  carId?: string;
  point?: { lat: number; lng: number };
  airportDir?: 'to' | 'from';
  airportId?: number;
  targetId?: string;
  idem?: string; // Idempotency-Key of this flow's create call — a double «Подтвердить» replays
  hintTime?: string; // offer: the time the passenger asked for
  search?: SearchState;
  phone?: string; // link flow: the number the WhatsApp code went to
}

// Drafts older than this are dropped — a stale half-filled flow is confusing.
const SESSION_TTL_MS = 6 * 60 * 60_000;

export function createSessionStore(prisma: PrismaClient) {
  const store = createBotSessionsService(prisma);

  async function get(telegramId: number): Promise<Draft> {
    const row = await store.load(telegramId);
    if (!row || Date.now() - row.updatedAt.getTime() > SESSION_TTL_MS) return {};
    return (row.data ?? {}) as Draft;
  }

  async function set(telegramId: number, draft: Draft): Promise<void> {
    // Round-trip drops keys set to undefined (how a step value is cleared).
    const data = JSON.parse(JSON.stringify(draft)) as Prisma.InputJsonValue;
    const state = draft.flow && draft.step ? `${draft.flow}:${draft.step}` : null;
    await store.save(telegramId, data, state);
  }

  async function patch(telegramId: number, changes: Partial<Draft>): Promise<Draft> {
    const next = { ...(await get(telegramId)), ...changes };
    await set(telegramId, next);
    return next;
  }

  async function clear(telegramId: number): Promise<void> {
    await store.remove(telegramId);
  }

  return { get, set, patch, clear };
}

export type SessionStore = ReturnType<typeof createSessionStore>;
