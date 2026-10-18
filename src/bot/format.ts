import { InlineKeyboard, Keyboard } from 'grammy';
import { env } from '@/config/env.js';
import type { PlaceRef } from '@/lib/places.js';
import { TEXTS, type Lang } from './texts.js';

export const WEB_URL = (env.WEB_URL ?? env.BASE_URL).replace(/\/$/, '');
// Telegram refuses non-HTTPS URL buttons — skip them on a plain-http dev host.
export const HAS_WEB_LINKS = WEB_URL.startsWith('https://');

export function escapeHtml(v: string): string {
  return v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function placeName(p: { nameRu: string; nameKg: string }, lang: Lang): string {
  return lang === 'kg' ? p.nameKg : p.nameRu;
}

// «Кара-Суу · Ноокенский район» — disambiguates homonyms in pickers.
export function placeLabel(p: PlaceRef, lang: Lang): string {
  const area = p.raion ?? (p.type === 'capital' ? null : p.oblast);
  return area ? `${placeName(p, lang)} · ${placeName(area, lang)}` : placeName(p, lang);
}

const TZ = 'Asia/Bishkek';

export function formatWhen(d: Date | string, lang: Lang, withTime = true): string {
  return new Intl.DateTimeFormat(lang === 'kg' ? 'ky-KG' : 'ru-RU', {
    day: 'numeric',
    month: 'short',
    ...(withTime ? { hour: '2-digit', minute: '2-digit' } : {}),
    timeZone: TZ,
  }).format(new Date(d));
}

// Next 7 Bishkek days as [YYYY-MM-DD, label].
export function nextDays(lang: Lang): Array<[string, string]> {
  const t = TEXTS[lang];
  const out: Array<[string, string]> = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(Date.now() + i * 86_400_000);
    const iso = new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(d);
    const label =
      i === 0
        ? t.today
        : i === 1
          ? t.tomorrow
          : new Intl.DateTimeFormat(lang === 'kg' ? 'ky-KG' : 'ru-RU', {
              weekday: 'short',
              day: 'numeric',
              month: 'short',
              timeZone: TZ,
            }).format(d);
    out.push([iso, label]);
  }
  return out;
}

// YYYY-MM-DD + HH:MM in Bishkek (UTC+6, no DST) → instant.
export function bishkekInstant(date: string, time: string): Date {
  return new Date(`${date}T${time}:00+06:00`);
}

export function mainMenu(lang: Lang, driver: boolean): Keyboard {
  const t = TEXTS[lang];
  const kb = new Keyboard();
  if (driver) kb.text(t.menuFindPassengers).text(t.menuPublish).row();
  else kb.text(t.menuFindTrip).text(t.menuNeedRide).row();
  kb.text(t.menuAirport).text(t.menuMy).row();
  kb.text(driver ? t.menuModeDriver : t.menuModePassenger).text(t.menuSettings).row();
  kb.text(t.menuHelp);
  return kb.resized().persistent();
}

export function contactKeyboard(lang: Lang): Keyboard {
  return new Keyboard().requestContact(TEXTS[lang].shareContactButton).resized().oneTime();
}

export function placeStepKeyboard(lang: Lang, quick: PlaceRef[], withAny = false): InlineKeyboard {
  const kb = new InlineKeyboard();
  quick.forEach((p, i) => {
    kb.text(placeName(p, lang), `pl:${p.id}`);
    if (i % 3 === 2) kb.row();
  });
  kb.row();
  if (withAny) kb.text(TEXTS[lang].anyDirection, 'pl:any').row();
  kb.text(TEXTS[lang].cancel, 'x');
  return kb;
}

export function waLink(phone: string): string {
  return `https://wa.me/${phone.replace(/\D/g, '')}`;
}

export function webLink(path: string): string {
  return `${WEB_URL}${path}`;
}
