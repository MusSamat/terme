import crypto from 'node:crypto';
import type { User } from '@prisma/client';
import { InlineKeyboard, type Context } from 'grammy';
import type { PlaceRef } from '@/lib/places.js';
import type { TripCardItem } from '@/modules/trips/trips.service.js';
import type { PassengerRequestCardItem } from '@/modules/passenger-requests/passenger-requests.service.js';
import { errorText, isDriverMode, showMenu, type BotServices } from './context.js';
import type { Draft } from './session.js';
import { TEXTS, langOf, type Lang } from './texts.js';
import {
  HAS_WEB_LINKS,
  bishkekInstant,
  escapeHtml,
  formatWhen,
  nextDays,
  placeLabel,
  placeName,
  placeStepKeyboard,
  waLink,
  webLink,
} from './format.js';

type Step = NonNullable<Draft['step']>;
type Flow = NonNullable<Draft['flow']>;

const SEARCH_FLOWS = new Set<Flow>(['findTrip', 'findPassengers', 'airport']);

// A flexible request («время любое») departs at noon — or, later today, a bit
// from now so it is still in the future.
function flexibleDeparture(date: string): Date {
  const noon = bishkekInstant(date, '12:00');
  const soon = new Date(Date.now() + 60 * 60_000);
  const endOfDay = bishkekInstant(date, '23:30');
  return noon > soon ? noon : soon < endOfDay ? soon : endOfDay;
}

// Step order per flow; a step is skipped when its value is already in the draft.
const ORDER: Record<Flow, Step[]> = {
  findTrip: ['from', 'to', 'date'],
  findPassengers: ['from', 'to', 'date'],
  needRide: ['from', 'to', 'date', 'time', 'seats', 'flight', 'comment', 'confirm'],
  publish: ['car', 'from', 'to', 'date', 'time', 'seats', 'price', 'comment', 'confirm'],
  airport: ['airportDir', 'airportPick', 'date'],
  book: ['seats'],
  offer: ['date', 'time', 'price', 'comment', 'confirm'],
  link: ['code'], // handled in index.ts (sign-in), never advanced here
};

const PAGE = 5;

function filled(d: Draft, step: Step): boolean {
  switch (step) {
    case 'from':
      return d.from !== undefined;
    case 'to':
      return d.to !== undefined;
    case 'date':
      return d.date !== undefined;
    case 'time':
      return d.time !== undefined;
    case 'seats':
      return d.seats !== undefined;
    case 'price':
      return d.price !== undefined;
    case 'comment':
      return d.comment !== undefined;
    // Flight number only matters for airport transfers.
    case 'flight':
      return d.flight !== undefined || d.airportId === undefined;
    case 'car':
      return d.carId !== undefined;
    case 'airportDir':
      return d.airportDir !== undefined;
    case 'airportPick':
      return d.airportId !== undefined;
    case 'confirm':
    case 'code':
      return false;
  }
}

export function createFlows(svc: BotServices) {
  const lang = (u: User): Lang => langOf(u.language);
  const tg = (ctx: Context): number => ctx.from!.id;

  async function start(ctx: Context, user: User, flow: Flow, preset: Partial<Draft> = {}): Promise<void> {
    await svc.session.set(tg(ctx), { flow, ...preset });
    await advance(ctx, user);
  }

  // Moves to the first unfilled step and asks for it; runs the action at the end.
  async function advance(ctx: Context, user: User): Promise<void> {
    const d = await svc.session.get(tg(ctx));
    if (!d.flow) return showMenu(ctx, user);
    const step = ORDER[d.flow].find((s) => !filled(d, s));
    if (!step) return finish(ctx, user, d);
    await svc.session.set(tg(ctx), { ...d, step });
    await ask(ctx, user, { ...d, step });
  }

  async function ask(ctx: Context, user: User, d: Draft): Promise<void> {
    const l = lang(user);
    const t = TEXTS[l];
    const html = { parse_mode: 'HTML' as const };
    switch (d.step) {
      case 'from':
      case 'to': {
        const quick = await svc.cities.top(6);
        const anyAllowed = d.step === 'to' && d.flow === 'findPassengers';
        await ctx.reply(d.step === 'from' ? t.askFrom : anyAllowed ? t.askToOptional : t.askTo, {
          ...html,
          reply_markup: placeStepKeyboard(l, quick.filter((p) => p.id !== d.from), anyAllowed),
        });
        if (d.step === 'from') {
          await ctx.reply('👇', {
            reply_markup: { keyboard: [[{ text: t.myLocation, request_location: true }]], resize_keyboard: true, one_time_keyboard: true },
          });
        }
        return;
      }
      case 'date': {
        const kb = new InlineKeyboard();
        nextDays(l).forEach(([iso, label], i) => {
          kb.text(label, `d:${iso}`);
          if (i % 3 === 2) kb.row();
        });
        kb.row();
        if (d.flow === 'findTrip' || d.flow === 'findPassengers' || d.flow === 'airport') kb.text(t.anyDate, 'd:any');
        kb.text(t.cancel, 'x');
        await ctx.reply(t.askDate, { ...html, reply_markup: kb });
        return;
      }
      case 'time': {
        const kb = new InlineKeyboard();
        ['05:00', '06:00', '07:00', '08:00', '09:00', '10:00', '12:00', '14:00', '16:00', '18:00', '20:00', '22:00'].forEach((h, i) => {
          kb.text(h, `t:${h}`);
          if (i % 4 === 3) kb.row();
        });
        kb.row();
        // A passenger may not know the exact time yet → «flexible».
        if (d.flow === 'needRide') kb.text(t.skip, 'sk');
        kb.text(t.cancel, 'x');
        await ctx.reply(t.askTime, { ...html, reply_markup: kb });
        return;
      }
      case 'seats': {
        const max = d.flow === 'book' ? Math.min(d.maxSeats ?? 4, 4) : d.flow === 'publish' ? (d.maxSeats ?? 4) : 6;
        const kb = new InlineKeyboard();
        for (let n = 1; n <= max; n++) kb.text(String(n), `n:${n}`);
        kb.row().text(t.cancel, 'x');
        const prompt = d.flow === 'publish' ? t.askSeatsTrip : d.flow === 'book' ? t.askSeatsBook : t.askSeatsRequest;
        await ctx.reply(prompt, { ...html, reply_markup: kb });
        return;
      }
      case 'price': {
        const from = d.flow === 'offer' ? null : d.from;
        const hint =
          from && d.to ? (await svc.trips().priceSuggestion(from, d.to).catch(() => null))?.averagePrice ?? null : null;
        const kb = new InlineKeyboard();
        if (hint) kb.text(`${hint} ${t.som}`, `p:${hint}`);
        kb.text(t.cancel, 'x');
        await ctx.reply(t.askPrice(hint), { ...html, reply_markup: kb });
        return;
      }
      case 'comment':
        await ctx.reply(t.askComment, { reply_markup: new InlineKeyboard().text(t.skip, 'sk').text(t.cancel, 'x') });
        return;
      case 'flight':
        await ctx.reply(t.askFlight, { reply_markup: new InlineKeyboard().text(t.skip, 'sk').text(t.cancel, 'x') });
        return;
      case 'car': {
        const cars = await svc.cars.listMy(user.id);
        if (cars.length === 0) {
          await svc.session.clear(tg(ctx));
          const kb = HAS_WEB_LINKS ? new InlineKeyboard().url(t.openSite, webLink('/profile/cars')) : undefined;
          await ctx.reply(t.noCar, kb ? { reply_markup: kb } : undefined);
          return;
        }
        if (cars.length === 1) {
          await svc.session.patch(tg(ctx), { carId: cars[0]!.id, maxSeats: cars[0]!.seatsCount });
          return advance(ctx, user);
        }
        const kb = new InlineKeyboard();
        for (const c of cars) kb.text(`${c.make} ${c.model} · ${c.plate}`, `car:${c.id}`).row();
        await ctx.reply(t.chooseCar, { reply_markup: kb.text(t.cancel, 'x') });
        return;
      }
      case 'airportDir':
        await ctx.reply(t.airportAsk, {
          ...html,
          reply_markup: new InlineKeyboard().text(t.toAirport, 'ad:to').text(t.fromAirport, 'ad:from').row().text(t.cancel, 'x'),
        });
        return;
      case 'airportPick': {
        const kb = new InlineKeyboard();
        for (const a of await svc.cities.airports()) kb.text(placeName(a, l), `ap:${a.id}`).row();
        await ctx.reply(t.pickAirport, { reply_markup: kb.text(t.cancel, 'x') });
        return;
      }
      case 'confirm':
        await ctx.reply(await summary(user, d), {
          ...html,
          reply_markup: new InlineKeyboard().text(t.confirm, 'ok').text(t.cancel, 'x'),
        });
        return;
    }
  }

  async function placeOf(id: number | null | undefined): Promise<PlaceRef | null> {
    if (!id) return null;
    const [p] = await svc.cities.byIds([id]);
    return p ?? null;
  }

  async function summary(user: User, d: Draft): Promise<string> {
    const l = lang(user);
    const t = TEXTS[l];
    const [from, to] = await Promise.all([placeOf(d.from), placeOf(d.to ?? null)]);
    const lines = [
      `<b>${from ? escapeHtml(placeName(from, l)) : '—'} → ${to ? escapeHtml(placeName(to, l)) : '—'}</b>`,
      d.date ? `🕒 ${formatWhen(bishkekInstant(d.date, d.time || '12:00'), l, Boolean(d.time))}` : '',
      d.seats ? `💺 ${t.seatsLeft(d.seats)}` : '',
      d.price ? `💰 ${d.price} ${t.som}` : '',
      d.flight ? `✈️ ${escapeHtml(d.flight)}` : '',
      d.comment ? `💬 ${escapeHtml(d.comment)}` : '',
    ];
    return lines.filter(Boolean).join('\n');
  }

  // ─── Inputs ─────────────────────────────────────────────────────────
  async function onText(ctx: Context, user: User, text: string): Promise<boolean> {
    const d = await svc.session.get(tg(ctx));
    if (!d.flow || !d.step) return false;
    const t = TEXTS[lang(user)];
    switch (d.step) {
      case 'from':
      case 'to': {
        const found = await svc.cities.search(text, 6);
        if (found.length === 0) {
          await ctx.reply(t.noPlaces);
          return true;
        }
        const kb = new InlineKeyboard();
        for (const p of found) kb.text(placeLabel(p, lang(user)), `pl:${p.id}`).row();
        await ctx.reply(t.pickPlace, { reply_markup: kb.text(t.cancel, 'x') });
        return true;
      }
      case 'time': {
        const m = /^([01]?\d|2[0-3])[:.\s]?([0-5]\d)$/.exec(text.trim());
        if (!m) {
          await ctx.reply(t.badTime);
          return true;
        }
        await svc.session.patch(tg(ctx), { time: `${m[1]!.padStart(2, '0')}:${m[2]}` });
        break;
      }
      case 'price': {
        const n = Number(text.replace(/\s|сом/gi, ''));
        if (!Number.isInteger(n) || n < 50 || n > 10_000) {
          await ctx.reply(t.badPrice);
          return true;
        }
        await svc.session.patch(tg(ctx), { price: n });
        break;
      }
      case 'comment':
        await svc.session.patch(tg(ctx), { comment: text.slice(0, 300) });
        break;
      case 'flight': {
        const f = text.trim().toUpperCase();
        if (!/^[A-Z0-9]{2}\s?\d{1,4}[A-Z]?$/.test(f)) {
          await ctx.reply(t.badFlight);
          return true;
        }
        await svc.session.patch(tg(ctx), { flight: f });
        break;
      }
      default:
        return false;
    }
    await advance(ctx, user);
    return true;
  }

  async function onLocation(ctx: Context, user: User, lat: number, lng: number): Promise<void> {
    const d = await svc.session.get(tg(ctx));
    if (d.step !== 'from' && d.step !== 'to') return showMenu(ctx, user);
    const place = await svc.cities.nearest(lat, lng).catch(() => null);
    if (!place) {
      await ctx.reply(TEXTS[lang(user)].noPlaces);
      return;
    }
    // The shared location doubles as the exact meeting point.
    await svc.session.patch(tg(ctx), { [d.step]: place.id, ...(d.step === 'from' ? { point: { lat, lng } } : {}) });
    await ctx.reply(`📍 ${placeLabel(place, lang(user))}`, { reply_markup: { remove_keyboard: true } });
    await advance(ctx, user);
  }

  async function onCallback(ctx: Context, user: User, data: string): Promise<boolean> {
    const d = await svc.session.get(tg(ctx));
    const [key, value] = [data.split(':')[0], data.slice(data.indexOf(':') + 1)];
    switch (key) {
      case 'x':
        await svc.session.clear(tg(ctx));
        await showMenu(ctx, user, TEXTS[lang(user)].cancelled);
        return true;
      case 'pl':
        if (d.step !== 'from' && d.step !== 'to') return false;
        await svc.session.patch(tg(ctx), { [d.step]: value === 'any' ? null : Number(value) });
        break;
      case 'd':
        // «Any date» only exists in search flows.
        if (d.step !== 'date' || (value === 'any' && !SEARCH_FLOWS.has(d.flow!))) return false;
        await svc.session.patch(tg(ctx), { date: value === 'any' ? null : value });
        break;
      case 't':
        if (d.step !== 'time') return false;
        await svc.session.patch(tg(ctx), { time: value });
        break;
      case 'n':
        if (d.step !== 'seats') return false;
        await svc.session.patch(tg(ctx), { seats: Number(value) });
        break;
      case 'p':
        if (d.step !== 'price') return false;
        await svc.session.patch(tg(ctx), { price: Number(value) });
        break;
      case 'sk':
        if (!(d.step === 'flight' || d.step === 'comment' || (d.step === 'time' && d.flow === 'needRide'))) return false;
        await svc.session.patch(
          tg(ctx),
          d.step === 'flight' ? { flight: null } : d.step === 'time' ? { time: '' } : { comment: null },
        );
        break;
      case 'car': {
        if (d.step !== 'car') return false;
        const car = (await svc.cars.listMy(user.id)).find((c) => c.id === value);
        if (!car) return false;
        await svc.session.patch(tg(ctx), { carId: car.id, maxSeats: car.seatsCount });
        break;
      }
      case 'ad':
        if (d.step !== 'airportDir') return false;
        await svc.session.patch(tg(ctx), { airportDir: value === 'from' ? 'from' : 'to' });
        break;
      case 'ap':
        if (d.step !== 'airportPick') return false;
        await onAirportPicked(ctx, user, d, Number(value));
        return true;
      case 'ok':
        if (d.step !== 'confirm') return false;
        await finish(ctx, user, d);
        return true;
      case 'more':
        await runSearch(ctx, user, d, true);
        return true;
      default:
        return false;
    }
    await advance(ctx, user);
    return true;
  }

  // Airport: the served city is the other end; drivers publish, passengers search.
  async function onAirportPicked(ctx: Context, user: User, d: Draft, airportId: number): Promise<void> {
    const airport = (await svc.cities.airports()).find((a) => a.id === airportId);
    if (!airport) return;
    const city = airport.serves?.id;
    const to = d.airportDir === 'from' ? city : airportId;
    const from = d.airportDir === 'from' ? airportId : city;
    await start(ctx, user, isDriverMode(user) ? 'publish' : 'findTrip', { from, to, airportId });
  }

  // ─── Final actions ──────────────────────────────────────────────────
  async function finish(ctx: Context, user: User, d: Draft): Promise<void> {
    const l = lang(user);
    const t = TEXTS[l];
    try {
      switch (d.flow) {
        case 'findTrip':
        case 'findPassengers':
          await runSearch(ctx, user, d, false);
          return;
        case 'needRide':
          await svc.requests.create(user.id, {
            originCityId: d.from!,
            destinationCityId: d.to!,
            seatsNeeded: d.seats!,
            departureDate: (d.time ? bishkekInstant(d.date!, d.time) : flexibleDeparture(d.date!)).toISOString(),
            flexible: !d.time,
            ...(d.comment ? { comment: d.comment } : {}),
            ...(d.flight ? { flightNumber: d.flight } : {}),
            ...(d.point ? { originPoint: d.point } : {}),
          });
          await svc.session.clear(tg(ctx));
          await showMenu(ctx, user, t.requestPublished);
          return;
        case 'publish':
          await svc.trips().create(
            user.id,
            {
              originCityId: d.from!,
              destinationCityId: d.to!,
              carId: d.carId,
              pickupCityIds: [],
              dropoffCityIds: [],
              departureAt: bishkekInstant(d.date!, d.time!).toISOString(),
              departureFlexible: false,
              seatsTotal: d.seats!,
              pricePerSeat: d.price!,
              priceNegotiable: false,
              luggage: 'small',
              preferences: {},
              ...(d.comment ? { comment: d.comment } : {}),
              ...(d.point ? { originPoint: d.point } : {}),
            },
            crypto.randomUUID(),
          );
          await svc.session.clear(tg(ctx));
          await showMenu(ctx, user, t.tripPublished);
          return;
        case 'book':
          await svc.bookings().create(user.id, { tripId: d.targetId!, seatsCount: d.seats! }, crypto.randomUUID());
          await svc.session.clear(tg(ctx));
          await showMenu(ctx, user, t.bookingSent);
          return;
        case 'offer':
          await svc.responses().respond(user.id, d.targetId!, {
            price: d.price!,
            departureTime: bishkekInstant(d.date!, d.time!).toISOString(),
            ...(d.comment ? { message: d.comment } : {}),
          });
          await svc.session.clear(tg(ctx));
          await showMenu(ctx, user, t.offerSent);
          return;
        default:
          return;
      }
    } catch (err) {
      await ctx.reply(errorText(err, l));
    }
  }

  async function runSearch(ctx: Context, user: User, d: Draft, nextPage: boolean): Promise<void> {
    const l = lang(user);
    const t = TEXTS[l];
    const date = d.date ? bishkekInstant(d.date, '12:00').toISOString() : undefined;
    const cursor = nextPage ? (d.cursor ?? undefined) : undefined;
    if (d.flow === 'findPassengers') {
      const page = await svc.requests.list(
        { from_id: d.from, to_id: d.to ?? undefined, date, sort: 'time', limit: PAGE, cursor },
        user.id,
      );
      if (page.data.length === 0 && !nextPage) {
        await showMenu(ctx, user, t.nothingFoundDriver);
        return;
      }
      if (page.nearby && !nextPage) await ctx.reply(t.nearbyNote);
      for (const r of page.data) await ctx.reply(requestCard(r, l), { parse_mode: 'HTML', reply_markup: requestButtons(r, l) });
      await pageFooter(ctx, l, page.nextCursor);
      return;
    }
    const page = await svc.trips().search(
      {
        from_id: d.from,
        to_id: d.to ?? undefined,
        date,
        seats: 1,
        sort: 'time',
        limit: PAGE,
        cursor,
        only_verified: false,
        women_only: false,
        no_smoking: false,
        pets: false,
        ...(d.airportId ? { kind: 'airport' as const } : {}),
      },
      user.id,
    );
    if (page.data.length === 0 && !nextPage) {
      // Nothing yet → offer to post a request with the same route.
      await svc.session.set(tg(ctx), { flow: 'needRide', from: d.from, to: d.to, airportId: d.airportId });
      await ctx.reply(t.nothingFound, {
        reply_markup: new InlineKeyboard().text(TEXTS[l].menuNeedRide, 'go:needRide').text(t.cancel, 'x'),
      });
      return;
    }
    if (page.nearby && !nextPage) await ctx.reply(t.nearbyNote);
    for (const trip of page.data) await ctx.reply(tripCard(trip, l), { parse_mode: 'HTML', reply_markup: tripButtons(trip, l) });
    await svc.session.patch(tg(ctx), { cursor: page.nextCursor });
    await pageFooter(ctx, l, page.nextCursor);
  }

  async function pageFooter(ctx: Context, l: Lang, next: string | null): Promise<void> {
    await svc.session.patch(tg(ctx), { cursor: next });
    if (next) await ctx.reply('…', { reply_markup: new InlineKeyboard().text(TEXTS[l].more, 'more') });
  }

  // ─── Listing actions (contact / book / offer) ───────────────────────
  async function revealContact(ctx: Context, user: User, kind: 'trip' | 'request', id: string): Promise<void> {
    const l = lang(user);
    try {
      const c = kind === 'trip' ? await svc.contacts.revealForTrip(id, user.id) : await svc.contacts.revealForRequest(id, user.id);
      await ctx.reply(TEXTS[l].contactCard(escapeHtml(c.name), c.phone), {
        parse_mode: 'HTML',
        reply_markup: new InlineKeyboard().url(TEXTS[l].writeWhatsapp, waLink(c.phone)),
      });
    } catch (err) {
      await ctx.reply(errorText(err, l));
    }
  }

  async function startBooking(ctx: Context, user: User, tripId: string): Promise<void> {
    const trip = await svc.trips().getById(tripId, user.id).catch(() => null);
    if (!trip) return;
    await start(ctx, user, 'book', { targetId: tripId, maxSeats: trip.seatsAvailable });
  }

  async function startOffer(ctx: Context, user: User, requestId: string): Promise<void> {
    const req = await svc.requests.getById(requestId, user.id).catch(() => null);
    if (!req) return;
    const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bishkek' }).format(new Date(req.departureDate));
    await start(ctx, user, 'offer', { targetId: requestId, date });
  }

  return { start, advance, onText, onLocation, onCallback, revealContact, startBooking, startOffer };
}

// ─── Cards ────────────────────────────────────────────────────────────
export function tripCard(trip: TripCardItem, l: Lang): string {
  const t = TEXTS[l];
  const driver = trip.driver;
  const rating = driver.rating ? ` ★${driver.rating.toFixed(1)}` : '';
  const car = driver.car ? ` · ${escapeHtml(driver.car.make)} ${escapeHtml(driver.car.model)}` : '';
  const spot = trip.originPoint?.address ?? (trip.originPoint?.area ? placeName(trip.originPoint.area, l) : null);
  const pin = spot ? `\n📍 ${escapeHtml(spot)}` : '';
  return [
    `${trip.kind === 'airport' ? '✈️' : '🚗'} <b>${escapeHtml(placeName(trip.origin, l))} → ${escapeHtml(placeName(trip.destination, l))}</b>`,
    `🕒 ${formatWhen(trip.departureAt, l)}`,
    `💺 ${t.seatsLeft(trip.seatsAvailable)} · 💰 ${trip.pricePerSeat} ${t.som}`,
    `👤 ${escapeHtml(driver.name)}${rating}${car}${pin}`,
  ].join('\n');
}

export function requestCard(r: PassengerRequestCardItem, l: Lang): string {
  const t = TEXTS[l];
  return [
    `${r.kind === 'airport' ? '✈️' : '🙋'} <b>${escapeHtml(placeName(r.origin, l))} → ${escapeHtml(placeName(r.destination, l))}</b>`,
    `🕒 ${formatWhen(r.departureDate, l, !r.flexible)}`,
    `👥 ${t.seatsLeft(r.seatsNeeded)}`,
    `👤 ${escapeHtml(r.passenger.name)}${r.flightNumber ? ` · ✈️ ${escapeHtml(r.flightNumber)}` : ''}`,
  ].join('\n');
}

function tripButtons(trip: TripCardItem, l: Lang): InlineKeyboard {
  const t = TEXTS[l];
  const kb = new InlineKeyboard().text(t.contact, `tc:${trip.id}`).text(t.book, `tb:${trip.id}`);
  if (HAS_WEB_LINKS) kb.row().url('🔗', webLink(`/trips/${trip.id}`));
  return kb;
}

function requestButtons(r: PassengerRequestCardItem, l: Lang): InlineKeyboard {
  const t = TEXTS[l];
  return new InlineKeyboard().text(t.contact, `rc:${r.id}`).text(t.offer, `ro:${r.id}`);
}
