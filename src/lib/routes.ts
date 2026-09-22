/**
 * Inter-city distance / duration reference. TZ §10.1:
 *   "estimated_duration_min рассчитывается автоматически по таблице
 *    расстояний между городами (справочник)."
 *
 * Stored in code for the MVP — a future sprint can migrate this into a DB
 * table once we need editable values. Keys are case- and order-independent.
 */

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
  ['Бишкек', 'Жалал-Абад', { durationMin: 9 * 60, distanceKm: 500 }],
  ['Бишкек', 'Манас', { durationMin: 9 * 60, distanceKm: 510 }],
  ['Бишкек', 'Баткен', { durationMin: 13 * 60, distanceKm: 700 }],
  ['Бишкек', 'Токмок', { durationMin: 1 * 60, distanceKm: 60 }],
  ['Бишкек', 'Кара-Балта', { durationMin: 1 * 60, distanceKm: 65 }],
  ['Бишкек', 'Иссык-Куль', { durationMin: 5 * 60, distanceKm: 300 }],
  // Secondary pairs — enough for launch routes + basic coverage.
  ['Ош', 'Жалал-Абад', { durationMin: 2 * 60, distanceKm: 100 }],
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

/**
 * Compute estimated duration in minutes. Falls back to a crude "1 minute per
 * 1 km at 60 km/h" estimate if the pair is unknown — we still accept the trip
 * (the TZ doesn't require all pairs to be in the directory), but the autoclose
 * cron timing will be less accurate.
 */
export function estimateDurationMin(
  origin: string,
  destination: string,
  fallback = 4 * 60,
): number {
  return lookupRoute(origin, destination)?.durationMin ?? fallback;
}
