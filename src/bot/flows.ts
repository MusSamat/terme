import crypto from 'node:crypto';
import type { User } from '@prisma/client';
import { InlineKeyboard, type Context } from 'grammy';
import { MeetingPoint } from '@/modules/cities/cities.schemas.js';
import { isDriverMode, showMenu, type BotServices } from './context.js';
import type { Draft, Flow, Step } from './session.js';
import { TEXTS, langOf, type Lang } from './texts.js';
import { bishkekDate, isTooSoon, mainMenu, parseDate, parseTime, placeLabel, withNav } from './format.js';
import { SEARCH_FLOWS, createPrompts, seatsLimit } from './prompts.js';
import { createActions } from './actions.js';

// Step order per flow; a step is skipped when its value is already in the draft.
const ORDER: Record<Flow, Step[]> = {
  findTrip: ['from', 'to', 'date'],
  findPassengers: ['from', 'to', 'date'],
  needRide: ['from', 'to', 'date', 'time', 'seats', 'flight', 'comment', 'confirm'],
  publish: ['car', 'from', 'to', 'date', 'time', 'seats', 'price', 'comment', 'confirm'],
  airport: ['airportDir', 'airportPick'], // then continues as findTrip / publish
  book: ['seats', 'confirm'],
  offer: ['date', 'time', 'price', 'comment', 'confirm'],
  link: ['code'], // handled in index.ts (sign-in), never advanced here
};

// Draft keys a step owns — cleared when «Назад» returns to it.
const STEP_KEYS: Record<Step, Array<keyof Draft>> = {
  from: ['from', 'point'],
  to: ['to'],
  date: ['date'],
  time: ['time'],
  seats: ['seats'],
  price: ['price'],
  comment: ['comment'],
  flight: ['flight'],
  car: ['carId', 'maxSeats'],
  airportDir: ['airportDir'],
  airportPick: ['airportId'],
  confirm: [],
  code: [],
};

function filled(d: Draft, step: Step): boolean {
  switch (step) {
    case 'flight': // only matters for airport transfers
      return d.flight !== undefined || d.airportId === undefined;
    case 'car':
      return d.carId !== undefined;
    case 'airportPick':
      return d.airportId !== undefined;
    case 'confirm':
    case 'code':
      return false;
    default:
      return d[step] !== undefined;
  }
}

export function createFlows(svc: BotServices) {
  const prompts = createPrompts(svc);
  const actions = createActions(svc);
  const lang = (u: User): Lang => langOf(u.language);
  const tg = (ctx: Context): number => ctx.from!.id;

  async function start(ctx: Context, user: User, flow: Flow, preset: Partial<Draft> = {}): Promise<void> {
    const { search } = await svc.session.get(tg(ctx));
    await svc.session.set(tg(ctx), { flow, idem: crypto.randomUUID(), ...preset, ...(search ? { search } : {}) });
    await advance(ctx, user);
  }

  // Moves to the first unfilled step and asks for it; runs the action at the end.
  async function advance(ctx: Context, user: User): Promise<void> {
    for (let guard = 0; guard < 4; guard++) {
      const d = await svc.session.get(tg(ctx));
      if (!d.flow) return showMenu(ctx, user);
      const step = ORDER[d.flow].find((s) => !filled(d, s));
      if (!step) return actions.finish(ctx, user, d);
      const asked = d.history ?? [];
      const next: Draft = { ...d, step, history: asked.at(-1) === step ? asked : [...asked, step] };
      await svc.session.set(tg(ctx), next);
      const auto = await prompts.ask(ctx, user, next);
      if (!auto) return;
      // Answered without the user — not a step «Назад» should return to.
      await svc.session.patch(tg(ctx), { ...auto, history: asked });
    }
  }

  // «Назад»: forget the previous answer and ask it again.
  async function back(ctx: Context, user: User, d: Draft): Promise<void> {
    const history = [...(d.history ?? [])];
    history.pop(); // the current step
    const prev = history.pop();
    if (!prev) {
      // First step of a flow that the airport picker started → back to the picker.
      if (d.airportId !== undefined && d.flow !== 'airport') return start(ctx, user, 'airport');
      return cancel(ctx, user);
    }
    const cleared = Object.fromEntries(STEP_KEYS[prev].map((k) => [k, undefined]));
    await svc.session.set(tg(ctx), { ...d, ...cleared, history });
    await advance(ctx, user);
  }

  async function cancel(ctx: Context, user: User): Promise<void> {
    await svc.session.clear(tg(ctx));
    await showMenu(ctx, user, TEXTS[lang(user)].cancelled);
  }

  // ─── Typed input ────────────────────────────────────────────────────
  async function onText(ctx: Context, user: User, text: string): Promise<boolean> {
    const d = await svc.session.get(tg(ctx));
    if (!d.flow || !d.step) return false;
    const l = lang(user);
    const t = TEXTS[l];
    const say = async (msg: string): Promise<boolean> => {
      await ctx.reply(msg);
      return true;
    };
    switch (d.step) {
      case 'from':
      case 'to': {
        const found = (await svc.cities.search(text, 7)).filter((p) => d.step === 'from' || p.id !== d.from);
        if (found.length === 0) return say(t.noPlaces);
        const kb = new InlineKeyboard();
        for (const p of found) kb.text(placeLabel(p, l), `pl:${p.id}`).row();
        await ctx.reply(t.pickPlace, { reply_markup: withNav(kb, l, (d.history?.length ?? 0) > 1) });
        return true;
      }
      case 'date': {
        const date = parseDate(text);
        if (!date) return say(t.badDate);
        await svc.session.patch(tg(ctx), { date });
        break;
      }
      case 'time': {
        const time = parseTime(text);
        if (!time) return say(t.badTime);
        if (isTooSoon(d.date ?? '', time)) return say(t.timeTooSoon);
        await svc.session.patch(tg(ctx), { time });
        break;
      }
      case 'seats': {
        const n = Number(text);
        if (!Number.isInteger(n) || n < 1 || n > seatsLimit(d)) return say(t.badSeats);
        await svc.session.patch(tg(ctx), { seats: n });
        break;
      }
      case 'price': {
        const n = Number(text.replace(/\s|сом/gi, ''));
        if (!Number.isInteger(n) || n < 50 || n > 10_000) return say(t.badPrice);
        await svc.session.patch(tg(ctx), { price: n });
        break;
      }
      case 'comment':
        // Trip comments are capped at 300 by the API schema (requests at 500).
        await svc.session.patch(tg(ctx), { comment: text.slice(0, 300) });
        break;
      case 'flight': {
        const f = text.trim().toUpperCase();
        if (!/^[A-Z0-9]{2}\s?\d{1,4}[A-Z]?$/.test(f)) return say(t.badFlight);
        await svc.session.patch(tg(ctx), { flight: f });
        break;
      }
      default:
        // Text where a button is expected → show the step again instead of a dead end.
        await prompts.ask(ctx, user, d);
        return true;
    }
    await advance(ctx, user);
    return true;
  }

  async function onLocation(ctx: Context, user: User, lat: number, lng: number): Promise<void> {
    const d = await svc.session.get(tg(ctx));
    const l = lang(user);
    if (d.step !== 'from' && d.step !== 'to') return showMenu(ctx, user);
    const place = await svc.cities.nearest(lat, lng).catch(() => null);
    if (!place) {
      await ctx.reply(TEXTS[l].noPlaces);
      return;
    }
    if (d.step === 'to' && place.id === d.from) {
      await ctx.reply(TEXTS[l].samePlace);
      return;
    }
    // A pin inside the country doubles as the exact meeting point.
    const point = d.step === 'from' && MeetingPoint.safeParse({ lat, lng }).success ? { point: { lat, lng } } : {};
    await svc.session.patch(tg(ctx), { [d.step]: place.id, ...point });
    await ctx.reply(`📍 ${placeLabel(place, l)}`, { reply_markup: mainMenu(l, isDriverMode(user)) });
    await advance(ctx, user);
  }

  // ─── Buttons of the current step; false = stale / unknown ───────────
  async function onCallback(ctx: Context, user: User, data: string): Promise<boolean> {
    const d = await svc.session.get(tg(ctx));
    const sep = data.indexOf(':');
    const [key, value] = sep < 0 ? [data, ''] : [data.slice(0, sep), data.slice(sep + 1)];
    const t = TEXTS[lang(user)];
    let patch: Partial<Draft>;
    switch (key) {
      case 'x':
        await cancel(ctx, user);
        return true;
      case 'bk':
        if (!d.step) return false;
        await back(ctx, user, d);
        return true;
      case 'more':
        return actions.more(ctx, user);
      case 'go':
        if (d.flow !== 'needRide' || d.step) return false;
        await advance(ctx, user);
        return true;
      case 'pl': {
        if (d.step !== 'from' && d.step !== 'to') return false;
        if (value === 'any' && !(d.step === 'to' && d.flow === 'findPassengers')) return false;
        const id = value === 'any' ? null : Number(value);
        if (id !== null && !Number.isInteger(id)) return false;
        if (d.step === 'to' && id === d.from) {
          await ctx.reply(t.samePlace);
          return true;
        }
        patch = { [d.step]: id };
        break;
      }
      case 'd':
        // «Any date» only exists in search flows; a day from an old keyboard may be past.
        if (d.step !== 'date') return false;
        if (value === 'any' ? !SEARCH_FLOWS.has(d.flow!) : !/^\d{4}-\d{2}-\d{2}$/.test(value) || value < bishkekDate()) {
          return false;
        }
        patch = { date: value === 'any' ? null : value };
        break;
      case 't':
        if (d.step !== 'time' || parseTime(value) !== value) return false;
        if (isTooSoon(d.date ?? '', value)) {
          await ctx.reply(t.timeTooSoon);
          return true;
        }
        patch = { time: value };
        break;
      case 'n': {
        const n = Number(value);
        if (d.step !== 'seats' || n < 1 || n > seatsLimit(d)) return false;
        patch = { seats: n };
        break;
      }
      case 'p': {
        const price = Number(value);
        if (d.step !== 'price' || !Number.isInteger(price) || price < 50 || price > 10_000) return false;
        patch = { price };
        break;
      }
      case 'sk':
        if (d.step === 'flight') patch = { flight: null };
        else if (d.step === 'comment') patch = { comment: null };
        else if (d.step === 'time' && d.flow === 'needRide') patch = { time: '' };
        else return false;
        break;
      case 'car': {
        if (d.step !== 'car') return false;
        const car = (await svc.cars.listMy(user.id)).find((c) => c.id === value);
        if (!car) return false;
        patch = { carId: car.id, maxSeats: car.seatsCount };
        break;
      }
      case 'ad':
        if (d.step !== 'airportDir') return false;
        patch = { airportDir: value === 'from' ? 'from' : 'to' };
        break;
      case 'ap':
        if (d.step !== 'airportPick') return false;
        await ctx.editMessageReplyMarkup().catch(() => undefined);
        return onAirportPicked(ctx, user, d, Number(value));
      case 'ok':
        if (d.step !== 'confirm') return false;
        await ctx.editMessageReplyMarkup().catch(() => undefined);
        await actions.finish(ctx, user, d);
        return true;
      default:
        return false;
    }
    // The answered keyboard goes away — no double taps, no stale buttons.
    await ctx.editMessageReplyMarkup().catch(() => undefined);
    await svc.session.patch(tg(ctx), patch);
    await advance(ctx, user);
    return true;
  }

  // Airport: the served city is the other end; drivers publish, passengers search.
  async function onAirportPicked(ctx: Context, user: User, d: Draft, airportId: number): Promise<boolean> {
    const airport = (await svc.cities.airports()).find((a) => a.id === airportId);
    if (!airport) return false;
    const city = airport.serves?.id;
    const to = d.airportDir === 'from' ? city : airportId;
    const from = d.airportDir === 'from' ? airportId : city;
    await start(ctx, user, isDriverMode(user) ? 'publish' : 'findTrip', { from, to, airportId });
    return true;
  }

  return {
    start,
    onText,
    onLocation,
    onCallback,
    cancel,
    replyNoCar: prompts.replyNoCar,
  };
}
