/**
 * Inter-city distance / duration reference. TZ §10.1:
 *   "estimated_duration_min рассчитывается автоматически по таблице
 *    расстояний между городами (справочник)."
 *
 * Stored in code for the MVP — a future sprint can migrate this into a DB
 * table once we need editable values. Keys are case- and order-independent.
 */

import { haversineKm } from '@/lib/places.js';

interface RouteSpec {
  durationMin: number;
  distanceKm: number;
}

// Pairs are stored once — lookup is symmetric.
const RAW_ROUTES: Array<[string, string, RouteSpec]> = [
  // Bishkek ↔ major cities
  ['Бишкек', 'Ош', { durationMin: 10 * 60, distanceKm: 560 }],
  ['Бишкек', 'Каракол', { durationMin: 6 * 60, distanceKm: 400 }],
  ['Бишкек', 'Нарын', { durationMin: 5 * 60, distanceKm: 320 }],
  ['Бишкек', 'Талас', { durationMin: 5 * 60, distanceKm: 320 }],
  ['Бишкек', 'Чолпон-Ата', { durationMin: 4 * 60, distanceKm: 250 }],
  ['Бишкек', 'Манас', { durationMin: 9 * 60, distanceKm: 510 }],
  ['Бишкек', 'Баткен', { durationMin: 13 * 60, distanceKm: 700 }],
  ['Бишкек', 'Токмок', { durationMin: 1 * 60, distanceKm: 60 }],
  ['Бишкек', 'Кара-Балта', { durationMin: 1 * 60, distanceKm: 65 }],
  // Secondary pairs — enough for launch routes + basic coverage.
  ['Ош', 'Манас', { durationMin: 2 * 60, distanceKm: 110 }],
  ['Ош', 'Баткен', { durationMin: 4 * 60, distanceKm: 190 }],
  ['Каракол', 'Чолпон-Ата', { durationMin: 2 * 60, distanceKm: 150 }],
];

function normalize(a: string, b: string): [string, string] {
  return a.localeCompare(b) <= 0 ? [a, b] : [b, a];
}

const TABLE: Map<string, RouteSpec> = new Map();
for (const [a, b, spec] of RAW_ROUTES) {
  const [lo, hi] = normalize(a, b);
  TABLE.set(`${lo}→${hi}`, spec);
}

/**
 * Lookup a route in either direction. Returns null if the pair is unknown;
 * the caller decides how to handle — typically falling back to a reasonable
 * default or rejecting the trip.
 */
export function lookupRoute(origin: string, destination: string): RouteSpec | null {
  const [lo, hi] = normalize(origin, destination);
  return TABLE.get(`${lo}→${hi}`) ?? null;
}

// Mountain roads: real road length ≈ 1.4 × straight-line distance, average
// intercity speed ≈ 60 km/h.
const ROAD_FACTOR = 1.4;
const AVG_SPEED_KMH = 60;

/**
 * Estimated duration in minutes: the reference table for well-known pairs,
 * otherwise straight-line distance × ROAD_FACTOR at AVG_SPEED_KMH (≥ 30 min).
 * Without coordinates, `fallback`.
 */
export function estimateDurationMin(
  origin: { nameRu: string; lat: number | null; lng: number | null },
  destination: { nameRu: string; lat: number | null; lng: number | null },
  fallback = 4 * 60,
): number {
  const known = lookupRoute(origin.nameRu, destination.nameRu);
  if (known) return known.durationMin;
  if (origin.lat === null || origin.lng === null || destination.lat === null || destination.lng === null) {
    return fallback;
  }
  const km = haversineKm(
    { lat: origin.lat, lng: origin.lng },
    { lat: destination.lat, lng: destination.lng },
  );
  return Math.max(30, Math.round(((km * ROAD_FACTOR) / AVG_SPEED_KMH) * 60 / 5) * 5);
}
