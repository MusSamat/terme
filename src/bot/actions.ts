import crypto from 'node:crypto';
import type { User } from '@prisma/client';
import { InlineKeyboard, type Context } from 'grammy';
import { TripCreateBody } from '@/modules/trips/trips.schemas.js';
import { BookingCreateBody } from '@/modules/bookings/bookings.schemas.js';
import { CreatePassengerRequestBody, RespondBody } from '@/modules/passenger-requests/passenger-requests.schemas.js';
import { errorText, isDriverMode, showMenu, type BotServices } from './context.js';
import type { Draft, SearchState } from './session.js';
import { TEXTS, langOf, type Lang } from './texts.js';
import { HTML, bishkekInstant, escapeHtml, formatWhen, mainMenu, placeName, withNav } from './format.js';
import { requestButtons, requestCard, tripButtons, tripCard } from './cards.js';

const PAGE = 5;

// A flexible request («время любое») departs at noon — or, later today, a bit
// from now so it is still in the future.
function flexibleDeparture(date: string): Date {
  const noon = bishkekInstant(date, '12:00');
  const soon = new Date(Date.now() + 60 * 60_000);
  const endOfDay = bishkekInstant(date, '23:30');
  return noon > soon ? noon : soon < endOfDay ? soon : endOfDay;
}

// Final actions of the flows. Inputs go through the API's own Zod schemas, then
// the same services the HTTP routes call.
export function createActions(svc: BotServices) {
  const tg = (ctx: Context): number => ctx.from!.id;

  async function finish(ctx: Context, user: User, d: Draft): Promise<void> {
    const l = langOf(user.language);
    const t = TEXTS[l];
    try {
      switch (d.flow) {
        case 'findTrip':
        case 'findPassengers': {
          const search: SearchState = {
            kind: d.flow === 'findPassengers' ? 'requests' : 'trips',
            from: d.from,
            to: d.to ?? null,
            date: d.date ?? null,
            airport: d.airportId !== undefined,
            cursor: null,
          };
          await runSearch(ctx, user, search, d.airportId !== undefined ? { airportId: d.airportId } : {});
          return;
        }
        case 'needRide': {
          const body = CreatePassengerRequestBody.parse({
            originCityId: d.from,
            destinationCityId: d.to,
            seatsNeeded: d.seats,
            departureDate: (d.time ? bishkekInstant(d.date!, d.time) : flexibleDeparture(d.date!)).toISOString(),
            flexible: !d.time,
            ...(d.comment ? { comment: d.comment } : {}),
            ...(d.flight ? { flightNumber: d.flight } : {}),
            ...(d.meetSign !== undefined ? { meetWithSign: d.meetSign } : {}),
            ...(d.luggage !== undefined ? { luggageCount: d.luggage } : {}),
            ...(d.point ? { originPoint: d.point } : {}),
          });
          await svc.requests.create(user.id, body);
          await done(ctx, user, t.requestPublished);
          return;
        }
        case 'publish': {
          const body = TripCreateBody.parse({
            originCityId: d.from,
            destinationCityId: d.to,
            carId: d.carId,
            departureAt: bishkekInstant(d.date!, d.time!).toISOString(),
            seatsTotal: d.seats,
            pricePerSeat: d.price,
            luggage: 'small',
            ...(d.comment ? { comment: d.comment } : {}),
            ...(d.point ? { originPoint: d.point } : {}),
          });
          await svc.trips().create(user.id, body, d.idem ?? crypto.randomUUID());
          await done(ctx, user, t.tripPublished);
          return;
        }
        case 'book': {
          const body = BookingCreateBody.parse({ tripId: d.targetId, seatsCount: d.seats });
          await svc.bookings().create(user.id, body, d.idem ?? crypto.randomUUID());
          await done(ctx, user, t.bookingSent);
          return;
        }
        case 'offer': {
          const body = RespondBody.parse({
            price: d.price,
            departureTime: bishkekInstant(d.date!, d.time!).toISOString(),
            ...(d.comment ? { message: d.comment } : {}),
          });
          await svc.responses().respond(user.id, d.targetId!, body);
          await done(ctx, user, t.offerSent);
          return;
        }
        default:
          return;
      }
    } catch (err) {
      // Never a dead end: step back to fix the input, or leave.
      await ctx.reply(errorText(err, l), { reply_markup: withNav(new InlineKeyboard(), l, true) });
    }
  }

  // Ends the flow but keeps the last search, so its «Показать ещё» still works.
  async function done(ctx: Context, user: User, text: string): Promise<void> {
    const { search } = await svc.session.get(tg(ctx));
    if (search) await svc.session.set(tg(ctx), { search });
    else await svc.session.clear(tg(ctx));
    await showMenu(ctx, user, text);
  }

  async function routeLabel(s: SearchState, l: Lang): Promise<string> {
    const ids = [s.from, s.to].filter((v): v is number => typeof v === 'number');
    const places = new Map((await svc.cities.byIds(ids)).map((p) => [p.id, p]));
    const name = (id: number | null | undefined, fallback: string) => {
      const p = id ? places.get(id) : undefined;
      return escapeHtml(p ? placeName(p, l) : fallback);
    };
    return `${name(s.from, '—')} → ${name(s.to, TEXTS[l].anyDirectionShort)}`;
  }

  async function fetchPage(
    s: SearchState,
    user: User,
    l: Lang,
  ): Promise<{ cards: Array<[string, InlineKeyboard]>; nextCursor: string | null; nearby?: boolean }> {
    // Airport searches rank the flight's day by closeness to the pickup time.
    const date = s.date && !s.target ? bishkekInstant(s.date, '12:00').toISOString() : undefined;
    const base = {
      from_id: s.from,
      to_id: s.to ?? undefined,
      date,
      ...(s.target ? { target_time: s.target } : {}),
      sort: 'time' as const,
      limit: PAGE,
      cursor: s.cursor ?? undefined,
    };
    if (s.kind === 'requests') {
      const p = await svc.requests.list(base, user.id);
      return { cards: p.data.map((r) => [requestCard(r, l), requestButtons(r, l)]), nextCursor: p.nextCursor, nearby: p.nearby };
    }
    const p = await svc.trips().search(
      {
        ...base,
        seats: 1,
        only_verified: false,
        women_only: false,
        no_smoking: false,
        pets: false,
        ...(s.airport ? { kind: 'airport' as const } : {}),
      },
      user.id,
    );
    return { cards: p.data.map((trip) => [tripCard(trip, l), tripButtons(trip, l)]), nextCursor: p.nextCursor, nearby: p.nearby };
  }

  // `preset`: what a «Нужна поездка» offered on an empty result starts with.
  async function runSearch(ctx: Context, user: User, s: SearchState, preset: Partial<Draft> = {}): Promise<void> {
    const l = langOf(user.language);
    const t = TEXTS[l];
    const first = s.cursor === null;
    const page = await fetchPage(s, user, l);

    if (page.cards.length === 0 && first) {
      if (s.kind === 'requests') {
        await svc.session.clear(tg(ctx));
        await showMenu(ctx, user, t.nothingFoundDriver);
        return;
      }
      // Nothing yet → offer to post a request with the same route.
      await svc.session.set(tg(ctx), { flow: 'needRide', from: s.from, to: s.to, ...preset });
      await ctx.reply(t.nothingFound, {
        reply_markup: new InlineKeyboard().text(t.menuNeedRide, 'go:needRide').row().text(t.cancel, 'x'),
      });
      return;
    }

    const search = { ...s, cursor: page.nextCursor };
    // A new search ends its flow; «more» keeps whatever flow is in progress.
    if (first) await svc.session.set(tg(ctx), { search });
    else await svc.session.patch(tg(ctx), { search });
    if (first) {
      // The header also restores the plain main menu (the 📍 button is no longer needed).
      const when = s.target
        ? formatWhen(s.target, l)
        : s.date
          ? formatWhen(bishkekInstant(s.date, '12:00'), l, false)
          : t.anyDate;
      const title = s.kind === 'requests' ? t.resultsRequests : t.resultsTrips;
      await ctx.reply(title(await routeLabel(s, l), when), { ...HTML, reply_markup: mainMenu(l, isDriverMode(user)) });
      if (page.nearby) await ctx.reply(t.nearbyNote);
    }
    for (const [text, kb] of page.cards) await ctx.reply(text, { ...HTML, reply_markup: kb });
    if (page.nextCursor) await ctx.reply(t.moreAsk, { reply_markup: new InlineKeyboard().text(t.more, 'more') });
  }

  /** «Показать ещё» — next page of the last search; false when there is none. */
  async function more(ctx: Context, user: User): Promise<boolean> {
    const { search } = await svc.session.get(tg(ctx));
    if (!search?.cursor) return false;
    await ctx.editMessageReplyMarkup().catch(() => undefined);
    await runSearch(ctx, user, search);
    return true;
  }

  return { finish, more, runSearch };
}
