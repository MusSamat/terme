import type { Prisma, PrismaClient } from '@prisma/client';
import { AppError, Errors } from '@/lib/errors.js';
import { assertActiveUser } from '@/lib/assertUser.js';
import { toFileUrl } from '@/lib/uploads.js';
import { cursorArgs, sliceAndNext } from '@/lib/pagination.js';
import {
  haversineKm,
  loadPlaces,
  nearbyPlaceIds,
  nearestAreaId,
  placeSelect,
  resolvePlaceByName,
  toPlaceRef,
  type PlaceRef,
  type PlaceRow,
} from '@/lib/places.js';
import { redactContactInfo } from '@/lib/contentFilter.js';
import { estimateDurationMin } from '@/lib/routes.js';
import { bishkekDayRange } from '@/lib/dates.js';
import { logger } from '@/lib/logger.js';
import type { Notifier } from '@/lib/notifier.js';
import { createEngagementService } from '@/lib/engagement.js';
import { POINTS_PER_TRIP, awardTripCompletion } from '@/modules/loyalty/loyalty.service.js';
import type {
  MyTripsInput,
  TripCreateInput,
  TripPatchInput,
  TripSearchInput,
} from './trips.schemas.js';

// ─── Business-rule constants from TZ §10.1 ────────────────────────────
const HORIZON_MAX_DAYS = 60;
const HORIZON_MIN_MINUTES = 30;
const RATING_VISIBLE_AFTER = 3;
// A meeting-point pin must lie within this distance of its settlement.
const POINT_MAX_KM = 30;
// sort=nearest ranks at most this many matching trips by distance.
const NEAREST_POOL = 200;
// Simultaneous future trips per driver: intercity rides vs airport transfers
// (transfers are short and run several times a day).
const MAX_ACTIVE = { intercity: 3, airport: 10 } as const;
type TripKind = keyof typeof MAX_ACTIVE;

export interface MeetingPointDto {
  lat: number;
  lng: number;
  address: string | null;
  // Жилмассив / микрорайон of the pin in Бишкек / Ош («Асанбай»).
  area: { nameRu: string; nameKg: string } | null;
}

// ─── Public shapes ────────────────────────────────────────────────────
export interface TripListItem {
  id: string;
  driverId: string;
  driver: {
    id: string;
    name: string;
    avatarUrl: string | null;
    rating: number | null;
    ratingCount: number;
    verified: boolean;
    car: { make: string; model: string; color: string; plate: string; photoUrl: string | null } | null;
  };
  kind: 'intercity' | 'airport';
  originCityId: number;
  destinationCityId: number;
  originCity: string;
  destinationCity: string;
  origin: PlaceRef;
  destination: PlaceRef;
  // Exact boarding / drop-off spot (map pin); null → the settlement itself.
  originPoint: MeetingPointDto | null;
  destinationPoint: MeetingPointDto | null;
  // Boarding point: the pin, else the origin settlement (null only when the
  // settlement has no coordinates).
  lat: number | null;
  lng: number | null;
  pickupCities: string[];
  dropoffCities: string[];
  stops: Array<{ kind: 'pickup' | 'dropoff'; place: PlaceRef }>;
  departureAt: Date;
  departureWindowEnd: Date | null;
  departureFlexible: boolean;
  estimatedDurationMin: number;
  seatsTotal: number;
  seatsAvailable: number;
  pricePerSeat: number;
  priceNegotiable: boolean;
  luggage: string;
  status: string;
  createdAt: Date;
  // Engagement: like state for the viewer. Early stage: metrics are PUBLIC
  // (views / likes / phone requests) — lively counters sell the marketplace.
  liked: boolean;
  metrics: { views: number; likes: number; contacts: number };
}

// Search/browse card — a deliberate subset of TripListItem carrying only what
// the ride card renders. The detail (getById) still returns the full
// TripListItem/TripDetail, fetched on open. Keep this in sync with the web
// TripCard component and the TripCardItem OpenAPI schema.
export interface TripCardItem {
  id: string;
  driverId: string;
  driver: {
    id: string;
    name: string;
    avatarUrl: string | null;
    rating: number | null;
    ratingCount: number;
    verified: boolean;
    car: { make: string; model: string } | null;
  };
  kind: 'intercity' | 'airport';
  originCityId: number;
  destinationCityId: number;
  originCity: string;
  destinationCity: string;
  origin: PlaceRef;
  destination: PlaceRef;
  originPoint: MeetingPointDto | null;
  // Boarding point: the pin, else the origin settlement.
  lat: number | null;
  lng: number | null;
  pickupCities: string[];
  departureAt: Date;
  departureWindowEnd: Date | null;
  seatsAvailable: number;
  pricePerSeat: number;
  status: string;
  liked: boolean;
  // Only with sort=nearest: km from the viewer to the boarding point.
  distanceKm?: number;
}

// Owner list (GET /trips/my): + the driver's own comment.
export interface MyTripItem extends TripListItem {
  comment: string | null;
}

export interface TripDetail extends TripListItem {
  comment: string | null;
  // The viewer's own active booking on this trip (guards double-booking in UI).
  myBooking: { id: string; status: string } | null;
  preferences: Record<string, boolean>;
  recentRatings: Array<{
    id: string;
    score: number;
    tags: string[];
    comment: string | null;
    createdAt: Date;
    raterName: string;
  }>;
}

// ─── Service interface ────────────────────────────────────────────────
export interface TripsService {
  create(
    driverUserId: string,
    body: TripCreateInput,
    idempotencyKey: string,
  ): Promise<{ trip: TripDetail; reused: boolean }>;
  search(
    query: TripSearchInput,
    viewerId?: string | null,
  ): Promise<{ data: TripCardItem[]; nextCursor: string | null; nearby?: boolean }>;
  getById(id: string, viewerId?: string | null): Promise<TripDetail>;
  patch(id: string, driverUserId: string, patch: TripPatchInput): Promise<TripDetail>;
  adjustSeats(id: string, driverUserId: string, delta: 1 | -1): Promise<TripDetail>;
  cancel(id: string, driverUserId: string, reason?: string): Promise<{ status: 'cancelled' }>;
  complete(id: string, driverUserId: string): Promise<{ status: 'completed' }>;
  myTrips(
    driverUserId: string,
    query: MyTripsInput,
  ): Promise<{ data: MyTripItem[]; nextCursor: string | null }>;
  like(id: string, userId: string): Promise<{ liked: boolean }>;
  unlike(id: string, userId: string): Promise<{ liked: boolean }>;
  recordView(id: string, viewer: { userId: string | null; anonId: string | null }): Promise<void>;
  priceSuggestion(fromId: number, toId: number): Promise<{
    averagePrice: number | null;
    sampleSize: number;
  }>;
  calendar(query: { from_id: number; to_id: number }): Promise<{
    data: { date: string; count: number }[];
  }>;
}

export function createTripsService(
  prisma: PrismaClient,
  notifier?: Notifier,
): TripsService {
  const engagement = createEngagementService(prisma);

  // A pin must sit near its settlement: catches swapped / stale coordinates.
  function assertPointNear(
    point: { lat: number; lng: number } | undefined | null,
    place: PlaceRow,
    field: string,
  ): void {
    if (!point || place.lat === null || place.lng === null) return;
    if (haversineKm(point, { lat: place.lat, lng: place.lng }) > POINT_MAX_KM) {
      throw Errors.validation({ reason: 'point_far_from_city', field, max_km: POINT_MAX_KM });
    }
  }

  // ─── Create ─────────────────────────────────────────────────────────
  async function create(
    driverUserId: string,
    body: TripCreateInput,
    idempotencyKey: string,
  ): Promise<{ trip: TripDetail; reused: boolean }> {
    // Idempotency-Key semantics (TZ §19.1): replay returns the original result.
    const existing = await prisma.trip.findUnique({ where: { idempotencyKey } });
    if (existing) {
      if (existing.driverId !== driverUserId) {
        throw Errors.conflict('Idempotency-Key belongs to another user', {
          reason: 'idempotency_key_mismatch',
        });
      }
      return { trip: await getById(existing.id), reused: true };
    }

    try {
      return await createFresh(driverUserId, body, idempotencyKey);
    } catch (err) {
      // A concurrent request with the same Idempotency-Key passed the lookup
      // above and committed first; ours then trips a business check
      // (duplicate_route_day, max_active…) or a unique violation. Replay the
      // winner instead of surfacing that error.
      const winner = await prisma.trip.findUnique({ where: { idempotencyKey } });
      if (winner?.driverId === driverUserId) {
        return { trip: await getById(winner.id, driverUserId), reused: true };
      }
      throw err;
    }
  }

  async function createFresh(
    driverUserId: string,
    body: TripCreateInput,
    idempotencyKey: string,
  ): Promise<{ trip: TripDetail; reused: boolean }> {
    // Phase 1: publishing needs a CAR, not verification. Verification stays an
    // optional badge (driver_profiles) — it никогда больше не гейтит публикацию.
    await assertActiveUser(driverUserId, prisma);
    // Suspended drivers (rating < 3.0 auto-suspend, set elsewhere) cannot publish.
    const profile = await prisma.driverProfile.findUnique({
      where: { userId: driverUserId },
      select: { verificationStatus: true },
    });
    if (profile?.verificationStatus === 'suspended') {
      throw Errors.conflict('Driver is suspended and cannot publish trips', {
        reason: 'driver_suspended',
      });
    }
    const car = body.carId
      ? await prisma.car.findFirst({
          where: { id: body.carId, userId: driverUserId, deletedAt: null },
        })
      : await prisma.car.findFirst({
          where: { userId: driverUserId, deletedAt: null },
          orderBy: { createdAt: 'desc' },
        });
    if (!car) {
      throw Errors.conflict('Add a car before publishing', { reason: 'no_car' });
    }
    if (body.seatsTotal > car.seatsCount) {
      throw Errors.validation({
        reason: 'seats_exceed_vehicle',
        requested: body.seatsTotal,
        vehicle: car.seatsCount,
      });
    }

    // Stops are deduped and never repeat the trip's own endpoints.
    const endpoints = new Set([body.originCityId, body.destinationCityId]);
    const pickupIds = [...new Set(body.pickupCityIds)].filter((id) => !endpoints.has(id));
    const dropoffIds = [...new Set(body.dropoffCityIds)].filter((id) => !endpoints.has(id));
    const places = await loadPlaces(prisma, [
      body.originCityId,
      body.destinationCityId,
      ...pickupIds,
      ...dropoffIds,
    ]);
    const origin = places.get(body.originCityId)!;
    const destination = places.get(body.destinationCityId)!;
    assertPointNear(body.originPoint, origin, 'originPoint');
    assertPointNear(body.destinationPoint, destination, 'destinationPoint');
    const estimatedDurationMin = estimateDurationMin(origin, destination);
    const kind: TripKind =
      origin.type === 'airport' || destination.type === 'airport' ? 'airport' : 'intercity';

    // Business rule: a capped number of simultaneous future trips per kind.
    const activeCount = await prisma.trip.count({
      where: { driverId: driverUserId, status: 'active', kind, departureAt: { gt: new Date() } },
    });
    if (activeCount >= MAX_ACTIVE[kind]) {
      throw Errors.conflict(`Driver already has ${MAX_ACTIVE[kind]} active trips`, {
        reason: 'max_active_trips_exceeded',
        limit: MAX_ACTIVE[kind],
      });
    }

    // Business rule (intercity): no new trip while an active one has an accepted,
    // unfinished booking. Airport transfers are back-to-back by nature.
    const unfinishedAccepted =
      kind === 'intercity'
        ? await prisma.booking.count({
            where: {
              trip: {
                driverId: driverUserId,
                status: 'active',
                kind: 'intercity',
                departureAt: { gt: new Date() },
              },
              status: 'accepted',
            },
          })
        : 0;
    if (unfinishedAccepted > 0) {
      throw Errors.conflict('Driver has an unfinished accepted booking on an active trip', {
        reason: 'unfinished_accepted_booking',
      });
    }

    const departureAt = new Date(body.departureAt);
    const now = Date.now();
    const deltaMs = departureAt.getTime() - now;
    if (deltaMs < HORIZON_MIN_MINUTES * 60_000) {
      throw Errors.validation({
        reason: 'departure_too_soon',
        minutes_required: HORIZON_MIN_MINUTES,
      });
    }
    if (deltaMs > HORIZON_MAX_DAYS * 24 * 60 * 60_000) {
      throw Errors.validation({ reason: 'departure_too_far', max_days: HORIZON_MAX_DAYS });
    }

    // Business rule (intercity): one active trip per route per day. Kills the
    // spam pattern «3 одинаковых Бишкек→Ош»; airport transfers are exempt.
    const { start: dayStart, end: dayEnd } = bishkekDayRange(departureAt);
    const duplicate = kind === 'airport' ? 0 : await prisma.trip.count({
      where: {
        driverId: driverUserId,
        status: 'active',
        originCityId: body.originCityId,
        destinationCityId: body.destinationCityId,
        departureAt: { gte: dayStart, lt: dayEnd },
      },
    });
    if (duplicate > 0) {
      throw Errors.conflict('Driver already has an active trip on this route for this date', {
        reason: 'duplicate_route_day',
      });
    }


    try {
      const created = await prisma.trip.create({
        data: {
          driverId: driverUserId,
          carId: car.id,
          kind,
          originCityId: origin.id,
          destinationCityId: destination.id,
          originCity: origin.nameRu,
          destinationCity: destination.nameRu,
          ...pointColumns('origin', body.originPoint, await nearestAreaId(prisma, origin.id, body.originPoint)),
          ...pointColumns(
            'destination',
            body.destinationPoint,
            await nearestAreaId(prisma, destination.id, body.destinationPoint),
          ),
          stops: {
            create: [
              ...pickupIds.map((cityId, i) => ({ cityId, kind: 'pickup', position: i + 1 })),
              ...dropoffIds.map((cityId, i) => ({ cityId, kind: 'dropoff', position: i + 1 })),
            ],
          },
          departureAt,
          departureWindowEnd: body.departureWindowEnd ? new Date(body.departureWindowEnd) : null,
          departureFlexible: body.departureFlexible,
          estimatedDurationMin,
          seatsTotal: body.seatsTotal,
          seatsAvailable: body.seatsTotal,
          pricePerSeat: body.pricePerSeat,
          priceNegotiable: body.priceNegotiable,
          luggage: body.luggage,
          preferences: body.preferences as Prisma.InputJsonValue,
          comment: redactContactInfo(body.comment).clean,
          status: 'active',
          idempotencyKey,
        },
      });
      return { trip: await getById(created.id, driverUserId), reused: false };
    } catch (err) {
      throw mapPrismaError(err);
    }
  }

  // ─── Search ─────────────────────────────────────────────────────────
  // Index-backed Postgres search (idx_trips_active_search / _destination,
  // trip_stops_city_id_kind_idx): at this data size it answers in a few ms
  // with no separate search cluster to keep in sync.
  async function search(
    query: TripSearchInput,
    viewerId: string | null = null,
  ): Promise<{ data: TripCardItem[]; nextCursor: string | null; nearby?: boolean }> {
    const [fromId, toId] = await Promise.all([
      resolveFilterPlace(query.from_id, query.from_city),
      resolveFilterPlace(query.to_id, query.to_city),
    ]);
    if (fromId !== null && fromId === toId) {
      throw Errors.validation({ reason: 'cities_must_differ' });
    }
    // Offset cursors belong to sort=nearest, id cursors to every other sort.
    if (query.cursor && query.cursor.startsWith('o_') !== (query.sort === 'nearest')) {
      throw Errors.validation({ reason: 'cursor_sort_mismatch' });
    }
    // "nb_" cursor prefix = the first page fell back to the nearby (radius)
    // tier; later pages keep that expanded filter (the cursor is opaque).
    let nearby = false;
    if (query.cursor?.startsWith('nb_')) {
      nearby = true;
      query = { ...query, cursor: query.cursor.slice(3) };
    }

    const where: Prisma.TripWhereInput = {
      status: 'active',
      seatsAvailable: { gte: query.seats },
      departureAt: { gte: new Date() },
      // Blocked or soft-deleted drivers' trips must never surface in search.
      driver: { isBlocked: false, deletedAt: null },
    };
    // Preference filters live in trips.preferences (TripPreferences keys). Kept
    // apart so widening the city tier never drops them (women_only is safety).
    const prefFilters: Prisma.TripWhereInput[] = [];
    if (query.no_smoking) prefFilters.push({ preferences: { path: ['smoking'], equals: false } });
    if (query.pets) prefFilters.push({ preferences: { path: ['animals'], equals: true } });
    if (query.women_only) prefFilters.push({ preferences: { path: ['women_only'], equals: true } });

    // Mirror match: "from" = a boarding point (origin or a pickup stop), "to" =
    // an alighting point (destination or a dropoff stop).
    const applyCityFilters = (fromIds: number[], toIds: number[]): void => {
      const cityFilters: Prisma.TripWhereInput[] = [];
      if (fromIds.length > 0) {
        cityFilters.push({
          OR: [
            { originCityId: { in: fromIds } },
            { stops: { some: { kind: 'pickup', cityId: { in: fromIds } } } },
          ],
        });
      }
      if (toIds.length > 0) {
        cityFilters.push({
          OR: [
            { destinationCityId: { in: toIds } },
            { stops: { some: { kind: 'dropoff', cityId: { in: toIds } } } },
          ],
        });
      }
      const and = [...prefFilters, ...cityFilters];
      where.AND = and.length > 0 ? and : undefined;
    };
    const expandPlaces = async (): Promise<[number[], number[]]> =>
      Promise.all([
        fromId !== null ? nearbyPlaceIds(prisma, fromId) : Promise.resolve([]),
        toId !== null ? nearbyPlaceIds(prisma, toId) : Promise.resolve([]),
      ]);
    if (nearby) {
      applyCityFilters(...(await expandPlaces()));
    } else {
      applyCityFilters(fromId !== null ? [fromId] : [], toId !== null ? [toId] : []);
    }
    if (query.date) {
      // Asia/Bishkek calendar day (same helper as the calendar endpoint),
      // floored at "now" so already-departed trips never list.
      const { start, end } = bishkekDayRange(new Date(query.date));
      const now = new Date();
      where.departureAt = { gte: start > now ? start : now, lt: end };
    }
    if (query.min_price !== undefined) {
      where.pricePerSeat = { gte: query.min_price };
    }
    if (query.max_price !== undefined) {
      where.pricePerSeat = {
        ...(where.pricePerSeat as object | undefined),
        lte: query.max_price,
      };
    }
    if (query.luggage) where.luggage = query.luggage;
    if (query.kind) where.kind = query.kind;
    if (query.only_verified || query.min_rating) {
      // Merge onto the base driver guard (isBlocked/deletedAt) — never replace it.
      where.driver = {
        ...(where.driver as Prisma.UserWhereInput),
        ...(query.only_verified ? { driverProfile: { verificationStatus: 'verified' } } : {}),
        ...(query.min_rating ? { rating: { gte: query.min_rating } } : {}),
      };
    }

    const likedFor = async (rows: TripRow[]) =>
      engagement.likedIds('trip', rows.map((r) => r.id), viewerId);

    // sort=nearest: rank a bounded pool by distance from the viewer to the
    // boarding point (exact pin, else the settlement); offset cursor "o_<n>".
    if (query.sort === 'nearest') {
      if (query.near_lat === undefined || query.near_lng === undefined) {
        throw Errors.validation({ reason: 'near_point_required' });
      }
      const me = { lat: query.near_lat, lng: query.near_lng };
      const pool = await prisma.trip.findMany({
        where,
        orderBy: [{ departureAt: 'asc' }, { id: 'asc' }],
        take: NEAREST_POOL,
        include: tripInclude,
      });
      const ranked = pool
        .map((r) => ({ r, km: distanceKm(me, boardingPoint(r)) }))
        .sort((a, b) => a.km - b.km);
      const offset = query.cursor?.startsWith('o_') ? Number(query.cursor.slice(2)) : 0;
      const slice = ranked.slice(offset, offset + query.limit);
      const liked = await likedFor(slice.map((x) => x.r));
      return {
        data: slice.map((x) => ({
          ...toCardItem(x.r, { liked: liked.has(x.r.id) }),
          distanceKm: Math.round(x.km * 10) / 10,
        })),
        nextCursor: offset + query.limit < ranked.length ? `o_${offset + query.limit}` : null,
      };
    }

    // NB: loyalty tier is deliberately NOT a sort key (its text values don't
    // sort by rank); driver rating is the quality signal.
    const orderBy: Prisma.TripOrderByWithRelationInput[] =
      query.sort === 'price_asc'
        ? [{ pricePerSeat: 'asc' }, { departureAt: 'asc' }, { id: 'asc' }]
        : query.sort === 'rating_desc'
          ? [{ driver: { rating: 'desc' } }, { departureAt: 'asc' }, { id: 'asc' }]
          : [{ departureAt: 'asc' }, { id: 'asc' }];

    const runQuery = () =>
      prisma.trip.findMany({
        where,
        orderBy,
        ...cursorArgs({ cursor: query.cursor, limit: query.limit }),
        include: tripInclude,
      });

    let rows = await runQuery();

    // Nothing matched the exact places on the first page → widen once to the
    // settlements within NEARBY_RADIUS_KM and mark the response as nearby.
    if (rows.length === 0 && !nearby && !query.cursor && (fromId !== null || toId !== null)) {
      const [fromIds, toIds] = await expandPlaces();
      if (fromIds.length > 1 || toIds.length > 1) {
        nearby = true;
        applyCityFilters(fromIds, toIds);
        rows = await runQuery();
      }
    }

    const likedSet = await likedFor(rows);
    const mapped = rows.map((r) => toCardItem(r, { liked: likedSet.has(r.id) }));
    const page = sliceAndNext(mapped, query.limit);
    if (!nearby) return page;
    return {
      ...page,
      nearby: true,
      nextCursor: page.nextCursor ? `nb_${page.nextCursor}` : null,
    };
  }

  async function resolveFilterPlace(
    id: number | undefined,
    name: string | undefined,
  ): Promise<number | null> {
    if (id !== undefined) return id;
    if (!name) return null;
    const resolved = await resolvePlaceByName(prisma, name);
    if (resolved === null) throw Errors.validation({ reason: 'unknown_city', city: name });
    return resolved;
  }

  // ─── Detail ─────────────────────────────────────────────────────────
  async function getById(id: string, viewerId: string | null = null): Promise<TripDetail> {
    const row = await prisma.trip.findUnique({
      where: { id },
      include: tripInclude,
    });
    if (!row) throw Errors.notFound('Trip');

    const [recentRatings, liked, myBookingRow] = await Promise.all([
      prisma.rating.findMany({
        where: { rateeId: row.driverId },
        orderBy: { createdAt: 'desc' },
        take: 5,
        include: { rater: { select: { name: true, deletedAt: true } } },
      }),
      engagement.isLiked('trip', id, viewerId),
      viewerId
        ? prisma.booking.findFirst({
            where: { tripId: id, passengerId: viewerId, status: { in: ['pending', 'viewed', 'accepted'] } },
            select: { id: true, status: true },
          })
        : Promise.resolve(null),
    ]);

    // Views are counted via an explicit client POST /trips/:id/view, not here —
    // so SSR / crawlers / prefetch don't inflate the count.

    return {
      ...toListItem(row, {
        liked,
        contacts: await prisma.contactReveal.count({
          where: { contextType: 'trip', contextId: row.id },
        }),
      }),
      comment: row.comment,
      myBooking: myBookingRow,
      preferences: (row.preferences ?? {}) as Record<string, boolean>,
      recentRatings: recentRatings.map((r) => ({
        id: r.id,
        score: r.score,
        tags: r.tags,
        comment: r.comment,
        createdAt: r.createdAt,
        raterName: r.rater.deletedAt ? 'Удалённый пользователь' : r.rater.name,
      })),
    };
  }

  // ─── Patch ──────────────────────────────────────────────────────────
  async function patch(
    id: string,
    driverUserId: string,
    body: TripPatchInput,
  ): Promise<TripDetail> {
    const trip = await prisma.trip.findUnique({
      where: { id },
      include: {
        origin: { select: placeSelect },
        destination: { select: placeSelect },
      },
    });
    if (!trip) throw Errors.notFound('Trip');
    if (trip.driverId !== driverUserId) throw Errors.forbidden({ reason: 'not_owner' });
    if (trip.status !== 'active') {
      throw Errors.conflict('Trip is not active', { current_status: trip.status });
    }

    const data: Prisma.TripUpdateInput = {
      version: { increment: 1 },
    };
    if (body.pricePerSeat !== undefined && body.pricePerSeat !== trip.pricePerSeat) {
      // The passenger agreed to a price at booking time (bookings snapshot it
      // separately), so the driver can't change it out from under an accepted
      // booking. Other fields (comment/luggage/prefs) stay editable.
      const acceptedCount = await prisma.booking.count({
        where: { tripId: id, status: 'accepted' },
      });
      if (acceptedCount > 0) {
        throw Errors.conflict('Cannot change price after a booking has been accepted', {
          reason: 'price_locked_by_booking',
        });
      }
      data.pricePerSeat = body.pricePerSeat;
    }
    if (body.priceNegotiable !== undefined) data.priceNegotiable = body.priceNegotiable;
    if (body.luggage !== undefined) data.luggage = body.luggage;
    if (body.comment !== undefined) data.comment = redactContactInfo(body.comment).clean;
    if (body.preferences !== undefined) {
      // Merge: a patch carrying one toggle must not wipe the search flags.
      data.preferences = {
        ...((trip.preferences ?? {}) as Record<string, boolean>),
        ...body.preferences,
      } as Prisma.InputJsonValue;
    }
    if (body.originPoint !== undefined) {
      assertPointNear(body.originPoint, trip.origin, 'originPoint');
      Object.assign(
        data,
        pointColumns('origin', body.originPoint, await nearestAreaId(prisma, trip.originCityId, body.originPoint)),
      );
    }
    if (body.destinationPoint !== undefined) {
      assertPointNear(body.destinationPoint, trip.destination, 'destinationPoint');
      Object.assign(
        data,
        pointColumns(
          'destination',
          body.destinationPoint,
          await nearestAreaId(prisma, trip.destinationCityId, body.destinationPoint),
        ),
      );
    }

    await prisma.trip.update({ where: { id }, data });
    return getById(id, driverUserId);
  }

  // ─── Manual seats adjust («занято по телефону» / «освободилось») ─────
  // Invariants: 0 ≤ available + delta ≤ total − accepted-on-platform seats.
  // Seats held by accepted bookings can only be freed by cancelling the
  // booking explicitly (which notifies the passenger) — never by this knob.
  async function adjustSeats(
    id: string,
    driverUserId: string,
    delta: 1 | -1,
  ): Promise<TripDetail> {
    await prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<
        Array<{ driver_id: string; status: string; seats_total: number; seats_available: number }>
      >`
        SELECT driver_id, status, seats_total, seats_available
        FROM trips WHERE id = ${id}::uuid FOR UPDATE
      `;
      const trip = locked[0];
      if (!trip) throw Errors.notFound('Trip');
      if (trip.driver_id !== driverUserId) throw Errors.forbidden({ reason: 'not_owner' });
      if (trip.status !== 'active') {
        throw Errors.conflict('Trip is not active', { current_status: trip.status });
      }

      const accepted = await tx.$queryRaw<Array<{ n: number }>>`
        SELECT COALESCE(SUM(seats_count), 0)::int AS n
        FROM bookings WHERE trip_id = ${id}::uuid AND status = 'accepted'
      `;
      const acceptedSeats = accepted[0]?.n ?? 0;
      const next = trip.seats_available + delta;
      const max = trip.seats_total - acceptedSeats;
      if (next < 0 || next > max) {
        throw Errors.conflict('Seats out of range', {
          reason: 'seats_out_of_range',
          seats_available: trip.seats_available,
          max_available: max,
        });
      }

      await tx.trip.update({
        where: { id },
        data: { seatsAvailable: next, version: { increment: 1 } },
      });
    });
    return getById(id, driverUserId);
  }

  // ─── Cancel ─────────────────────────────────────────────────────────
  async function cancel(
    id: string,
    driverUserId: string,
    reason?: string,
  ): Promise<{ status: 'cancelled' }> {
    const trip = await prisma.trip.findUnique({ where: { id } });
    if (!trip) throw Errors.notFound('Trip');
    if (trip.driverId !== driverUserId) throw Errors.forbidden({ reason: 'not_owner' });
    // 'direct' trips share the active lifecycle and are cancellable too.
    if (trip.status !== 'active' && trip.status !== 'direct') {
      throw Errors.conflict('Trip is not active', { current_status: trip.status });
    }

    const affected = await prisma.$transaction(async (tx) => {
      // Conditional flip: a concurrent complete()/auto_complete cron or a second
      // cancel may have closed the trip since the read above — never overwrite
      // a completed trip or double-count the cancellation.
      const { count } = await tx.trip.updateMany({
        where: { id, status: { in: ['active', 'direct'] } },
        data: {
          status: 'cancelled',
          cancelledReason: reason ?? null,
          version: { increment: 1 },
        },
      });
      if (count !== 1) throw Errors.conflict('Trip is not active', { reason: 'trip_state_changed' });
      // TZ §16.1 "Водитель отменяет поездку: все bookings → cancelled_by_driver,
      //   уведомления всем, cancellations_30d++."
      // Every live booking — 'viewed' is still a live request.
      const live = { tripId: id, status: { in: ['pending', 'viewed', 'accepted'] } };
      const affectedBookings = await tx.booking.findMany({
        where: live,
        select: { passengerId: true },
      });
      await tx.booking.updateMany({
        where: live,
        data: {
          status: 'cancelled_by_driver',
          cancelledBy: 'driver',
          cancelledAt: new Date(),
        },
      });
      // updateMany (not update): the driver may not have a driverProfile row
      // yet (seeded/test trips, driver who never verified). update() would throw
      // P2025 and 500 the whole cancel — updateMany is a no-op on 0 rows.
      await tx.driverProfile.updateMany({
        where: { userId: driverUserId },
        data: { cancellations30d: { increment: 1 } },
      });
      return affectedBookings.map((b) => b.passengerId);
    });

    // Notify each impacted passenger outside the transaction. Best-effort: the
    // trip is already cancelled in the DB, so a notifier/socket failure must not
    // surface as a 500 for a successful cancel.
    if (notifier) {
      try {
        const freshTrip = await prisma.trip.findUniqueOrThrow({ where: { id } });
        const publicTrip = {
          id: freshTrip.id,
          driverId: freshTrip.driverId,
          originCity: freshTrip.originCity,
          destinationCity: freshTrip.destinationCity,
          departureAt: freshTrip.departureAt,
        };
        await Promise.all(
          affected.map((passengerId) => notifier.tripCancelled(passengerId, { trip: publicTrip })),
        );
      } catch (err) {
        logger.error({ err, tripId: id }, 'trip cancel: passenger notify failed');
      }
    }

    return { status: 'cancelled' };
  }

  // ─── My trips (driver tabs) ─────────────────────────────────────────
  async function myTrips(
    driverUserId: string,
    query: MyTripsInput,
  ): Promise<{ data: MyTripItem[]; nextCursor: string | null }> {
    const now = new Date();
    const where: Prisma.TripWhereInput = { driverId: driverUserId };
    let orderBy: Prisma.TripOrderByWithRelationInput;

    switch (query.tab) {
      case 'active':
        // 'direct' trips (created from an accepted passenger-request response)
        // share the active lifecycle — they must be visible/completable here.
        where.status = { in: ['active', 'direct'] };
        where.departureAt = { gt: now };
        orderBy = { departureAt: 'asc' };
        break;
      case 'in_transit':
        where.status = { in: ['active', 'direct'] };
        where.departureAt = { lte: now };
        orderBy = { departureAt: 'asc' };
        break;
      case 'past':
        where.status = 'completed';
        orderBy = { departureAt: 'desc' };
        break;
      case 'cancelled':
        where.status = 'cancelled';
        orderBy = { updatedAt: 'desc' };
        break;
    }

    const rows = await prisma.trip.findMany({
      where,
      orderBy: [orderBy, { id: 'asc' }],
      ...cursorArgs({ cursor: query.cursor, limit: query.limit }),
      include: tripInclude,
    });

    const likedSet = await engagement.likedIds('trip', rows.map((r) => r.id), driverUserId);
    // «Сколько раз спросили номер» — owner-only counter from the reveal audit.
    const reveals = await prisma.contactReveal.groupBy({
      by: ['contextId'],
      where: { contextType: 'trip', contextId: { in: rows.map((r) => r.id) } },
      _count: { _all: true },
    });
    const revealMap = new Map(reveals.map((c) => [c.contextId, c._count._all]));
    return sliceAndNext(
      rows.map((r) => ({
        ...toListItem(r, { liked: likedSet.has(r.id), contacts: revealMap.get(r.id) ?? 0 }),
        comment: r.comment,
      })),
      query.limit,
    );
  }

  // ─── Like / unlike ──────────────────────────────────────────────────
  async function like(id: string, userId: string): Promise<{ liked: boolean }> {
    const trip = await prisma.trip.findUnique({ where: { id }, select: { id: true } });
    if (!trip) throw Errors.notFound('Trip');
    await engagement.like('trip', id, userId);
    return { liked: true };
  }

  async function unlike(id: string, userId: string): Promise<{ liked: boolean }> {
    await engagement.unlike('trip', id, userId);
    return { liked: false };
  }

  // Record a unique view (deduped; owner self-views ignored). Fire-and-forget.
  async function recordView(
    id: string,
    viewer: { userId: string | null; anonId: string | null },
  ): Promise<void> {
    await engagement.recordView('trip', id, viewer);
  }

  // ─── Manual complete ────────────────────────────────────────────────
  async function complete(
    id: string,
    driverUserId: string,
  ): Promise<{ status: 'completed' }> {
    const trip = await prisma.trip.findUnique({ where: { id } });
    if (!trip) throw Errors.notFound('Trip');
    if (trip.driverId !== driverUserId) throw Errors.forbidden({ reason: 'not_owner' });
    // 'direct' trips share the active lifecycle and are completable too.
    if (trip.status !== 'active' && trip.status !== 'direct') {
      throw Errors.conflict('Trip is not active', { current_status: trip.status });
    }
    if (trip.departureAt > new Date()) {
      throw Errors.conflict('Cannot complete a trip before its departure time', {
        reason: 'departure_in_future',
      });
    }

    // Re-check status INSIDE the transaction: a concurrent auto_complete cron run
    // may have already closed this trip. updateMany is a conditional CAS — if it
    // flips 0 rows, someone else won the race and we must not double-award.
    const result = await prisma.$transaction(async (tx) => {
      const { count } = await tx.trip.updateMany({
        where: { id, status: { in: ['active', 'direct'] } },
        data: { status: 'completed', completedAt: new Date(), version: { increment: 1 } },
      });
      if (count !== 1) return null; // lost the race — cron already completed it

      const bookings = await tx.booking.findMany({
        where: { tripId: id, status: 'accepted' },
        select: { passengerId: true },
      });
      await tx.booking.updateMany({
        where: { tripId: id, status: 'accepted' },
        data: { status: 'completed' },
      });

      const passengers = bookings.map((b) => b.passengerId);
      // Loyalty awards inside the same tx — idempotent via the (user,trip,source)
      // UNIQUE, and atomic with the completion so a crash can't half-apply.
      // M8: an empty trip earns nothing — no points / totalTrips farming by
      // publishing and completing trips nobody rode.
      if (passengers.length > 0) {
        for (const userId of [driverUserId, ...passengers]) {
          await awardTripCompletion(tx, userId, id, POINTS_PER_TRIP);
        }
      }
      return passengers;
    });

    // Someone else completed it first — treat as a no-op success (idempotent).
    if (result === null) return { status: 'completed' };

    const participants = [driverUserId, ...result];
    const payload = {
      trip_id: trip.id,
      origin_city: trip.originCity,
      destination_city: trip.destinationCity,
    };

    // Rating-request notifications (best-effort, outside the transaction).
    if (notifier) {
      await Promise.all(
        participants.map((userId) => notifier.tripCompletedRate(userId, payload)),
      );
    }

    return { status: 'completed' };
  }

  // ─── Price suggestion ───────────────────────────────────────────────
  async function priceSuggestion(
    fromId: number,
    toId: number,
  ): Promise<{ averagePrice: number | null; sampleSize: number }> {
    if (fromId === toId) throw Errors.validation({ reason: 'cities_must_differ' });

    const since = new Date(Date.now() - 30 * 24 * 60 * 60_000);
    const trips = await prisma.trip.findMany({
      where: {
        originCityId: fromId,
        destinationCityId: toId,
        status: { in: ['active', 'completed'] },
        createdAt: { gte: since },
      },
      select: { pricePerSeat: true },
      take: 200,
    });

    if (trips.length < 3) {
      return { averagePrice: null, sampleSize: trips.length };
    }
    const sum = trips.reduce((acc, t) => acc + t.pricePerSeat, 0);
    return {
      averagePrice: Math.round(sum / trips.length),
      sampleSize: trips.length,
    };
  }

  // Per-day active-trip counts for a route — powers the calendar availability
  // hints in the date picker. Days are Kyrgyzstan-local (fixed UTC+6).
  async function calendar(query: { from_id: number; to_id: number }) {
    const rows = await prisma.$queryRaw<{ day: string; n: number }[]>`
      SELECT to_char(departure_at AT TIME ZONE 'Asia/Bishkek', 'YYYY-MM-DD') AS day,
             COUNT(*)::int AS n
      FROM trips
      WHERE status = 'active'
        AND seats_available >= 1
        AND departure_at > NOW()
        AND origin_city_id = ${query.from_id}
        AND destination_city_id = ${query.to_id}
      GROUP BY 1
      ORDER BY 1
    `;
    return { data: rows.map((r) => ({ date: r.day, count: r.n })) };
  }

  return {
    create,
    search,
    getById,
    patch,
    adjustSeats,
    cancel,
    complete,
    myTrips,
    like,
    unlike,
    recordView,
    priceSuggestion,
    calendar,
  };
}

// ─── Internal helpers ─────────────────────────────────────────────────
export const tripInclude = {
  car: true,
  origin: { select: placeSelect },
  destination: { select: placeSelect },
  originArea: { select: { nameRu: true, nameKg: true } },
  destinationArea: { select: { nameRu: true, nameKg: true } },
  stops: { orderBy: { position: 'asc' }, include: { city: { select: placeSelect } } },
  driver: {
    select: {
      id: true,
      name: true,
      avatarUrl: true,
      rating: true,
      ratingCount: true,
      driverProfile: {
        select: {
          carMake: true,
          carModel: true,
          carColor: true,
          carPlate: true,
          carPhotoPath: true,
          verificationStatus: true,
        },
      },
    },
  },
} satisfies Prisma.TripInclude;

export type TripRow = Prisma.TripGetPayload<{ include: typeof tripInclude }>;

// Column values for an optional meeting point (null clears it).
function pointColumns(
  side: 'origin' | 'destination',
  p: { lat: number; lng: number; address?: string } | null | undefined,
  areaId: number | null = null,
): Record<string, number | string | null> {
  return {
    [`${side}Lat`]: p?.lat ?? null,
    [`${side}Lng`]: p?.lng ?? null,
    [`${side}Address`]: p?.address ?? null,
    [`${side}AreaId`]: areaId,
  };
}

function toPoint(
  lat: number | null,
  lng: number | null,
  address: string | null,
  area: { nameRu: string; nameKg: string } | null,
): MeetingPointDto | null {
  return lat !== null && lng !== null ? { lat, lng, address, area } : null;
}

// Where a passenger boards: the pin when set, else the settlement.
function boardingPoint(row: TripRow): { lat: number; lng: number } | null {
  if (row.originLat !== null && row.originLng !== null) {
    return { lat: row.originLat, lng: row.originLng };
  }
  return row.origin.lat !== null && row.origin.lng !== null
    ? { lat: row.origin.lat, lng: row.origin.lng }
    : null;
}

function boardingLatLng(row: TripRow): { lat: number | null; lng: number | null } {
  const p = boardingPoint(row);
  return { lat: p?.lat ?? null, lng: p?.lng ?? null };
}

function distanceKm(me: { lat: number; lng: number }, p: { lat: number; lng: number } | null): number {
  return p ? haversineKm(me, p) : Number.POSITIVE_INFINITY;
}

const stopNames = (row: TripRow, kind: 'pickup' | 'dropoff'): string[] =>
  row.stops.filter((s) => s.kind === kind).map((s) => s.city.nameRu);

// Lean projection for search/browse cards — a strict subset of toListItem.
export function toCardItem(row: TripRow, opts: { liked: boolean }): TripCardItem {
  const dp = row.driver.driverProfile;
  const car = row.car
    ? { make: row.car.make, model: row.car.model }
    : dp
      ? { make: dp.carMake, model: dp.carModel }
      : null;
  return {
    id: row.id,
    driverId: row.driverId,
    driver: {
      id: row.driver.id,
      name: row.driver.name,
      avatarUrl: toFileUrl(row.driver.avatarUrl),
      rating:
        row.driver.ratingCount >= RATING_VISIBLE_AFTER ? Number(row.driver.rating) : null,
      ratingCount: row.driver.ratingCount,
      verified: dp?.verificationStatus === 'verified',
      car,
    },
    kind: row.kind as 'intercity' | 'airport',
    originCityId: row.originCityId,
    destinationCityId: row.destinationCityId,
    originCity: row.originCity,
    destinationCity: row.destinationCity,
    origin: toPlaceRef(row.origin),
    destination: toPlaceRef(row.destination),
    originPoint: toPoint(row.originLat, row.originLng, row.originAddress, row.originArea),
    ...boardingLatLng(row),
    pickupCities: stopNames(row, 'pickup'),
    departureAt: row.departureAt,
    departureWindowEnd: row.departureWindowEnd,
    seatsAvailable: row.seatsAvailable,
    pricePerSeat: row.pricePerSeat,
    status: row.status,
    liked: opts.liked,
  };
}

export function toListItem(
  row: TripRow,
  opts: { liked: boolean; contacts?: number },
): TripListItem {
  const dp = row.driver.driverProfile;
  return {
    id: row.id,
    driverId: row.driverId,
    driver: {
      id: row.driver.id,
      name: row.driver.name,
      avatarUrl: toFileUrl(row.driver.avatarUrl),
      rating:
        row.driver.ratingCount >= RATING_VISIBLE_AFTER ? Number(row.driver.rating) : null,
      ratingCount: row.driver.ratingCount,
      verified: dp?.verificationStatus === 'verified',
      // Trip's own car first (multi-car garage); legacy trips fall back to the
      // verification profile's vehicle.
      car: row.car
        ? {
            make: row.car.make,
            model: row.car.model,
            color: row.car.color ?? '',
            plate: row.car.plate,
            photoUrl: null,
          }
        : dp
          ? {
              make: dp.carMake,
              model: dp.carModel,
              color: dp.carColor,
              plate: dp.carPlate,
              photoUrl: toFileUrl(dp.carPhotoPath),
            }
          : null,
    },
    kind: row.kind as 'intercity' | 'airport',
    originCityId: row.originCityId,
    destinationCityId: row.destinationCityId,
    originCity: row.originCity,
    destinationCity: row.destinationCity,
    origin: toPlaceRef(row.origin),
    destination: toPlaceRef(row.destination),
    originPoint: toPoint(row.originLat, row.originLng, row.originAddress, row.originArea),
    destinationPoint: toPoint(row.destinationLat, row.destinationLng, row.destinationAddress, row.destinationArea),
    ...boardingLatLng(row),
    pickupCities: stopNames(row, 'pickup'),
    dropoffCities: stopNames(row, 'dropoff'),
    stops: row.stops.map((s) => ({
      kind: s.kind as 'pickup' | 'dropoff',
      place: toPlaceRef(s.city),
    })),
    departureAt: row.departureAt,
    departureWindowEnd: row.departureWindowEnd,
    departureFlexible: row.departureFlexible,
    estimatedDurationMin: row.estimatedDurationMin,
    seatsTotal: row.seatsTotal,
    seatsAvailable: row.seatsAvailable,
    pricePerSeat: row.pricePerSeat,
    priceNegotiable: row.priceNegotiable,
    luggage: row.luggage,
    status: row.status,
    createdAt: row.createdAt,
    liked: opts.liked,
    metrics: { views: row.viewsCount, likes: row.likesCount, contacts: opts.contacts ?? 0 },
  };
}

function mapPrismaError(err: unknown): AppError {
  if (err instanceof AppError) return err;
  // P2002 = unique constraint violation. For trip create, the idempotency-key
  // case is already handled via an explicit lookup above, so if we reach here
  // the conflict is `idx_trips_route_day_unique` (the only other unique
  // constraint) — the race-window twin of the explicit duplicate check above.
  if (
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: string }).code === 'P2002'
  ) {
    return Errors.conflict('Driver already has an active trip on this route for this date', {
      reason: 'duplicate_route_day',
    });
  }
  logger.error({ err }, 'unexpected prisma error creating trip');
  return Errors.internal();
}
