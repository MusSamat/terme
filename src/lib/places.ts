import type { Prisma, PrismaClient } from '@prisma/client';
import { Errors } from '@/lib/errors.js';
import { foldCyrillic } from '@/lib/translit.js';

// A settlement as clients see it on cards, details, maps and pickers.
export interface PlaceRef {
  id: number;
  type: string;
  nameRu: string;
  nameKg: string;
  lat: number | null;
  lng: number | null;
  // Disambiguates homonyms («Кара-Суу, Ноокенский район»). Null for cities.
  raion: { nameRu: string; nameKg: string } | null;
  oblast: { nameRu: string; nameKg: string } | null;
}

export const placeSelect = {
  id: true,
  type: true,
  nameRu: true,
  nameKg: true,
  lat: true,
  lng: true,
  raion: { select: { nameRu: true, nameKg: true } },
  oblast: { select: { nameRu: true, nameKg: true } },
} satisfies Prisma.CitySelect;

export type PlaceRow = Prisma.CityGetPayload<{ select: typeof placeSelect }>;

export function toPlaceRef(c: PlaceRow): PlaceRef {
  return {
    id: c.id,
    type: c.type,
    nameRu: c.nameRu,
    nameKg: c.nameKg,
    lat: c.lat,
    lng: c.lng,
    raion: c.raion,
    oblast: c.oblast,
  };
}

// Places a ride can start / end at.
const SETTLEMENT_TYPES = ['capital', 'city', 'town', 'village', 'airport'];

/**
 * Loads the given place ids (settlements only) or throws 400 unknown_city.
 * Returns them keyed by id.
 */
export async function loadPlaces(
  prisma: PrismaClient | Prisma.TransactionClient,
  ids: number[],
): Promise<Map<number, PlaceRow>> {
  const unique = [...new Set(ids)];
  const rows = await prisma.city.findMany({
    where: { id: { in: unique }, isActive: true, type: { in: SETTLEMENT_TYPES } },
    select: placeSelect,
  });
  if (rows.length !== unique.length) {
    const known = new Set(rows.map((r) => r.id));
    throw Errors.validation({ reason: 'unknown_city', ids: unique.filter((i) => !known.has(i)) });
  }
  return new Map(rows.map((r) => [r.id, r]));
}

/**
 * Resolves a free-text place name (SEO route pages, the Telegram bot, legacy
 * clients) to the most prominent matching settlement: exact name, then alias.
 * Returns null when nothing matches.
 */
export async function resolvePlaceByName(
  prisma: PrismaClient,
  name: string,
): Promise<number | null> {
  const folded = foldCyrillic(name.trim());
  if (!folded) return null;
  const rows = await prisma.$queryRaw<Array<{ id: number }>>`
    SELECT id FROM cities
    WHERE is_active AND is_searchable
      AND (name_ru_folded = ${folded} OR name_kg_folded = ${folded}
           OR ${folded} = ANY (SELECT kg_fold(a) FROM unnest(aliases) a))
    ORDER BY (name_ru_folded = ${folded} OR name_kg_folded = ${folded}) DESC,
             priority DESC, id
    LIMIT 1
  `;
  return rows[0]?.id ?? null;
}

// "Nearby" search tier: settlements within this radius of the searched one.
export const NEARBY_RADIUS_KM = 25;

/**
 * Ids of settlements within `radiusKm` of the given place (itself included),
 * by great-circle distance. Bounding-box prefilter keeps it on
 * cities_lat_lng_idx. Falls back to [id] for places without coordinates.
 */
export async function nearbyPlaceIds(
  prisma: PrismaClient,
  id: number,
  radiusKm = NEARBY_RADIUS_KM,
): Promise<number[]> {
  const dLat = radiusKm / 111;
  const rows = await prisma.$queryRaw<Array<{ id: number }>>`
    WITH c AS (SELECT lat, lng FROM cities WHERE id = ${id} AND lat IS NOT NULL)
    SELECT n.id FROM cities n, c
    WHERE n.is_searchable AND n.is_active AND n.lat IS NOT NULL
      AND n.lat BETWEEN c.lat - ${dLat} AND c.lat + ${dLat}
      AND n.lng BETWEEN c.lng - ${dLat} / cos(radians(c.lat)) AND c.lng + ${dLat} / cos(radians(c.lat))
      AND 2 * 6371 * asin(sqrt(
            sin(radians(n.lat - c.lat) / 2) ^ 2 +
            cos(radians(c.lat)) * cos(radians(n.lat)) * sin(radians(n.lng - c.lng) / 2) ^ 2
          )) <= ${radiusKm}
    LIMIT 300
  `;
  const ids = new Set(rows.map((r) => r.id));
  ids.add(id);
  return [...ids];
}

export function haversineKm(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
): number {
  const rad = Math.PI / 180;
  const h =
    Math.sin(((b.lat - a.lat) * rad) / 2) ** 2 +
    Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(((b.lng - a.lng) * rad) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

// An area pin label is only used when the pin is this close to the area point.
const AREA_MAX_KM = 1.5;

/** Nearest жилмассив / микрорайон of the place to a pin, or null. */
export async function nearestAreaId(
  prisma: PrismaClient | Prisma.TransactionClient,
  cityId: number,
  point: { lat: number; lng: number } | null | undefined,
): Promise<number | null> {
  if (!point) return null;
  const areas = await prisma.cityArea.findMany({
    where: { cityId },
    select: { id: true, lat: true, lng: true },
  });
  let best: { id: number; km: number } | null = null;
  for (const a of areas) {
    const km = haversineKm(point, a);
    if (km <= AREA_MAX_KM && (!best || km < best.km)) best = { id: a.id, km };
  }
  return best?.id ?? null;
}
