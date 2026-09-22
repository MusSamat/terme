import { Router } from 'express';
import { Prisma, type PrismaClient } from '@prisma/client';
import { asyncHandler } from '@/middleware/errorHandler.js';
import {
  CYR_FOLD_FROM,
  CYR_FOLD_TO,
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
  { from: 'Бишкек', to: 'Джалал-Абад' },
  { from: 'Ош', to: 'Джалал-Абад' },
  { from: 'Бишкек', to: 'Талас' },
  { from: 'Бишкек', to: 'Балыкчы' },
  { from: 'Ош', to: 'Баткен' },
  { from: 'Бишкек', to: 'Токмок' },
  { from: 'Бишкек', to: 'Кант' },
  { from: 'Ош', to: 'Кара-Суу' },
];

export function createCitiesRouter(prisma: PrismaClient): Router {
  const router = Router();

  // Popular routes with live trip counts — defined before '/' to avoid param conflict.
  router.get(
    '/popular-routes',
    asyncHandler(async (_req, res) => {
      // Count active trips for each predefined route in a single query.
      interface CountRow { from_city: string; to_city: string; trip_count: bigint; min_price: bigint | null }
      const routePairs = POPULAR_ROUTES.map((r) => `('${r.from}','${r.to}')`).join(',');
      const rows = await prisma.$queryRawUnsafe<CountRow[]>(`
        SELECT origin_city AS from_city, destination_city AS to_city,
               COUNT(*) AS trip_count, MIN(price_per_seat) AS min_price
        FROM trips
        WHERE status = 'active'
          AND departure_at > NOW()
          AND (origin_city, destination_city) IN (${routePairs})
        GROUP BY origin_city, destination_city
      `);

      const counts = new Map(rows.map((r) => [`${r.from_city}|${r.to_city}`, { count: Number(r.trip_count), minPrice: r.min_price ? Number(r.min_price) : null }]));

      const data = POPULAR_ROUTES.map((r) => {
        const stats = counts.get(`${r.from}|${r.to}`) ?? { count: 0, minPrice: null };
        return { from: r.from, to: r.to, tripCount: stats.count, minPrice: stats.minPrice };
      });

      res.json({ data });
    }),
  );

  router.get(
    '/',
    asyncHandler(async (req, res) => {
      const q = typeof req.query['q'] === 'string' ? req.query['q'].trim() : '';
      const limitRaw = parseInt(String(req.query['limit'] ?? ''), 10);
      const limit = q
        ? Math.min(isNaN(limitRaw) ? 10 : limitRaw, 20)
        : Math.min(isNaN(limitRaw) ? 1000 : limitRaw, 1000);

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
        const cyrCond = Prisma.join(
          [...candidates].map(
            (c) => Prisma.sql`
              translate(lower(name_ru), ${CYR_FOLD_FROM}, ${CYR_FOLD_TO}) LIKE ${`%${c}%`}
              OR translate(lower(name_kg), ${CYR_FOLD_FROM}, ${CYR_FOLD_TO}) LIKE ${`%${c}%`}
              OR EXISTS (
                SELECT 1 FROM unnest(prompt) AS p
                WHERE translate(lower(p), ${CYR_FOLD_FROM}, ${CYR_FOLD_TO}) LIKE ${`%${c}%`}
              )`,
          ),
          ' OR ',
        );
        const rows = await prisma.$queryRaw<CityRow[]>`
          SELECT id, name_ru, name_kg, name_en,
                 region_name_ru, region_name_kg,
                 district_name_ru, district_name_kg,
                 aiyl_aimak_name_ru, aiyl_aimak_name_kg,
                 lat, lng
          FROM cities
          WHERE is_active = true
            AND is_searchable = true
            -- Only settlements are travel destinations. Exclude administrative
            -- areas (oblast, raion) — they duplicate the same-named city/town
            -- («Баткен» область/район vs the город Баткен) and aren't pickable
            -- destinations. The city keeps «…району» as its subtitle for context.
            AND type NOT IN ('oblast', 'raion')
            AND (
              name_en ILIKE ${pattern}
              OR EXISTS (
                SELECT 1 FROM unnest(prompt) AS p
                WHERE p ILIKE ${pattern}
              )
              OR ${cyrCond}
            )
          ORDER BY priority DESC, name_ru ASC
          LIMIT ${limit}
        `;
        res.json({ data: rows.map(toDto) });
      } else {
        const rows = await prisma.$queryRaw<CityRow[]>`
          SELECT id, name_ru, name_kg, name_en,
                 region_name_ru, region_name_kg,
                 district_name_ru, district_name_kg,
                 aiyl_aimak_name_ru, aiyl_aimak_name_kg,
                 lat, lng
          FROM cities
          WHERE is_active = true
            AND is_searchable = true
            -- Only settlements are travel destinations. Exclude administrative
            -- areas (oblast, raion) — they duplicate the same-named city/town
            -- («Баткен» область/район vs the город Баткен) and aren't pickable
            -- destinations. The city keeps «…району» as its subtitle for context.
            AND type NOT IN ('oblast', 'raion')
          ORDER BY priority DESC, name_ru ASC
          LIMIT ${limit}
        `;
        res.json({ data: rows.map(toDto) });
      }
    }),
  );

  return router;
}
