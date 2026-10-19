import type { User } from '@prisma/client';
import { InlineKeyboard, type Context } from 'grammy';
import { errorText, type BotServices } from './context.js';
import type { Draft, Flow } from './session.js';
import { TEXTS, langOf } from './texts.js';
import { HTML, bishkekDate, bishkekTime, escapeHtml, waLink } from './format.js';

interface FlowStarter {
  start(ctx: Context, user: User, flow: Flow, preset?: Partial<Draft>): Promise<void>;
  replyNoCar(ctx: Context, user: User): Promise<void>;
}

// Buttons under search-result cards: contact, book a trip, offer a ride.
export function createListing(svc: BotServices, flows: FlowStarter) {
  async function revealContact(ctx: Context, user: User, kind: 'trip' | 'request', id: string): Promise<void> {
    const l = langOf(user.language);
    const c = kind === 'trip' ? await svc.contacts.revealForTrip(id, user.id) : await svc.contacts.revealForRequest(id, user.id);
    await ctx.reply(TEXTS[l].contactCard(escapeHtml(c.name), c.phone), {
      ...HTML,
      reply_markup: new InlineKeyboard().url(TEXTS[l].writeWhatsapp, waLink(c.phone)),
    });
  }

  // Obvious dead ends are answered up front; the service still enforces every rule.
  async function startBooking(ctx: Context, user: User, tripId: string): Promise<void> {
    const t = TEXTS[langOf(user.language)];
    const trip = await svc.trips().getById(tripId, user.id);
    const blocker =
      trip.driverId === user.id
        ? 'cannot_book_own_trip'
        : trip.status !== 'active'
          ? 'TRIP_NOT_ACTIVE'
          : trip.seatsAvailable < 1
            ? 'SEATS_NOT_AVAILABLE'
            : null;
    if (blocker) return void (await ctx.reply(t.errors[blocker] ?? t.error));
    await flows.start(ctx, user, 'book', {
      targetId: tripId,
      maxSeats: trip.seatsAvailable,
      from: trip.originCityId,
      to: trip.destinationCityId,
      date: bishkekDate(trip.departureAt),
      time: bishkekTime(trip.departureAt),
      price: trip.pricePerSeat,
    });
  }

  async function startOffer(ctx: Context, user: User, requestId: string): Promise<void> {
    const t = TEXTS[langOf(user.language)];
    const req = await svc.requests.getById(requestId, user.id);
    if (req.passengerId === user.id) return void (await ctx.reply(t.errors['cannot_respond_to_own_request'] ?? t.error));
    if (req.myResponse?.status === 'pending') return void (await ctx.reply(t.alreadyOffered));
    if ((await svc.cars.listMy(user.id)).length === 0) return flows.replyNoCar(ctx, user);
    await flows.start(ctx, user, 'offer', {
      targetId: requestId,
      from: req.originCityId,
      to: req.destinationCityId,
      date: bishkekDate(req.departureDate),
      ...(req.flexible ? {} : { hintTime: bishkekTime(req.departureDate) }),
    });
  }

  /** Handles tc / rc / tb / ro buttons; false for anything else. */
  async function onCallback(ctx: Context, user: User, data: string): Promise<boolean> {
    if (data[2] !== ':') return false;
    const id = data.slice(3);
    const l = langOf(user.language);
    const run: Record<string, () => Promise<void>> = {
      tc: () => revealContact(ctx, user, 'trip', id),
      rc: () => revealContact(ctx, user, 'request', id),
      tb: () => startBooking(ctx, user, id),
      ro: () => startOffer(ctx, user, id),
    };
    const action = run[data.slice(0, 2)];
    if (!action) return false;
    await action().catch(async (err: unknown) => {
      await ctx.reply(errorText(err, l));
    });
    return true;
  }

  return { onCallback };
}
