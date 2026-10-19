import { Prisma, type PrismaClient } from '@prisma/client';
import { Errors } from '@/lib/errors.js';
import { foldCyrillic, latinToCyrillic, layoutToCyrillic } from '@/lib/translit.js';
import { DEPARTURE_BUFFER_MIN, suggestPickup, type FlightType } from '@/lib/airport.js';
import {
  AIRPORT_END_TYPES,
  haversineKm,
  placeSelect,
  resolvePlaceByName,
  toPlaceRef,
  type PlaceRef,
  type PlaceRow,
} from '@/lib/places.js';

// Popular intercity routes (names resolve to directory ids once, then cached).
const POPULAR_ROUTES: Array<[string, string]> = [
  ['Бишкек', 'Ош'],
  ['Ош', 'Бишкек'],
  ['Бишкек', 'Каракол'],
  ['Бишкек', 'Нарын'],
  ['Бишкек', 'Манас'],
  ['Ош', 'Манас'],
  ['Бишкек', 'Талас'],
  ['Бишкек', 'Балыкчы'],
  ['Ош', 'Баткен'],
  ['Бишкек', 'Токмок'],
  ['Бишкек', 'Чолпон-Ата'],
  ['Ош', 'Кара-Суу'],
];

// Where intercity rides usually start inside the big cities — one-tap pins in
// the create forms (the user can still drag the pin). Approximate points.
export interface MeetingSpot {
  // spot = well-known departure point, area = жилмассив / микрорайон.
  kind?: 'spot' | 'area';
  nameRu: string;
  nameKg: string;
  lat: number;
  lng: number;
  // Approximate point (airport terminals) — to be refined by an admin.
  approx?: boolean;
}

const SPOTS: Record<string, MeetingSpot[]> = {
  Бишкек: [
    { nameRu: 'Западный автовокзал', nameKg: 'Батыш автобекети', lat: 42.8769, lng: 74.565 },
    { nameRu: 'Восточный автовокзал', nameKg: 'Чыгыш автобекети', lat: 42.8826, lng: 74.6316 },
    { nameRu: 'Ошский базар', nameKg: 'Ош базары', lat: 42.8748, lng: 74.5802 },
    { nameRu: 'ЦУМ', nameKg: 'ЦУМ', lat: 42.8762, lng: 74.6146 },
    { nameRu: 'Аламединский рынок', nameKg: 'Аламүдүн базары', lat: 42.8857, lng: 74.6355 },
    { nameRu: 'Дордой', nameKg: 'Дордой', lat: 42.937, lng: 74.617 },
  ],
  Ош: [
    { nameRu: 'Центральный автовокзал', nameKg: 'Борбордук автобекет', lat: 40.5297, lng: 72.7946 },
    { nameRu: 'Ошский базар (Жайма)', nameKg: 'Ош базары (Жайма)', lat: 40.5303, lng: 72.7976 },
  ],
};

// Where transfer drivers meet passengers, keyed by the airport's soate_code.
// Approximate points at the terminals (approx: true).
const AIRPORT_SPOTS: Record<string, MeetingSpot[]> = {
  'airport:FRU': [
    {
      nameRu: 'Выход из зоны прилёта (международный терминал)',
      nameKg: 'Келүү аймагынан чыгуу (эл аралык терминал)',
      lat: 43.0607,
      lng: 74.4787,
      approx: true,
    },
    { nameRu: 'Внутренний терминал', nameKg: 'Ички терминал', lat: 43.0603, lng: 74.4752, approx: true },
    { nameRu: 'Парковка P1', nameKg: 'P1 унаа токтотуучу жайы', lat: 43.0594, lng: 74.4779, approx: true },
  ],
  'airport:OSS': [
    { nameRu: 'Выход из зоны прилёта', nameKg: 'Келүү аймагынан чыгуу', lat: 40.6086, lng: 72.7938, approx: true },
    {
      nameRu: 'Парковка у терминала',
      nameKg: 'Терминалдын жанындагы унаа токтотуучу жай',
      lat: 40.6079,
      lng: 72.7929,
      approx: true,
    },
  ],
};

// Transfer airports: display title, default flight type, popular other ends
// (by soate_code — the directory spells Жалал-Абад «Манас», 41703410000010).
// Airports not listed here (re-enabled by an admin) fall back to their name,
// domestic flights and the served city.
const AIRPORT_META: Record<
  string,
  { titleRu: string; titleKg: string; flightType: FlightType; popular: string[] }
> = {
  'airport:FRU': {
    titleRu: 'Манас · Бишкек',
    titleKg: 'Манас · Бишкек',
    flightType: 'international',
    // Бишкек, Кант, Токмок, Кара-Балта, Чолпон-Ата, Балыкчы
    popular: ['41711000000000', '41708410000010', '41708400000010', '41708420000010', '41702215600010', '41702420000010'],
  },
  'airport:OSS': {
    titleRu: 'Ош',
    titleKg: 'Ош',
    flightType: 'domestic',
    // Ош, Жалал-Абад, Өзгөн, Кара-Суу, Ноокат
    popular: ['41721000000000', '41703410000010', '41706255600010', '41706226600010', '41706242600010'],
  },
};

export interface AirportDto extends PlaceRef {
  serves: PlaceRef | null;
  titleRu: string;
  titleKg: string;
  // Default of the «международный / внутренний» toggle.
  flightType: FlightType;
  // Minutes to be at the airport before departure, per flight type.
  departureBufferMin: Record<FlightType, number>;
  // Quick chips for the other end; the served city first.
  popularDestinations: PlaceRef[];
}

export interface PickupSuggestionDto {
  pickupAt: string;
  travelMin: number;
  bufferMin: number;
  distanceKm: number;
  flightType: FlightType;
}

export interface PopularRoute {
  from: string;
  to: string;
  fromId: number;
  toId: number;
  // Kyrgyz names (from/to are Russian).
  fromKg: string;
  toKg: string;
  tripCount: number;
  minPrice: number | null;
}

// Trip counts change slowly: at most one DB query per POPULAR_CACHE_MS.
const POPULAR_CACHE_MS = Number(process.env.POPULAR_ROUTES_CACHE_MS ?? 30_000);

export function createCitiesService(prisma: PrismaClient) {
  let routeIds: Array<{
    from: string;
    to: string;
    fromId: number;
    toId: number;
    fromKg: string;
    toKg: string;
  }> | null = null;
  let popularCache: { value: PopularRoute[]; at: number } | null = null;

  /**
   * Autocomplete over settlements. Users type however they can — Latin
   * («uzgen»), the wrong keyboard layout («<birtr» = «Бишкек»), RU or KG
   * letters — every variant is folded (kg_fold) and matched on the
   * trigram-indexed *_folded columns. Prefix hits rank first, then prominence.
   */
  // scope=any also finds administrative areas (район, айыл аймак, city
  // districts) — the non-airport end of a transfer may be any of them.
  async function search(q: string, limit: number, scope: 'settlements' | 'any' = 'settlements'): Promise<PlaceRef[]> {
    const candidates = new Set<string>([foldCyrillic(q)]);
    if (/[a-z<>,.;:'"[\]{}`~]/i.test(q)) {
      candidates.add(foldCyrillic(latinToCyrillic(q)));
      candidates.add(foldCyrillic(layoutToCyrillic(q)));
    }
    const terms = [...candidates].filter(Boolean);
    if (terms.length === 0) return top(limit);
    const match = Prisma.join(
      terms.map(
        (t) => Prisma.sql`name_ru_folded LIKE ${`%${t}%`} OR name_kg_folded LIKE ${`%${t}%`}
                          OR aliases_folded LIKE ${`%${t}%`}`,
      ),
      ' OR ',
    );
    const prefix = Prisma.join(
      terms.map((t) => Prisma.sql`name_ru_folded LIKE ${`${t}%`} OR name_kg_folded LIKE ${`${t}%`}`),
      ' OR ',
    );
    const rows = await prisma.$queryRaw<Array<{ id: number }>>`
      SELECT id FROM cities
      WHERE is_active AND (${match})
        AND (is_searchable OR (${scope === 'any'} AND type IN (${Prisma.join(AIRPORT_END_TYPES)})))
      ORDER BY (${prefix}) DESC, priority DESC, name_ru ASC
      LIMIT ${limit}
    `;
    return byIds(rows.map((r) => r.id));
  }

  // Empty query: the most prominent places (capitals, cities, towns).
  async function top(limit: number): Promise<PlaceRef[]> {
    const rows = await prisma.city.findMany({
      where: { isActive: true, isSearchable: true },
      orderBy: [{ priority: 'desc' }, { nameRu: 'asc' }],
      take: limit,
      select: placeSelect,
    });
    return rows.map(toPlaceRef);
  }

  // The settlement a GPS point is in (nearest one) — prefills «Откуда».
  async function nearest(lat: number, lng: number): Promise<PlaceRef | null> {
    const rows = await prisma.$queryRaw<Array<{ id: number }>>`
      SELECT id FROM cities
      WHERE is_active AND is_searchable AND lat IS NOT NULL
        AND lat BETWEEN ${lat - 0.5} AND ${lat + 0.5}
        AND lng BETWEEN ${lng - 0.7} AND ${lng + 0.7}
      ORDER BY (lat - ${lat}) ^ 2 + ((lng - ${lng}) * cos(radians(${lat}))) ^ 2,
               priority DESC
      LIMIT 1
    `;
    const [place] = await byIds(rows.map((r) => r.id));
    return place ?? null;
  }

  async function byIds(ids: number[]): Promise<PlaceRef[]> {
    if (ids.length === 0) return [];
    const rows = await prisma.city.findMany({ where: { id: { in: ids } }, select: placeSelect });
    const map = new Map(rows.map((r) => [r.id, toPlaceRef(r)]));
    return ids.flatMap((id) => (map.has(id) ? [map.get(id)!] : []));
  }

  async function popularRoutes(): Promise<PopularRoute[]> {
    if (popularCache && Date.now() - popularCache.at < POPULAR_CACHE_MS) return popularCache.value;
    if (!routeIds) {
      const resolved = await Promise.all(
        POPULAR_ROUTES.map(async ([from, to]) => ({
          from,
          to,
          fromId: await resolvePlaceByName(prisma, from),
          toId: await resolvePlaceByName(prisma, to),
        })),
      );
      const ids = resolved.flatMap((r) => [r.fromId, r.toId]).filter((x): x is number => x !== null);
      const kg = new Map(
        (await prisma.city.findMany({ where: { id: { in: ids } }, select: { id: true, nameKg: true } })).map(
          (c) => [c.id, c.nameKg],
        ),
      );
      routeIds = resolved.flatMap((r) =>
        r.fromId !== null && r.toId !== null
          ? [
              {
                ...r,
                fromId: r.fromId,
                toId: r.toId,
                fromKg: kg.get(r.fromId) ?? r.from,
                toKg: kg.get(r.toId) ?? r.to,
              },
            ]
          : [],
      );
    }
    if (routeIds.length === 0) return [];
    const pairs = Prisma.join(routeIds.map((r) => Prisma.sql`(${r.fromId}::int, ${r.toId}::int)`));
    const rows = await prisma.$queryRaw<
      Array<{ origin_city_id: number; destination_city_id: number; n: number; min_price: number | null }>
    >`
      SELECT origin_city_id, destination_city_id, COUNT(*)::int AS n, MIN(price_per_seat)::int AS min_price
      FROM trips
      WHERE status = 'active' AND departure_at > NOW()
        AND (origin_city_id, destination_city_id) IN (${pairs})
      GROUP BY 1, 2
    `;
    const stats = new Map(rows.map((r) => [`${r.origin_city_id}|${r.destination_city_id}`, r]));
    const value = routeIds.map((r) => {
      const s = stats.get(`${r.fromId}|${r.toId}`);
      return { ...r, tripCount: s?.n ?? 0, minPrice: s?.min_price ?? null };
    });
    popularCache = { value, at: Date.now() };
    return value;
  }

  // Pin picker inside Бишкек / Ош: well-known departure spots first, then
  // жилмассивы; `q` filters both (RU / KG folded).
  async function spots(id: number, q?: string): Promise<MeetingSpot[]> {
    const city = await prisma.city.findUnique({
      where: { id },
      select: { nameRu: true, type: true, soateCode: true },
    });
    if (city?.type !== 'capital' && city?.type !== 'airport') return [];
    const folded = q ? foldCyrillic(q.trim()) : '';
    const hit = (s: { nameRu: string; nameKg: string }) =>
      !folded || foldCyrillic(s.nameRu).includes(folded) || foldCyrillic(s.nameKg).includes(folded);
    const areas = await prisma.cityArea.findMany({
      where: { cityId: id },
      orderBy: { nameRu: 'asc' },
      select: { nameRu: true, nameKg: true, lat: true, lng: true },
    });
    const known = city.type === 'airport' ? (AIRPORT_SPOTS[city.soateCode] ?? []) : (SPOTS[city.nameRu] ?? []);
    return [
      ...known.filter(hit).map((s) => ({ kind: 'spot' as const, ...s })),
      ...areas.filter(hit).map((a) => ({ kind: 'area' as const, ...a })),
    ];
  }

  // Active transfer airports with the city each one serves (nearest capital /
  // city) — the «Аэропорт» entry point pairs them: «Манас» ↔ Бишкек, Ош ↔ Ош.
  // Inactive airports (admin-disabled) are left out; their old rides still read.
  async function airports(): Promise<AirportDto[]> {
    const rows = await prisma.city.findMany({
      where: { type: 'airport', isActive: true },
      orderBy: [{ priority: 'desc' }, { id: 'asc' }],
      select: { ...placeSelect, soateCode: true },
    });
    if (rows.length === 0) return [];
    const cities = await prisma.city.findMany({
      where: { type: { in: ['capital', 'city'] }, isActive: true, lat: { not: null } },
      select: placeSelect,
    });
    const codes = rows.flatMap((a) => AIRPORT_META[a.soateCode]?.popular ?? []);
    const popular = new Map(
      (
        await prisma.city.findMany({
          where: { soateCode: { in: codes }, isActive: true },
          select: { ...placeSelect, soateCode: true },
        })
      ).map(({ soateCode, ...p }) => [soateCode, toPlaceRef(p)]),
    );
    return rows.map(({ soateCode, ...a }) => {
      let serves: PlaceRow | null = null;
      let best = Number.POSITIVE_INFINITY;
      for (const c of cities) {
        if (a.lat === null || a.lng === null || c.lat === null || c.lng === null) continue;
        const km = haversineKm({ lat: a.lat, lng: a.lng }, { lat: c.lat, lng: c.lng });
        // Prefer the capital when it is roughly as close (Манас airport → Бишкек).
        const score = c.type === 'capital' ? km * 0.5 : km;
        if (score < best) {
          best = score;
          serves = c;
        }
      }
      const servesRef = serves ? toPlaceRef(serves) : null;
      const meta = AIRPORT_META[soateCode];
      const chips = (meta?.popular ?? []).flatMap((code) => (popular.has(code) ? [popular.get(code)!] : []));
      if (servesRef && !chips.some((p) => p.id === servesRef.id)) chips.unshift(servesRef);
      return {
        ...toPlaceRef(a),
        serves: servesRef,
        titleRu: meta?.titleRu ?? a.nameRu,
        titleKg: meta?.titleKg ?? a.nameKg,
        flightType: meta?.flightType ?? 'domestic',
        departureBufferMin: { ...DEPARTURE_BUFFER_MIN },
        popularDestinations: chips,
      };
    });
  }

  // «Во сколько выезжать»: flight departure − check-in buffer − travel time
  // from the other end (straight line at 50 km/h, rounded up to 15 min).
  async function pickupSuggestion(
    airportId: number,
    fromId: number,
    flightTime: Date,
    flightType?: FlightType,
  ): Promise<PickupSuggestionDto> {
    const airport = await prisma.city.findFirst({
      where: { id: airportId, type: 'airport', isActive: true },
      select: { lat: true, lng: true, soateCode: true },
    });
    if (!airport) throw Errors.notFound('Airport');
    const from = await prisma.city.findFirst({
      where: { id: fromId, isActive: true },
      select: { lat: true, lng: true },
    });
    if (!from) throw Errors.validation({ reason: 'unknown_city', ids: [fromId] });
    if (airport.lat === null || airport.lng === null || from.lat === null || from.lng === null) {
      throw Errors.validation({ reason: 'no_coordinates' });
    }
    const s = suggestPickup(
      { lat: from.lat, lng: from.lng },
      { lat: airport.lat, lng: airport.lng },
      flightTime,
      flightType ?? AIRPORT_META[airport.soateCode]?.flightType ?? 'domestic',
    );
    return { ...s, pickupAt: s.pickupAt.toISOString() };
  }

  return { search, top, nearest, byIds, popularRoutes, spots, airports, pickupSuggestion };
}
