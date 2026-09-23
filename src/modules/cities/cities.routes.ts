import { Router } from 'express';
import { Prisma, type PrismaClient } from '@prisma/client';
import { asyncHandler } from '@/middleware/errorHandler.js';
import {
  foldCyrillic,
  latinToCyrillic,
  layoutToCyrillic,
} from '@/lib/translit.js';

/**
 * Public city directory — used by client autocompletes.
 * TZ §19.2 Utility: "GET /cities · Список активных городов КГ · Нет (Auth)".
 *
 * GET /cities?q=биш&limit=10  → autocomplete (max 20)
 * GET /cities                 → full list (max 1000)
 * GET /cities/popular-routes  → static popular KG routes
 */

interface CityRow {
  id: number;
  type: string;
  name_ru: string;
  name_kg: string;
  name_en: string;
  region_name_ru: string;
  region_name_kg: string;
  district_name_ru: string | null;
  district_name_kg: string | null;
  aiyl_aimak_name_ru: string | null;
  aiyl_aimak_name_kg: string | null;
  lat: number | null;
  lng: number | null;
}

function toDto(r: CityRow) {
  return {
    id: r.id,
    type: r.type, // city | town | village | raion … — client labels район/шаар
    nameRu: r.name_ru,
    nameKg: r.name_kg,
    nameEn: r.name_en,
    regionNameRu: r.region_name_ru,
    regionNameKg: r.region_name_kg,
    districtNameRu: r.district_name_ru ?? null,
    districtNameKg: r.district_name_kg ?? null,
    aiylAimakNameRu: r.aiyl_aimak_name_ru ?? null,
    aiylAimakNameKg: r.aiyl_aimak_name_kg ?? null,
    lat: r.lat,
    lng: r.lng,
  };
}

// Popular intercity routes for Kyrgyzstan (from/to city names must match name_ru in DB).
const POPULAR_ROUTES = [
  { from: 'Бишкек', to: 'Ош' },
  { from: 'Ош', to: 'Бишкек' },
  { from: 'Бишкек', to: 'Каракол' },
  { from: 'Бишкек', to: 'Нарын' },
  { from: 'Бишкек', to: 'Манас' },
  { from: 'Ош', to: 'Манас' },
  { from: 'Бишкек', to: 'Талас' },
  { from: 'Бишкек', to: 'Балыкчы' },
  { from: 'Ош', to: 'Баткен' },
  { from: 'Бишкек', to: 'Токмок' },
  { from: 'Бишкек', to: 'Кант' },
  { from: 'Ош', to: 'Кара-Суу' },
];

interface PopularRoute { from: string; to: string; tripCount: number; minPrice: number | null }

// Process-local cache for the public, uncached /popular-routes endpoint: the
// route set is static and trip counts change slowly, so serve at most one DB
// query per POPULAR_CACHE_MS (mirrors the presence online-count cache pattern).
const POPULAR_CACHE_MS = Number(process.env.POPULAR_ROUTES_CACHE_MS ?? 30_000);

export function createCitiesRouter(prisma: PrismaClient): Router {
  const router = Router();

  let popularRoutesCache: { value: PopularRoute[]; at: number } | null = null;

  // Popular routes with live trip counts — defined before '/' to avoid param conflict.
  router.get(
    '/popular-routes',
    asyncHandler(async (_req, res) => {
      const cached = popularRoutesCache;
      if (cached && Date.now() - cached.at < POPULAR_CACHE_MS) {
        res.json({ data: cached.value });
        return;
      }

      // Count active trips for each predefined route in a single query.
      interface CountRow { from_city: string; to_city: string; trip_count: bigint; min_price: bigint | null }
      // Parameterised tuple list via Prisma.join — no string interpolation into SQL.
      const routePairs = Prisma.join(
        POPULAR_ROUTES.map((r) => Prisma.sql`(${r.from}, ${r.to})`),
      );
      const rows = await prisma.$queryRaw<CountRow[]>`
        SELECT origin_city AS from_city, destination_city AS to_city,
               COUNT(*) AS trip_count, MIN(price_per_seat) AS min_price
        FROM trips
        WHERE status = 'active'
          AND departure_at > NOW()
          AND (origin_city, destination_city) IN (${routePairs})
        GROUP BY origin_city, destination_city
      `;

      const counts = new Map(rows.map((r) => [`${r.from_city}|${r.to_city}`, { count: Number(r.trip_count), minPrice: r.min_price ? Number(r.min_price) : null }]));

      const data: PopularRoute[] = POPULAR_ROUTES.map((r) => {
        const stats = counts.get(`${r.from}|${r.to}`) ?? { count: 0, minPrice: null };
        return { from: r.from, to: r.to, tripCount: stats.count, minPrice: stats.minPrice };
      });

      popularRoutesCache = { value: data, at: Date.now() };
      res.json({ data });
    }),
  );

  router.get(
    '/',
    asyncHandler(async (req, res) => {
      const q = typeof req.query['q'] === 'string' ? req.query['q'].trim() : '';
      const limitRaw = parseInt(String(req.query['limit'] ?? ''), 10);
      // Clamp to a positive range: a negative/zero limit (e.g. ?limit=-5) would
      // reach Postgres as `LIMIT -5` and 500. Math.max floors it at 1.
      const limit = q
        ? Math.min(Math.max(isNaN(limitRaw) ? 10 : limitRaw, 1), 20)
        : Math.min(Math.max(isNaN(limitRaw) ? 1000 : limitRaw, 1), 1000);

      if (q) {
        // Use raw SQL so we can do ILIKE on both scalar columns AND array elements
        // (Prisma's `has` only does exact element match, not substring search).
        const pattern = `%${q}%`;
        // Пользователь набирает как умеет: латиницей («jalal», «uzgen») или в
        // не той раскладке («<birtr» = «Бишкек»). Приводим запрос к кириллице
        // обоими способами и сравниваем с name_ru/name_kg, сведя RU/KG-буквы
        // к одному виду (ё→е, ө→о, ү→у, ң→н) — «озгон» находит «Өзгөн».
        const candidates = new Set<string>([foldCyrillic(q)]);
        if (/[a-z<>,.;:'"[\]{}`~]/i.test(q)) {
          candidates.add(foldCyrillic(latinToCyrillic(q)));
          candidates.add(foldCyrillic(layoutToCyrillic(q)));
        }
        // Filter on the pre-folded, trigram-indexed columns
        // (name_ru_folded / name_kg_folded / prompt_folded — migration
        // 20260923123000_cities_search_perf) instead of recomputing
        // translate(lower(...)) per row, so the GIN pg_trgm indexes serve the
        // substring LIKE. The columns hold the exact same folding expression,
        // so результаты идентичны — только теперь index-backed.
        const cyrCond = Prisma.join(
          [...candidates].map(
            (c) => Prisma.sql`
              name_ru_folded LIKE ${`%${c}%`}
              OR name_kg_folded LIKE ${`%${c}%`}
              OR prompt_folded LIKE ${`%${c}%`}`,
          ),
          ' OR ',
        );
        const rows = await prisma.$queryRaw<CityRow[]>`
          SELECT id, type, name_ru, name_kg, name_en,
                 region_name_ru, region_name_kg,
                 district_name_ru, district_name_kg,
                 aiyl_aimak_name_ru, aiyl_aimak_name_kg,
                 lat, lng
          FROM cities
          WHERE is_active = true
            AND is_searchable = true
            -- Hide oblasts (never a destination). Raions are governed by
            -- is_searchable — only same-named ones (e.g. «Баткен район» next to
            -- the город Баткен) are enabled; the client tags each result
            -- «район» / «город» so homonyms read clearly.
            AND type <> 'oblast'
            AND (
              -- name_en_lower / prompt_folded are trigram-indexed; ILIKE is
              -- just case-insensitive LIKE, so LIKE lower(pattern) on the
              -- lowered column is equivalent and index-backed.
              name_en_lower LIKE ${pattern.toLowerCase()}
              OR prompt_folded LIKE ${pattern.toLowerCase()}
              OR ${cyrCond}
            )
          ORDER BY priority DESC, name_ru ASC
          LIMIT ${limit}
        `;
        res.json({ data: rows.map(toDto) });
      } else {
        const rows = await prisma.$queryRaw<CityRow[]>`
          SELECT id, type, name_ru, name_kg, name_en,
                 region_name_ru, region_name_kg,
                 district_name_ru, district_name_kg,
                 aiyl_aimak_name_ru, aiyl_aimak_name_kg,
                 lat, lng
          FROM cities
          WHERE is_active = true
            AND is_searchable = true
            -- Hide oblasts (never a destination). Raions are governed by
            -- is_searchable — only same-named ones (e.g. «Баткен район» next to
            -- the город Баткен) are enabled; the client tags each result
            -- «район» / «город» so homonyms read clearly.
            AND type <> 'oblast'
          ORDER BY priority DESC, name_ru ASC
          LIMIT ${limit}
        `;
        res.json({ data: rows.map(toDto) });
      }
    }),
  );

  return router;
}
