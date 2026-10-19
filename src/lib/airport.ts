import { haversineKm } from '@/lib/places.js';

// Airport transfers: when to leave for a flight, and how listings rank around
// a flight time.

export type FlightType = 'international' | 'domestic';

// Be at the airport this long before departure (check-in + security).
export const DEPARTURE_BUFFER_MIN: Record<FlightType, number> = { international: 150, domestic: 90 };

// Straight-line km at this average speed, rounded UP to whole quarter hours.
const TRANSFER_KMH = 50;
const ROUND_MIN = 15;

export function transferMinutes(km: number): number {
  const raw = (km * 60) / TRANSFER_KMH;
  return Math.max(ROUND_MIN, Math.ceil(raw / ROUND_MIN - 1e-9) * ROUND_MIN);
}

export interface PickupSuggestion {
  pickupAt: Date;
  travelMin: number;
  bufferMin: number;
  distanceKm: number;
  flightType: FlightType;
}

/** Pickup = flight departure − check-in buffer − estimated travel time. */
export function suggestPickup(
  from: { lat: number; lng: number },
  airport: { lat: number; lng: number },
  flightAt: Date,
  flightType: FlightType,
): PickupSuggestion {
  const distanceKm = Math.round(haversineKm(from, airport) * 10) / 10;
  const travelMin = transferMinutes(distanceKm);
  const bufferMin = DEPARTURE_BUFFER_MIN[flightType];
  return {
    pickupAt: new Date(flightAt.getTime() - (bufferMin + travelMin) * 60_000),
    travelMin,
    bufferMin,
    distanceKm,
    flightType,
  };
}

// target_time search: listings within ±2h of the target are «near» it.
export const TARGET_WINDOW_MS = 2 * 60 * 60_000;
// Ranked in memory: at most this many listings of the target's day.
export const TARGET_POOL = 200;

/**
 * Orders listings by |departure − target| — the ones within ±2h come first by
 * construction, then the rest of the day. Ties: earlier departure, then input
 * order (callers pass rows sorted by departure, id), so offset pages are stable.
 */
export function rankByTarget<T>(rows: T[], timeOf: (r: T) => Date, target: Date): Array<{ row: T; near: boolean }> {
  const t = target.getTime();
  return rows
    .map((row, i) => ({ row, i, at: timeOf(row).getTime() }))
    .map((x) => ({ ...x, delta: Math.abs(x.at - t) }))
    .sort((a, b) => a.delta - b.delta || a.at - b.at || a.i - b.i)
    .map((x) => ({ row: x.row, near: x.delta <= TARGET_WINDOW_MS }));
}
