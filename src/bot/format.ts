import { InlineKeyboard, Keyboard } from 'grammy';
import { env } from '@/config/env.js';
import type { PlaceRef } from '@/lib/places.js';
import { TEXTS, type Lang } from './texts.js';

export const WEB_URL = (env.WEB_URL ?? env.BASE_URL).replace(/\/$/, '');
// Telegram refuses non-HTTPS URL buttons — skip them on a plain-http dev host.
export const HAS_WEB_LINKS = WEB_URL.startsWith('https://');

export const HTML = { parse_mode: 'HTML' as const };

export function escapeHtml(v: string): string {
  return v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function placeName(p: { nameRu: string; nameKg: string }, lang: Lang): string {
  return lang === 'kg' ? p.nameKg : p.nameRu;
}

// «Кара-Суу (Ноокенский район)» — disambiguates homonyms in pickers.
export function placeLabel(p: PlaceRef, lang: Lang): string {
  const area = p.raion ?? (p.type === 'capital' ? null : p.oblast);
  return area ? `${placeName(p, lang)} (${placeName(area, lang)})` : placeName(p, lang);
}

const TZ = 'Asia/Bishkek';
const DAY_MS = 86_400_000;
export const MAX_DAYS_AHEAD = 60; // trips / requests horizon (services enforce it too)
export const MIN_LEAD_MS = 30 * 60_000; // earliest departure from now

const locale = (lang: Lang): string => (lang === 'kg' ? 'ky-KG' : 'ru-RU');

export function formatWhen(d: Date | string, lang: Lang, withTime = true): string {
  return new Intl.DateTimeFormat(locale(lang), {
    day: 'numeric',
    month: 'short',
    ...(withTime ? { hour: '2-digit', minute: '2-digit' } : {}),
    timeZone: TZ,
  }).format(new Date(d));
}

// Instant → Bishkek calendar day (YYYY-MM-DD) and wall time (HH:MM).
export function bishkekDate(d: Date | string | number = Date.now()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date(d));
}

export function bishkekTime(d: Date | string): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(
    new Date(d),
  );
}

// YYYY-MM-DD + HH:MM in Bishkek (UTC+6, no DST) → instant.
export function bishkekInstant(date: string, time: string): Date {
  return new Date(`${date}T${time}:00+06:00`);
}

// Next 7 Bishkek days as [YYYY-MM-DD, label].
export function nextDays(lang: Lang): Array<[string, string]> {
  const t = TEXTS[lang];
  const out: Array<[string, string]> = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(Date.now() + i * DAY_MS);
    const label =
      i === 0
        ? t.today
        : i === 1
          ? t.tomorrow
          : new Intl.DateTimeFormat(locale(lang), { weekday: 'short', day: 'numeric', month: 'short', timeZone: TZ }).format(d);
    out.push([bishkekDate(d), label]);
  }
  return out;
}

// «25.10», «25.10.2026», «25/10» → YYYY-MM-DD within [today, today + 60 days]; else null.
export function parseDate(text: string): string | null {
  const m = /^(\d{1,2})[./\-\s](\d{1,2})(?:[./\-\s](\d{2}|\d{4}))?$/.exec(text.trim());
  if (!m) return null;
  const today = bishkekDate();
  const day = Number(m[1]);
  const month = Number(m[2]);
  let year = m[3] ? Number(m[3].length === 2 ? `20${m[3]}` : m[3]) : Number(today.slice(0, 4));
  const iso = (y: number) => `${y}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  if (!m[3] && iso(year) < today) year++; // «05.01» typed in December → next year
  const candidate = iso(year);
  const parsed = new Date(`${candidate}T12:00:00+06:00`);
  if (Number.isNaN(parsed.getTime()) || bishkekDate(parsed) !== candidate) return null; // 31.02 etc.
  const last = bishkekDate(Date.now() + MAX_DAYS_AHEAD * DAY_MS);
  return candidate >= today && candidate <= last ? candidate : null;
}

// «7:30», «07.30», «0730» → HH:MM; else null.
export function parseTime(text: string): string | null {
  const m = /^([01]?\d|2[0-3])[:.\s]?([0-5]\d)$/.exec(text.trim());
  return m ? `${m[1]!.padStart(2, '0')}:${m[2]}` : null;
}

// Departure must be at least MIN_LEAD_MS ahead (same rule the trips service applies).
export const isTooSoon = (date: string, time: string): boolean =>
  bishkekInstant(date, time).getTime() < Date.now() + MIN_LEAD_MS;

export function mainMenu(lang: Lang, driver: boolean, withLocation = false): Keyboard {
  const t = TEXTS[lang];
  const kb = new Keyboard();
  if (withLocation) kb.requestLocation(t.myLocation).row();
  if (driver) kb.text(t.menuFindPassengers).text(t.menuPublish).row();
  else kb.text(t.menuFindTrip).text(t.menuNeedRide).row();
  kb.text(t.menuAirport).text(t.menuMy).row();
  kb.text(driver ? t.menuToPassenger : t.menuToDriver).row();
  kb.text(t.menuSettings).text(t.menuHelp);
  return kb.resized().persistent();
}

export function contactKeyboard(lang: Lang): Keyboard {
  return new Keyboard().requestContact(TEXTS[lang].shareContactButton).resized().oneTime();
}

/** Appends the standard «⬅️ Назад · ✖️ Отмена» row to a step keyboard. */
export function withNav(kb: InlineKeyboard, lang: Lang, canBack: boolean): InlineKeyboard {
  kb.row();
  if (canBack) kb.text(TEXTS[lang].back, 'bk');
  return kb.text(TEXTS[lang].cancel, 'x');
}

export function placeStepKeyboard(lang: Lang, quick: PlaceRef[], withAny: boolean, canBack: boolean): InlineKeyboard {
  const kb = new InlineKeyboard();
  quick.forEach((p, i) => {
    kb.text(placeName(p, lang), `pl:${p.id}`);
    if (i % 3 === 2) kb.row();
  });
  kb.row();
  if (withAny) kb.text(TEXTS[lang].anyDirection, 'pl:any').row();
  return withNav(kb, lang, canBack);
}

export function waLink(phone: string): string {
  return `https://wa.me/${phone.replace(/\D/g, '')}`;
}

export function webLink(path: string): string {
  return `${WEB_URL}${path}`;
}
