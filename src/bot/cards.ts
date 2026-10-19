import { InlineKeyboard } from 'grammy';
import type { TripCardItem } from '@/modules/trips/trips.service.js';
import type { PassengerRequestCardItem } from '@/modules/passenger-requests/passenger-requests.service.js';
import { TEXTS, type Lang } from './texts.js';
import { HAS_WEB_LINKS, escapeHtml, formatWhen, placeName, webLink } from './format.js';

// Listing cards (search results) and their one-tap actions.

const rated = (r: number | null): string => (r ? ` ★${r.toFixed(1)}` : '');

export function tripCard(trip: TripCardItem, l: Lang): string {
  const t = TEXTS[l];
  const driver = trip.driver;
  const car = driver.car ? ` · ${escapeHtml(driver.car.make)} ${escapeHtml(driver.car.model)}` : '';
  const spot = trip.originPoint?.address ?? (trip.originPoint?.area ? placeName(trip.originPoint.area, l) : null);
  return [
    `${trip.kind === 'airport' ? '✈️' : '🚗'} <b>${escapeHtml(placeName(trip.origin, l))} → ${escapeHtml(placeName(trip.destination, l))}</b>`,
    `🕒 ${formatWhen(trip.departureAt, l)}`,
    `💺 ${t.seatsLeft(trip.seatsAvailable)} · 💰 ${trip.pricePerSeat} ${t.som}`,
    `👤 ${escapeHtml(driver.name)}${rated(driver.rating)}${car}`,
    spot ? `📍 ${escapeHtml(spot)}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

export function requestCard(r: PassengerRequestCardItem, l: Lang): string {
  const t = TEXTS[l];
  return [
    `${r.kind === 'airport' ? '✈️' : '🙋'} <b>${escapeHtml(placeName(r.origin, l))} → ${escapeHtml(placeName(r.destination, l))}</b>`,
    `🕒 ${formatWhen(r.departureDate, l, !r.flexible)}${r.flexible ? ` · ${t.flexibleLabel}` : ''}`,
    `👥 ${t.seatsLeft(r.seatsNeeded)}`,
    `👤 ${escapeHtml(r.passenger.name)}${rated(r.passenger.rating)}${r.flightNumber ? ` · ✈️ ${escapeHtml(r.flightNumber)}` : ''}`,
    r.myResponse?.status === 'pending' ? t.offered : '',
  ]
    .filter(Boolean)
    .join('\n');
}

export function tripButtons(trip: TripCardItem, l: Lang): InlineKeyboard {
  const t = TEXTS[l];
  const kb = new InlineKeyboard().text(t.contact, `tc:${trip.id}`).text(t.book, `tb:${trip.id}`);
  if (HAS_WEB_LINKS) kb.row().url(t.openOnSite, webLink(`/trips/${trip.id}`));
  return kb;
}

export function requestButtons(r: PassengerRequestCardItem, l: Lang): InlineKeyboard {
  const t = TEXTS[l];
  const kb = new InlineKeyboard().text(t.contact, `rc:${r.id}`);
  // A driver who already has a pending offer sees that instead of a dead «offer» tap.
  return r.myResponse?.status === 'pending' ? kb : kb.text(t.offer, `ro:${r.id}`);
}
