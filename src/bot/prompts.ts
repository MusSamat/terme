import type { User } from '@prisma/client';
import { InlineKeyboard, type Context } from 'grammy';
import type { PlaceRef } from '@/lib/places.js';
import { isDriverMode, type BotServices } from './context.js';
import type { Draft, Flow } from './session.js';
import { TEXTS, langOf, type Lang } from './texts.js';
import {
  HAS_WEB_LINKS,
  HTML,
  MIN_LEAD_MS,
  bishkekInstant,
  bishkekTime,
  escapeHtml,
  formatWhen,
  isTooSoon,
  mainMenu,
  nextDays,
  placeName,
  placeStepKeyboard,
  webLink,
  withNav,
} from './format.js';

// Flows whose date step offers «Любая дата».
export const SEARCH_FLOWS = new Set<Flow>(['findTrip', 'findPassengers']);

const TIME_SLOTS = ['05:00', '06:00', '07:00', '08:00', '09:00', '10:00', '12:00', '14:00', '16:00', '18:00', '20:00', '22:00'];
// Flights run around the clock — quick picks every two hours.
const FLIGHT_SLOTS = ['01:00', '03:00', '05:00', '07:00', '09:00', '11:00', '13:00', '15:00', '17:00', '19:00', '21:00', '23:00'];

// Airport title for the bot: «Манас · Бишкек» / «Ош».
export const airportTitle = (a: { titleRu: string; titleKg: string }, l: Lang): string =>
  l === 'kg' ? a.titleKg : a.titleRu;

// Upper bound of the seats step — mirrors the API schemas (booking ≤ 4,
// trip ≤ 7 and ≤ the car, request ≤ 8).
export function seatsLimit(d: Draft): number {
  if (d.flow === 'book') return Math.min(d.maxSeats ?? 4, 4);
  if (d.flow === 'publish') return Math.min(d.maxSeats ?? 7, 7);
  return 8;
}

// Asks for the draft's current step. Returns a patch instead when the step can
// be answered without the user (a driver with a single car).
export function createPrompts(svc: BotServices) {
  async function ask(ctx: Context, user: User, d: Draft): Promise<Partial<Draft> | null> {
    const l = langOf(user.language);
    const t = TEXTS[l];
    const canBack = (d.history?.length ?? 0) > 1;
    const nav = (kb: InlineKeyboard) => withNav(kb, l, canBack);
    switch (d.step) {
      case 'from':
      case 'to': {
        const quick = (await svc.cities.top(6)).filter((p) => p.id !== d.from);
        const anyAllowed = d.step === 'to' && d.flow === 'findPassengers';
        const prompt = d.step === 'from' ? t.askFrom : anyAllowed ? t.askToOptional : t.askTo;
        await ctx.reply(prompt, { ...HTML, reply_markup: placeStepKeyboard(l, quick, anyAllowed, canBack) });
        // Location sharing needs a reply-keyboard button: the main menu + 📍 on top.
        if (d.step === 'from') await ctx.reply(t.orLocation, { reply_markup: mainMenu(l, isDriverMode(user), true) });
        return null;
      }
      case 'date': {
        const kb = new InlineKeyboard();
        nextDays(l).forEach(([iso, label], i) => {
          kb.text(label, `d:${iso}`);
          if (i % 3 === 2) kb.row();
        });
        if (d.flow && SEARCH_FLOWS.has(d.flow)) kb.row().text(t.anyDate, 'd:any');
        await ctx.reply(d.flow === 'airport' ? t.askFlightDate : t.askDate, { ...HTML, reply_markup: nav(kb) });
        return null;
      }
      case 'time': {
        const kb = new InlineKeyboard();
        const date = d.date ?? '';
        if (d.hintTime && !isTooSoon(date, d.hintTime)) kb.text(t.timeAsRequested(d.hintTime), `t:${d.hintTime}`).row();
        const slots = TIME_SLOTS.filter((h) => !isTooSoon(date, h));
        slots.forEach((h, i) => {
          kb.text(h, `t:${h}`);
          if (i % 4 === 3) kb.row();
        });
        // A passenger may not know the exact time yet → «flexible».
        if (d.flow === 'needRide') kb.row().text(t.flexibleTime, 'sk');
        await ctx.reply(slots.length ? t.askTime : t.askTimeLate, { ...HTML, reply_markup: nav(kb) });
        return null;
      }
      case 'seats': {
        const max = seatsLimit(d);
        const kb = new InlineKeyboard();
        for (let n = 1; n <= max; n++) {
          kb.text(String(n), `n:${n}`);
          if (max > 4 && n === 4) kb.row();
        }
        const prompt = d.flow === 'publish' ? t.askSeatsTrip : d.flow === 'book' ? t.askSeatsBook : t.askSeatsRequest;
        await ctx.reply(prompt, { ...HTML, reply_markup: nav(kb) });
        return null;
      }
      case 'price': {
        const hint =
          d.from && d.to ? ((await svc.trips().priceSuggestion(d.from, d.to).catch(() => null))?.averagePrice ?? null) : null;
        const kb = new InlineKeyboard();
        if (hint) kb.text(`${hint} ${t.som}`, `p:${hint}`);
        await ctx.reply(t.askPrice(hint), { ...HTML, reply_markup: nav(kb) });
        return null;
      }
      case 'comment':
        await ctx.reply(t.askComment, { reply_markup: nav(new InlineKeyboard().text(t.skip, 'sk')) });
        return null;
      case 'flight':
        await ctx.reply(t.askFlight, { reply_markup: nav(new InlineKeyboard().text(t.skip, 'sk')) });
        return null;
      case 'car': {
        const cars = await svc.cars.listMy(user.id);
        if (cars.length === 1) return { carId: cars[0]!.id, maxSeats: cars[0]!.seatsCount };
        if (cars.length === 0) {
          await svc.session.clear(ctx.from!.id);
          await replyNoCar(ctx, user);
          return null;
        }
        const kb = new InlineKeyboard();
        for (const c of cars) kb.text(`${c.make} ${c.model} · ${c.plate}`, `car:${c.id}`).row();
        await ctx.reply(t.chooseCar, { reply_markup: nav(kb) });
        return null;
      }
      case 'airportPick': {
        const kb = new InlineKeyboard();
        for (const a of await svc.cities.airports()) kb.text(`✈️ ${airportTitle(a, l)}`, `ap:${a.id}`).row();
        await ctx.reply(t.pickAirport, { ...HTML, reply_markup: nav(kb) });
        return null;
      }
      case 'airportDir': {
        const airport = (await svc.cities.airports()).find((a) => a.id === d.airportId);
        await ctx.reply(t.airportDirAsk(escapeHtml(airport ? airportTitle(airport, l) : '')), {
          ...HTML,
          reply_markup: nav(new InlineKeyboard().text(t.toAirport, 'ad:to').row().text(t.fromAirport, 'ad:from')),
        });
        return null;
      }
      case 'airportEnd': {
        const airport = (await svc.cities.airports()).find((a) => a.id === d.airportId);
        const kb = new InlineKeyboard();
        (airport?.popularDestinations ?? []).forEach((p, i) => {
          kb.text(placeName(p, l), `pl:${p.id}`);
          if (i % 3 === 2) kb.row();
        });
        kb.row().text(t.otherPlace, 'ae:other');
        await ctx.reply(d.airportDir === 'from' ? t.airportEndFrom : t.airportEndTo, { ...HTML, reply_markup: nav(kb) });
        return null;
      }
      case 'flightTime': {
        const kb = new InlineKeyboard();
        FLIGHT_SLOTS.filter((h) => !isTooSoon(d.date ?? '', h)).forEach((h, i) => {
          kb.text(h, `fh:${h}`);
          if (i % 4 === 3) kb.row();
        });
        await ctx.reply(d.airportDir === 'from' ? t.askFlightArrival : t.askFlightDeparture, { ...HTML, reply_markup: nav(kb) });
        return null;
      }
      case 'pickup': {
        const s = await suggestPickup(d);
        const flight = bishkekTime(d.flightAt!);
        const intl = s.flightType === 'international';
        const kb = new InlineKeyboard();
        const late = new Date(s.pickupAt).getTime() < Date.now() + MIN_LEAD_MS;
        if (!late) kb.text(t.acceptPickup(bishkekTime(s.pickupAt)), 'pu:ok').row();
        kb.text(intl ? t.domesticFlight : t.internationalFlight, `fy:${intl ? 'domestic' : 'international'}`);
        const text = late
          ? t.pickupLate(flight)
          : t.pickupSuggest(bishkekTime(s.pickupAt), flight, intl, String(s.bufferMin / 60).replace('.', ','), s.travelMin);
        await ctx.reply(text, { ...HTML, reply_markup: nav(kb) });
        return null;
      }
      case 'sign':
        await ctx.reply(t.askSign, {
          ...HTML,
          reply_markup: nav(new InlineKeyboard().text(t.signYes, 'sg:1').text(t.signNo, 'sg:0')),
        });
        return null;
      case 'luggage': {
        const kb = new InlineKeyboard();
        for (let n = 0; n <= 5; n++) kb.text(String(n), `lg:${n}`);
        await ctx.reply(t.askLuggage, { ...HTML, reply_markup: nav(kb) });
        return null;
      }
      case 'confirm':
        await ctx.reply(await summary(user, d), {
          ...HTML,
          reply_markup: nav(new InlineKeyboard().text(t.confirm, 'ok')),
        });
        return null;
      default:
        return null;
    }
  }

  // Pickup for a flight from the other end of the transfer (the API helper).
  function suggestPickup(d: Draft) {
    return svc.cities.pickupSuggestion(d.airportId!, d.airportEnd!, new Date(d.flightAt!), d.flightType);
  }

  async function replyNoCar(ctx: Context, user: User): Promise<void> {
    const t = TEXTS[langOf(user.language)];
    const kb = HAS_WEB_LINKS ? new InlineKeyboard().url(t.openSite, webLink('/profile/cars')) : undefined;
    await ctx.reply(t.noCar, kb ? { reply_markup: kb } : undefined);
  }

  async function summary(user: User, d: Draft): Promise<string> {
    const l = langOf(user.language);
    const t = TEXTS[l];
    const ids = [d.from, d.to].filter((v): v is number => typeof v === 'number');
    const places = new Map<number, PlaceRef>((await svc.cities.byIds(ids)).map((p) => [p.id, p]));
    const name = (id: number | null | undefined) => {
      const p = id ? places.get(id) : undefined;
      return p ? escapeHtml(placeName(p, l)) : '—';
    };
    const car = d.carId ? (await svc.cars.listMy(user.id)).find((c) => c.id === d.carId) : undefined;
    const when = d.date
      ? d.time
        ? formatWhen(bishkekInstant(d.date, d.time), l)
        : `${formatWhen(bishkekInstant(d.date, '12:00'), l, false)} · ${t.flexibleLabel}`
      : '';
    const price = d.price ? (d.flow === 'book' && d.seats ? t.priceTotal(d.price, d.seats) : `${d.price} ${t.som}`) : '';
    const lines = [
      t.confirmTitle[d.flow ?? ''] ?? '',
      `<b>${name(d.from)} → ${name(d.to)}</b>`,
      when ? `🕒 ${when}` : '',
      d.seats ? `💺 ${t.seatsLeft(d.seats)}` : '',
      price ? `💰 ${price}` : '',
      car ? `🚗 ${escapeHtml(`${car.make} ${car.model} · ${car.plate}`)}` : '',
      d.flight ? `✈️ ${escapeHtml(d.flight)}` : '',
      d.meetSign ? `🪧 ${t.signLine}` : '',
      d.luggage !== undefined ? `🧳 ${t.luggageLine(d.luggage)}` : '',
      d.comment ? `💬 ${escapeHtml(d.comment)}` : '',
    ];
    return [...lines.filter(Boolean), '', t.confirmAsk].join('\n');
  }

  return { ask, replyNoCar, suggestPickup };
}
