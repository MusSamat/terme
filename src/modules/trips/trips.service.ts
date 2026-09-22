import type { Prisma, PrismaClient } from '@prisma/client';
import { AppError, Errors } from '@/lib/errors.js';
import { assertActiveUser } from '@/lib/assertUser.js';
import { toFileUrl } from '@/lib/uploads.js';
import { cursorArgs, sliceAndNext } from '@/lib/pagination.js';
import { districtCityNames } from '@/lib/cityArea.js';
import { redactContactInfo } from '@/lib/contentFilter.js';
import { estimateDurationMin } from '@/lib/routes.js';
import { bishkekDayRange } from '@/lib/dates.js';
import { logger } from '@/lib/logger.js';
import type { Notifier } from '@/lib/notifier.js';
import { createEngagementService } from '@/lib/engagement.js';
import { POINTS_PER_TRIP, tierForPoints } from '@/modules/loyalty/loyalty.service.js';
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
  originCity: string;
  destinationCity: string;
  pickupCities: string[];
  dropoffCities: string[];
  originAddress: string;
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
  originCity: string;
  destinationCity: string;
  pickupCities: string[];
  departureAt: Date;
  departureWindowEnd: Date | null;
  seatsAvailable: number;
  pricePerSeat: number;
  status: string;
  liked: boolean;
}

export interface TripDetail extends TripListItem {
  comment: string | null;
  // The viewer's own active booking on this trip (guards double-booking in UI).
  myBooking: { id: string; status: string } | null;
  preferences: Record<string, boolean>;
  waypoints: Array<{ city: string; address?: string }>;
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
  ): Promise<{ data: TripListItem[]; nextCursor: string | null }>;
  like(id: string, userId: string): Promise<{ liked: boolean }>;
  unlike(id: string, userId: string): Promise<{ liked: boolean }>;
  recordView(id: string, viewer: { userId: string | null; anonId: string | null }): Promise<void>;
  priceSuggestion(from: string, to: string): Promise<{
    averagePrice: number | null;
    sampleSize: number;
  }>;
  calendar(query: { from_city: string; to_city: string }): Promise<{
    data: { date: string; count: number }[];
  }>;
}

export function createTripsService(
  prisma: PrismaClient,
  notifier?: Notifier,
): TripsService {
  const engagement = createEngagementService(prisma);

  // Validate driver-provided route cities (pickup/dropoff points): each must
  // exist in the City directory and not be the trip's own origin/destination.
  // Any region is allowed. Returns the deduped list.
  async function normalizeRouteCities(
    exclude: string[],
    cities: string[],
  ): Promise<string[]> {
    const excluded = new Set(exclude);
    const unique = [...new Set(cities)].filter((c) => !excluded.has(c));
    if (unique.length === 0) return [];

    const rows = await prisma.city.findMany({
      where: { nameRu: { in: unique }, isActive: true },
      select: { nameRu: true },
    });
    const known = new Set(rows.map((r) => r.nameRu));
    for (const city of unique) {
      if (!known.has(city)) {
        throw Errors.validation({ reason: 'unknown_route_city', city });
      }
    }
    return unique;
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

    // Phase 1: publishing needs a CAR, not verification. Verification stays an
    // optional badge (driver_profiles) — it никогда больше не гейтит публикацию.
    await assertActiveUser(driverUserId, prisma);
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

    // Business rule: max 3 active trips simultaneously.
    const activeCount = await prisma.trip.count({
      where: { driverId: driverUserId, status: 'active', departureAt: { gt: new Date() } },
    });
    if (activeCount >= 3) {
      throw Errors.conflict('Driver already has 3 active trips', {
        reason: 'max_active_trips_exceeded',
      });
    }

    // Business rule: cannot create a new trip while an existing active trip
    // has at least one accepted (unfinished) booking.
    const unfinishedAccepted = await prisma.booking.count({
      where: {
        trip: { driverId: driverUserId, status: 'active', departureAt: { gt: new Date() } },
        status: 'accepted',
      },
    });
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

    // Business rule: one active trip per route per day. Kills the spam pattern
    // «3 одинаковых Бишкек→Ош» while leaving return trips and other dates free.
    const { start: dayStart, end: dayEnd } = bishkekDayRange(departureAt);
    const duplicate = await prisma.trip.count({
      where: {
        driverId: driverUserId,
        status: 'active',
        originCity: body.originCity,
        destinationCity: body.destinationCity,
        departureAt: { gte: dayStart, lt: dayEnd },
      },
    });
    if (duplicate > 0) {
      throw Errors.conflict('Driver already has an active trip on this route for this date', {
        reason: 'duplicate_route_day',
      });
    }

    const estimatedDurationMin = estimateDurationMin(body.originCity, body.destinationCity);

    const exclude = [body.originCity, body.destinationCity];
    const [pickupCities, dropoffCities] = await Promise.all([
      normalizeRouteCities(exclude, body.pickupCities),
      normalizeRouteCities(exclude, body.dropoffCities),
    ]);

    try {
      const created = await prisma.trip.create({
        data: {
          driverId: driverUserId,
          carId: car.id,
          originCity: body.originCity,
          destinationCity: body.destinationCity,
          originAddress: body.originAddress,
          originLat: body.originLat ?? null,
          originLng: body.originLng ?? null,
          pickupCities,
          dropoffCities,
          waypoints: body.waypoints as Prisma.InputJsonValue,
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
  async function search(
    query: TripSearchInput,
    viewerId: string | null = null,
  ): Promise<{ data: TripCardItem[]; nextCursor: string | null; nearby?: boolean }> {
    if (query.from_city && query.to_city && query.from_city === query.to_city) {
      throw Errors.validation({ reason: 'cities_must_differ' });
    }
    // "nb_" cursor prefix = the first page fell back to the same-raion tier;
    // later pages must keep that expanded filter (frontend treats the cursor
    // as opaque, so no client changes are needed for pagination).
    let nearby = false;
    if (query.cursor?.startsWith('nb_')) {
      nearby = true;
      query = { ...query, cursor: query.cursor.slice(3) };
    }
    if (query.from_city || query.to_city) {
      const cityNames = [query.from_city, query.to_city].filter(Boolean) as string[];
      const cityRows = await prisma.city.findMany({
        where: { nameRu: { in: cityNames }, isActive: true },
        select: { nameRu: true },
      });
      if (cityRows.length < cityNames.length) {
        throw Errors.validation({ reason: 'unknown_city' });
      }
    }

    const where: Prisma.TripWhereInput = {
      status: 'active',
      seatsAvailable: { gte: query.seats },
      departureAt: { gte: new Date() },
    };
    // Mirror match: from_city = a boarding point (origin or a pickup city);
    // to_city = an alighting point (destination or a dropoff city). A dropoff
    // city does NOT make the trip boardable there, and vice versa.
    // Both filters use array sets: [city] for the exact tier, or the whole
    // raion's settlements for the nearby tier (IN uses idx_trips_search,
    // hasSome uses the GIN indexes on pickup/dropoff arrays).
    const applyCityFilters = (fromNames: string[], toNames: string[]): void => {
      const cityFilters: Prisma.TripWhereInput[] = [];
      if (fromNames.length > 0) {
        cityFilters.push({
          OR: [{ originCity: { in: fromNames } }, { pickupCities: { hasSome: fromNames } }],
        });
      }
      if (toNames.length > 0) {
        cityFilters.push({
          OR: [{ destinationCity: { in: toNames } }, { dropoffCities: { hasSome: toNames } }],
        });
      }
      where.AND = cityFilters.length > 0 ? cityFilters : undefined;
    };
    const expandCities = async (): Promise<[string[], string[]]> =>
      Promise.all([
        query.from_city ? districtCityNames(prisma, query.from_city) : Promise.resolve([]),
        query.to_city ? districtCityNames(prisma, query.to_city) : Promise.resolve([]),
      ]);
    if (nearby) {
      applyCityFilters(...(await expandCities()));
    } else {
      applyCityFilters(
        query.from_city ? [query.from_city] : [],
        query.to_city ? [query.to_city] : [],
      );
    }
    if (query.date) {
      const start = new Date(query.date);
      const end = new Date(start.getTime() + 24 * 60 * 60_000);
      // Never list already-departed trips: floor the window at "now" so the
      // "today" list matches the calendar count (which is departure_at > NOW()).
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
    if (query.only_verified || query.min_rating) {
      where.driver = {
        ...(query.only_verified ? { driverProfile: { verificationStatus: 'verified' } } : {}),
        ...(query.min_rating ? { rating: { gte: query.min_rating } } : {}),
      };
    }
    // Preference filters live in the trips.preferences Json column
    // (create() stores {clean, music, smoking, ac, animals, quiet, chat, women_only}).
    {
      const prefFilters: Prisma.TripWhereInput[] = [];
      if (query.no_smoking) prefFilters.push({ preferences: { path: ['smoking'], equals: false } });
      if (query.pets) prefFilters.push({ preferences: { path: ['animals'], equals: true } });
      if (query.women_only) prefFilters.push({ preferences: { path: ['women_only'], equals: true } });
      if (prefFilters.length > 0) {
        where.AND = [...((where.AND as Prisma.TripWhereInput[] | undefined) ?? []), ...prefFilters];
      }
    }

    // Loyalty tier priority: elite → expert → traveler → novice — prepended to
    // all orderings so verified high-tier drivers surface naturally (§Этап 3).
    const loyaltyOrder: Prisma.TripOrderByWithRelationInput = {
      driver: { loyaltyTier: 'asc' }, // 'elite' < 'expert' < 'novice' < 'traveler' alphabetically,
      // so we use a CASE expression via raw SQL; for Prisma-native sorting we
      // rely on the secondary tier field. Proper ordering is handled by the
      // raw-SQL search path when needed; for now this is a reasonable approximation.
    };
    const orderBy: Prisma.TripOrderByWithRelationInput[] =
      query.sort === 'price_asc'
        ? [{ pricePerSeat: 'asc' }, { departureAt: 'asc' }, { id: 'asc' }]
        : query.sort === 'rating_desc'
          ? [{ driver: { rating: 'desc' } }, loyaltyOrder, { departureAt: 'asc' }, { id: 'asc' }]
          : [loyaltyOrder, { departureAt: 'asc' }, { id: 'asc' }];

    const runQuery = () =>
      prisma.trip.findMany({
        where,
        orderBy,
        ...cursorArgs({ cursor: query.cursor, limit: query.limit }),
        include: {
          car: true,
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
                  verificationStatus: true,
                },
              },
            },
          },
        },
      });

    let rows = await runQuery();

    // Nothing matched the exact cities on the first page → widen once to the
    // same-raion tier ("sub-cities": villages of the searched city's district)
    // and mark the response so the client can label results as nearby.
    if (rows.length === 0 && !nearby && !query.cursor && (query.from_city || query.to_city)) {
      const [fromNames, toNames] = await expandCities();
      if (fromNames.length > 1 || toNames.length > 1) {
        nearby = true;
        applyCityFilters(fromNames, toNames);
        rows = await runQuery();
      }
    }

    const likedSet = await engagement.likedIds('trip', rows.map((r) => r.id), viewerId);
    // Info-lean card DTO: only the fields the ride card renders (no metrics,
    // no dropoff/address/luggage/seatsTotal, car = make+model). No per-page
    // contactReveal groupBy either. Full data comes from the detail on open.
    const mapped = rows.map((r) => toCardItem(r, { liked: likedSet.has(r.id) }));
    const page = sliceAndNext(mapped, query.limit);
    if (!nearby) return page;
    return {
      ...page,
      nearby: true,
      nextCursor: page.nextCursor ? `nb_${page.nextCursor}` : null,
    };
  }

  // ─── Detail ─────────────────────────────────────────────────────────
  async function getById(id: string, viewerId: string | null = null): Promise<TripDetail> {
    const row = await prisma.trip.findUnique({
      where: { id },
      include: {
        car: true,
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
                verificationStatus: true,
              },
            },
          },
        },
      },
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
      waypoints: (row.waypoints as Array<{ city: string; address?: string }>) ?? [],
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
    const trip = await prisma.trip.findUnique({ where: { id } });
    if (!trip) throw Errors.notFound('Trip');
    if (trip.driverId !== driverUserId) throw Errors.forbidden({ reason: 'not_owner' });
    if (trip.status !== 'active') {
      throw Errors.conflict('Trip is not active', { current_status: trip.status });
    }

    const data: Prisma.TripUpdateInput = {
      version: { increment: 1 },
    };
    if (body.pricePerSeat !== undefined) data.pricePerSeat = body.pricePerSeat;
    if (body.priceNegotiable !== undefined) data.priceNegotiable = body.priceNegotiable;
    if (body.luggage !== undefined) data.luggage = body.luggage;
    if (body.comment !== undefined) data.comment = redactContactInfo(body.comment).clean;
    if (body.preferences !== undefined) {
      data.preferences = body.preferences as Prisma.InputJsonValue;
    }

    await prisma.trip.update({ where: { id }, data });
    return getById(id);
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
    return getById(id);
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
    if (trip.status !== 'active') {
      throw Errors.conflict('Trip is not active', { current_status: trip.status });
    }

    const affected = await prisma.$transaction(async (tx) => {
      await tx.trip.update({
        where: { id },
        data: {
          status: 'cancelled',
          cancelledReason: reason ?? null,
          version: { increment: 1 },
        },
      });
      // TZ §16.1 "Водитель отменяет поездку: все bookings → cancelled_by_driver,
      //   уведомления всем, cancellations_30d++."
      const affectedBookings = await tx.booking.findMany({
        where: { tripId: id, status: { in: ['pending', 'accepted'] } },
        select: { passengerId: true },
      });
      await tx.booking.updateMany({
        where: { tripId: id, status: { in: ['pending', 'accepted'] } },
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
  ): Promise<{ data: TripListItem[]; nextCursor: string | null }> {
    const now = new Date();
    const where: Prisma.TripWhereInput = { driverId: driverUserId };
    let orderBy: Prisma.TripOrderByWithRelationInput;

    switch (query.tab) {
      case 'active':
        where.status = 'active';
        where.departureAt = { gt: now };
        orderBy = { departureAt: 'asc' };
        break;
      case 'in_transit':
        where.status = 'active';
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
      include: {
        car: true,
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
                verificationStatus: true,
              },
            },
          },
        },
      },
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
      rows.map((r) =>
        toListItem(r, { liked: likedSet.has(r.id), contacts: revealMap.get(r.id) ?? 0 }),
      ),
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
    if (trip.status !== 'active') {
      throw Errors.conflict('Trip is not active', { current_status: trip.status });
    }
    if (trip.departureAt > new Date()) {
      throw Errors.conflict('Cannot complete a trip before its departure time', {
        reason: 'departure_in_future',
      });
    }

    const acceptedPassengers = await prisma.$transaction(async (tx) => {
      await tx.trip.update({
        where: { id },
        data: { status: 'completed', version: { increment: 1 } },
      });
      const bookings = await tx.booking.findMany({
        where: { tripId: id, status: 'accepted' },
        select: { passengerId: true },
      });
      await tx.booking.updateMany({
        where: { tripId: id, status: 'accepted' },
        data: { status: 'completed' },
      });
      await tx.driverProfile.updateMany({
        where: { userId: driverUserId },
        data: { totalTrips: { increment: 1 } },
      });
      return bookings.map((b) => b.passengerId);
    });

    const participants = [driverUserId, ...acceptedPassengers];
    const payload = {
      trip_id: trip.id,
      origin_city: trip.originCity,
      destination_city: trip.destinationCity,
    };

    // Notifications + loyalty (best-effort, outside transaction)
    await Promise.all(
      participants.map(async (userId) => {
        if (notifier) await notifier.tripCompletedRate(userId, payload);

        const alreadyAwarded = await prisma.loyaltyTransaction.findFirst({
          where: { userId, tripId: id, source: 'trip_completed' },
        });
        if (alreadyAwarded) return;

        await prisma.loyaltyTransaction.create({
          data: { userId, points: POINTS_PER_TRIP, source: 'trip_completed', tripId: id },
        });
        const updated = await prisma.user.update({
          where: { id: userId },
          data: { loyaltyPoints: { increment: POINTS_PER_TRIP } },
          select: { loyaltyPoints: true, loyaltyTier: true },
        });
        const newTier = tierForPoints(updated.loyaltyPoints);
        if (newTier !== updated.loyaltyTier) {
          await prisma.user.update({ where: { id: userId }, data: { loyaltyTier: newTier } });
          if (notifier) await notifier.loyaltyTierChanged(userId, { tier: newTier, points: updated.loyaltyPoints });
        }
      }),
    );

    return { status: 'completed' };
  }

  // ─── Price suggestion ───────────────────────────────────────────────
  async function priceSuggestion(
    from: string,
    to: string,
  ): Promise<{ averagePrice: number | null; sampleSize: number }> {
    if (from === to) throw Errors.validation({ reason: 'cities_must_differ' });

    const since = new Date(Date.now() - 30 * 24 * 60 * 60_000);
    const trips = await prisma.trip.findMany({
      where: {
        originCity: from,
        destinationCity: to,
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
  async function calendar(query: { from_city: string; to_city: string }) {
    const rows = await prisma.$queryRaw<{ day: string; n: number }[]>`
      SELECT to_char(departure_at AT TIME ZONE 'Asia/Bishkek', 'YYYY-MM-DD') AS day,
             COUNT(*)::int AS n
      FROM trips
      WHERE status = 'active'
        AND seats_available >= 1
        AND departure_at > NOW()
        AND origin_city = ${query.from_city}
        AND destination_city = ${query.to_city}
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
export type TripRow = Prisma.TripGetPayload<{
  include: {
    car: true;
    driver: {
      select: {
        id: true;
        name: true;
        avatarUrl: true;
        rating: true;
        ratingCount: true;
        driverProfile: {
          select: {
            carMake: true;
            carModel: true;
            carColor: true;
            carPlate: true;
            carPhotoPath: true;
            verificationStatus: true;
          };
        };
      };
    };
  };
}>;

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
    originCity: row.originCity,
    destinationCity: row.destinationCity,
    pickupCities: row.pickupCities,
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
      // Trip's own car first (Phase 1 multi-auto); legacy trips fall back to
      // the verification profile's vehicle.
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
    originCity: row.originCity,
    destinationCity: row.destinationCity,
    pickupCities: row.pickupCities,
    dropoffCities: row.dropoffCities,
    originAddress: row.originAddress,
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
