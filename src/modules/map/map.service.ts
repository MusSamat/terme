import { Prisma, type PrismaClient } from '@prisma/client';
import { bishkekDayRange } from '@/lib/dates.js';
import type { MapQueryInput } from '@/modules/cities/cities.schemas.js';

// Each listing sits at its exact pin (driver's boarding spot / where the
// passenger waits) or, without one, at its settlement. Points are grid-clustered
// on the server so clients render plain markers with no clustering library.
export interface MapItem {
  id: string;
  lat: number;
  lng: number;
  // false = no pin, the point is the settlement centre.
  exact: boolean;
  originCity: string;
  destinationCity: string;
  destinationCityId: number;
  departureAt: string;
  seats: number;
  price: number | null;
}

export interface MapCluster {
  lat: number;
  lng: number;
  count: number;
}

// Grid cell ≈ 64 px at the given zoom (256 px tiles); no clustering from z14.
function cellDegrees(zoom: number): number | null {
  return zoom >= 14 ? null : 90 / 2 ** zoom;
}

const MAX_ITEMS = 300;

interface Row {
  id: string;
  lat: number;
  lng: number;
  exact: boolean;
  origin_city: string;
  destination_city: string;
  destination_city_id: number;
  departure_at: Date;
  seats: number;
  price: number | null;
}

export function createMapService(prisma: PrismaClient) {
  async function listings(q: MapQueryInput): Promise<{ items: MapItem[]; clusters: MapCluster[] }> {
    const now = new Date();
    let from = now;
    let to: Date | null = null;
    if (q.date) {
      const day = bishkekDayRange(new Date(q.date));
      from = day.start > now ? day.start : now;
      to = day.end;
    }
    const { west, south, east, north } = q.bbox;

    const base =
      q.kind === 'trips'
        ? Prisma.sql`
            SELECT t.id, COALESCE(t.origin_lat, c.lat) AS lat, COALESCE(t.origin_lng, c.lng) AS lng,
                   (t.origin_lat IS NOT NULL) AS exact, t.origin_city, t.destination_city,
                   t.destination_city_id, t.departure_at, t.seats_available::int AS seats,
                   t.price_per_seat AS price
            FROM trips t
            JOIN cities c ON c.id = t.origin_city_id
            JOIN users u ON u.id = t.driver_id
            WHERE t.status = 'active' AND t.seats_available > 0
              AND u.is_blocked = false AND u.deleted_at IS NULL
              AND t.departure_at >= ${from}
              ${to ? Prisma.sql`AND t.departure_at < ${to}` : Prisma.empty}
              ${q.to_id ? Prisma.sql`AND t.destination_city_id = ${q.to_id}` : Prisma.empty}
              ${q.ride ? Prisma.sql`AND t.kind = ${q.ride}` : Prisma.empty}`
        : Prisma.sql`
            SELECT r.id, COALESCE(r.origin_lat, c.lat) AS lat, COALESCE(r.origin_lng, c.lng) AS lng,
                   (r.origin_lat IS NOT NULL) AS exact, r.origin_city, r.destination_city,
                   r.destination_city_id, r.departure_date AS departure_at,
                   r.seats_needed::int AS seats, NULL::int AS price
            FROM passenger_requests r
            JOIN cities c ON c.id = r.origin_city_id
            JOIN users u ON u.id = r.passenger_id
            WHERE r.status = 'open' AND u.is_blocked = false AND u.deleted_at IS NULL
              AND r.departure_date >= ${from}
              ${to ? Prisma.sql`AND r.departure_date < ${to}` : Prisma.empty}
              ${q.to_id ? Prisma.sql`AND r.destination_city_id = ${q.to_id}` : Prisma.empty}
              ${q.ride ? Prisma.sql`AND r.kind = ${q.ride}` : Prisma.empty}`;

    const rows = await prisma.$queryRaw<Row[]>`
      SELECT * FROM (${base}) p
      WHERE p.lat BETWEEN ${south} AND ${north} AND p.lng BETWEEN ${west} AND ${east}
      ORDER BY p.departure_at
      LIMIT 5000
    `;

    const cell = cellDegrees(q.zoom);
    const groups = new Map<string, Row[]>();
    for (const r of rows) {
      const k = cell === null ? r.id : `${Math.floor(r.lat / cell)}:${Math.floor(r.lng / cell)}`;
      const g = groups.get(k);
      if (g) g.push(r);
      else groups.set(k, [r]);
    }

    const items: MapItem[] = [];
    const clusters: MapCluster[] = [];
    for (const g of groups.values()) {
      if (g.length === 1 && items.length < MAX_ITEMS) {
        const r = g[0]!;
        items.push({
          id: r.id,
          lat: r.lat,
          lng: r.lng,
          exact: r.exact,
          originCity: r.origin_city,
          destinationCity: r.destination_city,
          destinationCityId: r.destination_city_id,
          departureAt: r.departure_at.toISOString(),
          seats: r.seats,
          price: r.price,
        });
      } else {
        clusters.push({
          lat: g.reduce((a, r) => a + r.lat, 0) / g.length,
          lng: g.reduce((a, r) => a + r.lng, 0) / g.length,
          count: g.length,
        });
      }
    }
    return { items, clusters };
  }

  return { listings };
}
