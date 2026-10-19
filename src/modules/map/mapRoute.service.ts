import type { PrismaClient } from '@prisma/client';
import { bishkekDayRange } from '@/lib/dates.js';
import { nearbyPlaceIds } from '@/lib/places.js';
import { toFileUrl } from '@/lib/uploads.js';
import type { MapRouteQueryInput } from '@/modules/cities/cities.schemas.js';

// All active listings of one route in a single call, for the route-first
// «Список | Карта» screen. Same visibility as GET /trips and
// GET /passenger-requests (incl. the nearby-settlements fallback).
export interface MapRouteItem {
  id: string;
  kind: 'trip' | 'request';
  // Meeting pin, else the origin settlement; false = settlement fallback.
  lat: number;
  lng: number;
  exact: boolean;
  departureAt: string;
  // Trips: free seats (requests: null). Requests: passengers (trips: null).
  seatsFree: number | null;
  passengers: number | null;
  // Price per seat; requests have none.
  price: number | null;
  origin: PlaceName;
  destination: PlaceName;
  // Driver (trips) or passenger (requests).
  user: { id: string; name: string; avatarUrl: string | null; rating: number | null; ratingCount: number };
}

interface PlaceName {
  id: number;
  nameRu: string;
  nameKg: string;
}

export const MAP_ROUTE_CAP = 500;
const RATING_VISIBLE_AFTER = 3;

const placeName = { select: { id: true, nameRu: true, nameKg: true, lat: true, lng: true } } as const;
const userSelect = {
  select: { id: true, name: true, avatarUrl: true, rating: true, ratingCount: true },
} as const;

export function createMapRouteService(prisma: PrismaClient) {
  function departureRange(date: string | undefined): { gte: Date; lt?: Date } {
    const now = new Date();
    if (!date) return { gte: now };
    const { start, end } = bishkekDayRange(new Date(date));
    return { gte: start > now ? start : now, lt: end };
  }

  async function fetchTrips(q: MapRouteQueryInput, fromIds: number[], toIds: number[]) {
    const rows = await prisma.trip.findMany({
      where: {
        status: 'active',
        seatsAvailable: { gte: 1 },
        departureAt: departureRange(q.date),
        driver: { isBlocked: false, deletedAt: null },
        ...(q.ride ? { kind: q.ride } : {}),
        AND: [
          {
            OR: [
              { originCityId: { in: fromIds } },
              { stops: { some: { kind: 'pickup', cityId: { in: fromIds } } } },
            ],
          },
          {
            OR: [
              { destinationCityId: { in: toIds } },
              { stops: { some: { kind: 'dropoff', cityId: { in: toIds } } } },
            ],
          },
        ],
      },
      orderBy: [{ departureAt: 'asc' }, { id: 'asc' }],
      take: MAP_ROUTE_CAP + 1,
      select: {
        id: true,
        originLat: true,
        originLng: true,
        departureAt: true,
        seatsAvailable: true,
        pricePerSeat: true,
        origin: placeName,
        destination: placeName,
        driver: userSelect,
      },
    });
    return rows.map((r) => ({
      id: r.id,
      kind: 'trip' as const,
      pinLat: r.originLat,
      pinLng: r.originLng,
      departureAt: r.departureAt,
      seatsFree: r.seatsAvailable,
      passengers: null,
      price: r.pricePerSeat,
      origin: r.origin,
      destination: r.destination,
      user: r.driver,
    }));
  }

  async function fetchRequests(q: MapRouteQueryInput, fromIds: number[], toIds: number[]) {
    const rows = await prisma.passengerRequest.findMany({
      where: {
        status: 'open',
        departureDate: departureRange(q.date),
        passenger: { isBlocked: false, deletedAt: null },
        originCityId: { in: fromIds },
        destinationCityId: { in: toIds },
        ...(q.ride ? { kind: q.ride } : {}),
      },
      orderBy: [{ departureDate: 'asc' }, { id: 'asc' }],
      take: MAP_ROUTE_CAP + 1,
      select: {
        id: true,
        originLat: true,
        originLng: true,
        departureDate: true,
        seatsNeeded: true,
        origin: placeName,
        destination: placeName,
        passenger: userSelect,
      },
    });
    return rows.map((r) => ({
      id: r.id,
      kind: 'request' as const,
      pinLat: r.originLat,
      pinLng: r.originLng,
      departureAt: r.departureDate,
      seatsFree: null,
      passengers: r.seatsNeeded,
      price: null,
      origin: r.origin,
      destination: r.destination,
      user: r.passenger,
    }));
  }

  type Row =
    | Awaited<ReturnType<typeof fetchTrips>>[number]
    | Awaited<ReturnType<typeof fetchRequests>>[number];

  function toItem(r: Row, fallback: { lat: number; lng: number } | null): MapRouteItem | null {
    const exact = r.pinLat !== null && r.pinLng !== null;
    const point = exact
      ? { lat: r.pinLat!, lng: r.pinLng! }
      : r.origin.lat !== null && r.origin.lng !== null
        ? { lat: r.origin.lat, lng: r.origin.lng }
        : fallback;
    if (!point) return null;
    return {
      id: r.id,
      kind: r.kind,
      lat: point.lat,
      lng: point.lng,
      exact,
      departureAt: r.departureAt.toISOString(),
      seatsFree: r.seatsFree,
      passengers: r.passengers,
      price: r.price,
      origin: { id: r.origin.id, nameRu: r.origin.nameRu, nameKg: r.origin.nameKg },
      destination: { id: r.destination.id, nameRu: r.destination.nameRu, nameKg: r.destination.nameKg },
      user: {
        id: r.user.id,
        name: r.user.name,
        avatarUrl: toFileUrl(r.user.avatarUrl),
        rating: r.user.ratingCount >= RATING_VISIBLE_AFTER ? Number(r.user.rating) : null,
        ratingCount: r.user.ratingCount,
      },
    };
  }

  async function route(q: MapRouteQueryInput): Promise<{
    kind: 'trips' | 'requests';
    items: MapRouteItem[];
    truncated: boolean;
    nearby: boolean;
  }> {
    const load = (fromIds: number[], toIds: number[]): Promise<Row[]> =>
      q.kind === 'trips' ? fetchTrips(q, fromIds, toIds) : fetchRequests(q, fromIds, toIds);

    let nearby = false;
    let rows = await load([q.from_id], [q.to_id]);
    // Nothing on the exact places → widen once, like the list endpoints.
    if (rows.length === 0) {
      const [fromIds, toIds] = await Promise.all([
        nearbyPlaceIds(prisma, q.from_id),
        nearbyPlaceIds(prisma, q.to_id),
      ]);
      if (fromIds.length > 1 || toIds.length > 1) {
        nearby = true;
        rows = await load(fromIds, toIds);
      }
    }

    const truncated = rows.length > MAP_ROUTE_CAP;
    rows = rows.slice(0, MAP_ROUTE_CAP);
    // A settlement without coordinates (rare) → pin at the searched origin.
    const needsFallback = rows.some((r) => r.pinLat === null && r.origin.lat === null);
    const from = needsFallback
      ? await prisma.city.findUnique({ where: { id: q.from_id }, select: { lat: true, lng: true } })
      : null;
    const fallback =
      from && from.lat !== null && from.lng !== null ? { lat: from.lat, lng: from.lng } : null;
    const items = rows
      .map((r) => toItem(r, fallback))
      .filter((i): i is MapRouteItem => i !== null);
    return { kind: q.kind, items, truncated, nearby };
  }

  return { route };
}
