import { Prisma, type PrismaClient } from '@prisma/client';
import { foldCyrillic, latinToCyrillic, layoutToCyrillic } from '@/lib/translit.js';
import {
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

export interface PopularRoute {
  from: string;
  to: string;
  fromId: number;
  toId: number;
  tripCount: number;
  minPrice: number | null;
}

// Trip counts change slowly: at most one DB query per POPULAR_CACHE_MS.
const POPULAR_CACHE_MS = Number(process.env.POPULAR_ROUTES_CACHE_MS ?? 30_000);

export function createCitiesService(prisma: PrismaClient) {
  let routeIds: Array<{ from: string; to: string; fromId: number; toId: number }> | null = null;
  let popularCache: { value: PopularRoute[]; at: number } | null = null;

  /**
   * Autocomplete over settlements. Users type however they can — Latin
   * («uzgen»), the wrong keyboard layout («<birtr» = «Бишкек»), RU or KG
   * letters — every variant is folded (kg_fold) and matched on the
   * trigram-indexed *_folded columns. Prefix hits rank first, then prominence.
   */
  async function search(q: string, limit: number): Promise<PlaceRef[]> {
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
      WHERE is_active AND is_searchable AND (${match})
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
      routeIds = resolved.flatMap((r) =>
        r.fromId !== null && r.toId !== null ? [{ ...r, fromId: r.fromId, toId: r.toId }] : [],
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
    const city = await prisma.city.findUnique({ where: { id }, select: { nameRu: true, type: true } });
    if (city?.type !== 'capital') return [];
    const folded = q ? foldCyrillic(q.trim()) : '';
    const hit = (s: { nameRu: string; nameKg: string }) =>
      !folded || foldCyrillic(s.nameRu).includes(folded) || foldCyrillic(s.nameKg).includes(folded);
    const areas = await prisma.cityArea.findMany({
      where: { cityId: id },
      orderBy: { nameRu: 'asc' },
      select: { nameRu: true, nameKg: true, lat: true, lng: true },
    });
    return [
      ...(SPOTS[city.nameRu] ?? []).filter(hit).map((s) => ({ kind: 'spot' as const, ...s })),
      ...areas.filter(hit).map((a) => ({ kind: 'area' as const, ...a })),
    ];
  }

  // Airports with the city each one serves (nearest capital / city) — the
  // «Аэропорт» entry point pairs them: Бишкек ↔ «Манас», Ош ↔ Ош.
  async function airports(): Promise<Array<PlaceRef & { serves: PlaceRef | null }>> {
    const rows = await prisma.city.findMany({
      where: { type: 'airport', isActive: true },
      orderBy: [{ priority: 'desc' }, { id: 'asc' }],
      select: placeSelect,
    });
    const cities = await prisma.city.findMany({
      where: { type: { in: ['capital', 'city'] }, isActive: true, lat: { not: null } },
      select: placeSelect,
    });
    return rows.map((a) => {
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
      return { ...toPlaceRef(a), serves: serves ? toPlaceRef(serves) : null };
    });
  }

  return { search, top, nearest, byIds, popularRoutes, spots, airports };
}
