import type { PrismaClient, User } from '@prisma/client';
import { InlineKeyboard, type Context } from 'grammy';
import type { BookingDTO } from '@/modules/bookings/bookings.service.js';
import type { TripListItem } from '@/modules/trips/trips.service.js';
import { showMenu, type BotServices } from './context.js';
import { TEXTS, langOf, type Lang } from './texts.js';
import { HTML, escapeHtml, formatWhen, placeName, waLink } from './format.js';

const LIVE_BOOKING = new Set(['pending', 'viewed', 'accepted']);
const SECTION_LIMIT = 10; // cards per section — keeps the chat readable

// «Мои»: an overview with one button per non-empty section, then cards with
// one-tap actions (cancel / accept / decline). Actions live in my.actions.ts.
export function createMy(prisma: PrismaClient, svc: BotServices) {
  async function load(user: User) {
    const [bookings, requests, active, inTransit] = await Promise.all([
      svc.bookings().listMy(user.id, { limit: 50 }),
      svc.requests.listMy(user.id),
      svc.trips().myTrips(user.id, { tab: 'active', limit: SECTION_LIMIT }),
      svc.trips().myTrips(user.id, { tab: 'in_transit', limit: SECTION_LIMIT }),
    ]);
    return {
      bookings: bookings.data.filter((b) => LIVE_BOOKING.has(b.status)).slice(0, SECTION_LIMIT),
      requests: requests.data.filter((r) => r.status === 'open').slice(0, SECTION_LIMIT),
      trips: [...inTransit.data, ...active.data].slice(0, SECTION_LIMIT),
    };
  }

  // Pending booking requests per trip (one service call, no per-trip queries).
  async function waitingByTrip(user: User): Promise<Map<string, number>> {
    const incoming = (await svc.bookings().listIncoming(user.id, { limit: 50 })).data;
    const map = new Map<string, number>();
    for (const b of incoming) map.set(b.tripId, (map.get(b.tripId) ?? 0) + 1);
    return map;
  }

  async function show(ctx: Context, user: User): Promise<void> {
    const t = TEXTS[langOf(user.language)];
    const { bookings, requests, trips } = await load(user);
    if (bookings.length + requests.length + trips.length === 0) return showMenu(ctx, user, t.myEmpty);
    const waiting = trips.length ? [...(await waitingByTrip(user)).values()].reduce((a, b) => a + b, 0) : 0;
    const kb = new InlineKeyboard();
    if (bookings.length) kb.text(t.myBookings(bookings.length), 'my:b').row();
    if (requests.length) kb.text(t.myRequests(requests.length), 'my:r').row();
    if (trips.length) kb.text(t.myTrips(trips.length, waiting), 'my:t').row();
    await ctx.reply(t.myTitle, { ...HTML, reply_markup: kb });
  }

  async function section(ctx: Context, user: User, which: string): Promise<boolean> {
    const l = langOf(user.language);
    const data = await load(user);
    if (which === 'b') return render(ctx, l, data.bookings.map((b) => bookingCard(b, l)));
    if (which === 'r') {
      const counts = await prisma.passengerRequestResponse.groupBy({
        by: ['requestId'],
        where: { requestId: { in: data.requests.map((r) => r.id) }, status: 'pending' },
        _count: { _all: true },
      });
      const offers = new Map(counts.map((c) => [c.requestId, c._count._all]));
      return render(
        ctx,
        l,
        data.requests.map((r) => {
          const kb = new InlineKeyboard();
          const n = offers.get(r.id) ?? 0;
          if (n > 0) kb.text(TEXTS[l].offers(n), `of:${r.id}`).row();
          kb.text(TEXTS[l].cancelRequest, `cr:${r.id}`);
          const route = `${escapeHtml(placeName(r.origin, l))} → ${escapeHtml(placeName(r.destination, l))}`;
          const when = `${formatWhen(r.departureDate, l, !r.flexible)}${r.flexible ? ` · ${TEXTS[l].flexibleLabel}` : ''}`;
          return [`🙋 <b>${route}</b>\n🕒 ${when} · 👥 ${r.seatsNeeded}`, kb];
        }),
      );
    }
    if (which === 't') {
      const waiting = await waitingByTrip(user);
      return render(ctx, l, data.trips.map((trip) => tripCard(trip, l, waiting.get(trip.id) ?? 0)));
    }
    return false;
  }

  async function render(ctx: Context, l: Lang, cards: Array<[string, InlineKeyboard]>): Promise<boolean> {
    if (cards.length === 0) await ctx.reply(TEXTS[l].sectionEmpty);
    for (const [text, kb] of cards) await ctx.reply(text, { ...HTML, reply_markup: kb });
    return true;
  }

  return { show, section };
}

function bookingCard(b: BookingDTO, l: Lang): [string, InlineKeyboard] {
  const t = TEXTS[l];
  const phone = b.status === 'accepted' ? (b.trip.driver.phone ?? null) : null;
  const kb = new InlineKeyboard();
  if (phone) kb.url(t.writeWhatsapp, waLink(phone)).row();
  kb.text(t.cancelBooking, `cb:${b.id}`);
  const text = [
    `🎫 <b>${escapeHtml(b.trip.originCity)} → ${escapeHtml(b.trip.destinationCity)}</b>`,
    `🕒 ${formatWhen(b.trip.departureAt, l)} · 💺 ${b.seatsCount} · 💰 ${b.pricePerSeatSnapshot} ${t.som}`,
    t.personLine(escapeHtml(b.trip.driver.name), phone),
    t.bookingStatus[b.status] ?? b.status,
  ].join('\n');
  return [text, kb];
}

function tripCard(trip: TripListItem, l: Lang, waiting: number): [string, InlineKeyboard] {
  const t = TEXTS[l];
  const departed = new Date(trip.departureAt).getTime() <= Date.now();
  const kb = new InlineKeyboard();
  if (waiting > 0) kb.text(t.incoming(waiting), `in:${trip.id}`).row();
  // Departed → the driver finishes it; before that it can still be cancelled.
  kb.text(departed ? t.completeTrip : t.cancelTrip, `${departed ? 'tf' : 'ct'}:${trip.id}`);
  const text = [
    `🚗 <b>${escapeHtml(placeName(trip.origin, l))} → ${escapeHtml(placeName(trip.destination, l))}</b>${departed ? ` · ${t.inTransit}` : ''}`,
    `🕒 ${formatWhen(trip.departureAt, l)} · 💺 ${trip.seatsAvailable}/${trip.seatsTotal} · 💰 ${trip.pricePerSeat} ${t.som}`,
  ].join('\n');
  return [text, kb];
}
