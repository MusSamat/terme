import type { Prisma, PrismaClient } from '@prisma/client';
import { Errors } from '@/lib/errors.js';
import { toFileUrl } from '@/lib/uploads.js';
import { createEngagementService } from '@/lib/engagement.js';
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
import { bishkekDayRange } from '@/lib/dates.js';
import { estimateDurationMin } from '@/lib/routes.js';
import type { Notifier } from '@/lib/notifier.js';
import type { CreatePassengerRequestInput, ListRequestsInput, RespondInput, UpdatePassengerRequestInput } from './passenger-requests.schemas.js';

export interface MeetingPointDto {
  lat: number;
  lng: number;
  address: string | null;
  // Жилмассив / микрорайон of the pin in Бишкек / Ош («Асанбай»).
  area: { nameRu: string; nameKg: string } | null;
}

// Browse card DTO — what the request card renders (and the map pin needs).
// The detail (getById) adds comment, metrics and the drop-off point.
export interface PassengerRequestCardItem {
  id: string;
  passengerId: string;
  kind: 'intercity' | 'airport';
  flightNumber: string | null;
  originCityId: number;
  destinationCityId: number;
  originCity: string;
  destinationCity: string;
  origin: PlaceRef;
  destination: PlaceRef;
  // Where the passenger waits (map pin); null → the settlement itself.
  originPoint: MeetingPointDto | null;
  seatsNeeded: number;
  departureDate: string;
  flexible: boolean;
  status: string;
  liked: boolean;
  // The viewing driver's own response to this request (guards double-respond).
  myResponse: { id: string; status: string } | null;
  passenger: {
    id: string;
    name: string;
    avatarUrl: string | null;
    rating: number | null;
    ratingCount: number;
  };
  // Only with sort=nearest: km from the viewer to where the passenger waits.
  distanceKm?: number;
}

export interface PassengerRequestDTO extends PassengerRequestCardItem {
  destinationPoint: MeetingPointDto | null;
  comment: string | null;
  createdAt: string;
  metrics: { views: number; likes: number; contacts: number };
}

// Owner list (GET /passenger-requests/my): + offers still awaiting a decision.
export interface MyPassengerRequestDTO extends PassengerRequestDTO {
  pendingResponsesCount: number;
}

const RATING_VISIBLE_AFTER = 3;
// A meeting-point pin must lie within this distance of its settlement.
const POINT_MAX_KM = 30;
// sort=nearest ranks at most this many matching requests by distance.
const NEAREST_POOL = 200;

export const passengerSelect = {
  id: true,
  name: true,
  avatarUrl: true,
  rating: true,
  ratingCount: true,
} as const;

export const requestInclude = {
  passenger: { select: passengerSelect },
  origin: { select: placeSelect },
  destination: { select: placeSelect },
  originArea: { select: { nameRu: true, nameKg: true } },
  destinationArea: { select: { nameRu: true, nameKg: true } },
} satisfies Prisma.PassengerRequestInclude;

export type RequestRow = Prisma.PassengerRequestGetPayload<{ include: typeof requestInclude }>;

function toPoint(
  lat: number | null,
  lng: number | null,
  address: string | null,
  area: { nameRu: string; nameKg: string } | null,
): MeetingPointDto | null {
  return lat !== null && lng !== null ? { lat, lng, address, area } : null;
}

// Lean projection for browse cards — a strict subset of toDTO.
export function toCardItem(
  row: RequestRow,
  opts: { liked: boolean; myResponse?: { id: string; status: string } | null },
): PassengerRequestCardItem {
  return {
    id: row.id,
    passengerId: row.passengerId,
    kind: row.kind as 'intercity' | 'airport',
    flightNumber: row.flightNumber,
    originCityId: row.originCityId,
    destinationCityId: row.destinationCityId,
    originCity: row.originCity,
    destinationCity: row.destinationCity,
    origin: toPlaceRef(row.origin),
    destination: toPlaceRef(row.destination),
    originPoint: toPoint(row.originLat, row.originLng, row.originAddress, row.originArea),
    seatsNeeded: row.seatsNeeded,
    departureDate: row.departureDate.toISOString(),
    flexible: row.flexible,
    status: row.status,
    liked: opts.liked,
    myResponse: opts.myResponse ?? null,
    passenger: {
      id: row.passenger.id,
      name: row.passenger.name,
      avatarUrl: toFileUrl(row.passenger.avatarUrl),
      rating:
        row.passenger.ratingCount >= RATING_VISIBLE_AFTER ? row.passenger.rating.toNumber() : null,
      ratingCount: row.passenger.ratingCount,
    },
  };
}

export function toDTO(
  row: RequestRow,
  opts: { liked: boolean; contacts?: number; myResponse?: { id: string; status: string } | null },
): PassengerRequestDTO {
  return {
    ...toCardItem(row, opts),
    destinationPoint: toPoint(row.destinationLat, row.destinationLng, row.destinationAddress, row.destinationArea),
    comment: row.comment,
    createdAt: row.createdAt.toISOString(),
    metrics: { views: row.viewsCount, likes: row.likesCount, contacts: opts.contacts ?? 0 },
  };
}

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

function waitingPoint(row: RequestRow): { lat: number; lng: number } | null {
  if (row.originLat !== null && row.originLng !== null) return { lat: row.originLat, lng: row.originLng };
  return row.origin.lat !== null && row.origin.lng !== null
    ? { lat: row.origin.lat, lng: row.origin.lng }
    : null;
}

export function createPassengerRequestsService(prisma: PrismaClient) {
  const engagement = createEngagementService(prisma);

  async function create(
    passengerId: string,
    input: CreatePassengerRequestInput,
  ): Promise<PassengerRequestDTO> {
    const departure = new Date(input.departureDate);
    const now = new Date();

    if (departure <= now) {
      throw Errors.validation({ departureDate: 'must be in the future' });
    }
    const maxAhead = new Date(now.getTime() + 60 * 24 * 60 * 60 * 1000); // 60 days
    if (departure > maxAhead) {
      throw Errors.validation({ departureDate: 'too far ahead (max 60 days)' });
    }

    const places = await loadPlaces(prisma, [input.originCityId, input.destinationCityId]);
    const origin = places.get(input.originCityId)!;
    const dest = places.get(input.destinationCityId)!;
    assertPointNear(input.originPoint, origin, 'originPoint');
    assertPointNear(input.destinationPoint, dest, 'destinationPoint');

    // Business rule: one open request per route per day (mirrors trips —
    // duplicates only clutter the feed).
    const { start: dayStart, end: dayEnd } = bishkekDayRange(departure);
    const duplicate = await prisma.passengerRequest.count({
      where: {
        passengerId,
        status: 'open',
        originCityId: origin.id,
        destinationCityId: dest.id,
        departureDate: { gte: dayStart, lt: dayEnd },
      },
    });
    if (duplicate > 0) {
      throw Errors.conflict('Passenger already has an open request on this route for this date', {
        reason: 'duplicate_route_day',
      });
    }

    const row = await prisma.passengerRequest.create({
      data: {
        passengerId,
        kind: origin.type === 'airport' || dest.type === 'airport' ? 'airport' : 'intercity',
        flightNumber: input.flightNumber ?? null,
        originCityId: origin.id,
        destinationCityId: dest.id,
        originCity: origin.nameRu,
        destinationCity: dest.nameRu,
        ...pointColumns('origin', input.originPoint, await nearestAreaId(prisma, origin.id, input.originPoint)),
        ...pointColumns('destination', input.destinationPoint, await nearestAreaId(prisma, dest.id, input.destinationPoint)),
        seatsNeeded: input.seatsNeeded,
        departureDate: departure,
        flexible: input.flexible ?? false,
        comment: redactContactInfo(input.comment).clean,
        status: 'open',
      },
      include: requestInclude,
    });

    return toDTO(row, { liked: false, myResponse: null });
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

  async function list(
    input: ListRequestsInput,
    viewerId: string | null = null,
  ): Promise<{ data: PassengerRequestCardItem[]; nextCursor: string | null; nearby?: boolean }> {
    const now = new Date();
    const [fromId, toId] = await Promise.all([
      resolveFilterPlace(input.from_id, input.from_city),
      resolveFilterPlace(input.to_id, input.to_city),
    ]);

    // "nb_" cursor prefix = the first page fell back to the nearby (radius)
    // tier (see trips.service.search) — keep the expanded filter on later pages.
    if (input.cursor && input.cursor.startsWith('o_') !== (input.sort === 'nearest')) {
      throw Errors.validation({ reason: 'cursor_sort_mismatch' });
    }
    let nearby = input.cursor?.startsWith('nb_') ?? false;
    const cursor = nearby ? input.cursor!.slice(3) : input.cursor;

    const whereFor = (fromIds: number[] | null, toIds: number[] | null): Prisma.PassengerRequestWhereInput => ({
      status: 'open',
      departureDate: { gte: now },
      // Blocked or soft-deleted passengers' requests never surface (mirrors trips).
      passenger: { isBlocked: false, deletedAt: null },
      ...(fromIds ? { originCityId: { in: fromIds } } : {}),
      ...(toIds ? { destinationCityId: { in: toIds } } : {}),
      // Single Asia/Bishkek day, floored at "now".
      ...(input.date
        ? (() => {
            const { start, end } = bishkekDayRange(new Date(input.date));
            return { departureDate: { gte: start > now ? start : now, lt: end } };
          })()
        : {}),
      ...(input.seats ? { seatsNeeded: { gte: input.seats } } : {}),
      ...(input.kind ? { kind: input.kind } : {}),
    });
    const exact: [number[] | null, number[] | null] = [
      fromId !== null ? [fromId] : null,
      toId !== null ? [toId] : null,
    ];
    const expandPlaces = async (): Promise<[number[] | null, number[] | null]> =>
      Promise.all([
        fromId !== null ? nearbyPlaceIds(prisma, fromId) : Promise.resolve(null),
        toId !== null ? nearbyPlaceIds(prisma, toId) : Promise.resolve(null),
      ]);

    const decorate = async (slice: RequestRow[]) => {
      const [likedSet, myResponses] = await Promise.all([
        engagement.likedIds('passenger_request', slice.map((r) => r.id), viewerId),
        viewerId
          ? prisma.passengerRequestResponse.findMany({
              where: { driverId: viewerId, requestId: { in: slice.map((r) => r.id) } },
              select: { id: true, requestId: true, status: true },
            })
          : Promise.resolve([]),
      ]);
      const respByRequest = new Map(myResponses.map((r) => [r.requestId, { id: r.id, status: r.status }]));
      return (r: RequestRow) =>
        toCardItem(r, { liked: likedSet.has(r.id), myResponse: respByRequest.get(r.id) ?? null });
    };

    // sort=nearest: drivers see who waits closest to them (offset cursor "o_<n>").
    if (input.sort === 'nearest') {
      if (input.near_lat === undefined || input.near_lng === undefined) {
        throw Errors.validation({ reason: 'near_point_required' });
      }
      const me = { lat: input.near_lat, lng: input.near_lng };
      const pool = await prisma.passengerRequest.findMany({
        where: whereFor(...exact),
        orderBy: [{ departureDate: 'asc' }, { id: 'asc' }],
        take: NEAREST_POOL,
        include: requestInclude,
      });
      const ranked = pool
        .map((r) => {
          const p = waitingPoint(r);
          return { r, km: p ? haversineKm(me, p) : Number.POSITIVE_INFINITY };
        })
        .sort((a, b) => a.km - b.km);
      const offset = cursor?.startsWith('o_') ? Number(cursor.slice(2)) : 0;
      const slice = ranked.slice(offset, offset + input.limit);
      const toCard = await decorate(slice.map((x) => x.r));
      return {
        data: slice.map((x) => ({ ...toCard(x.r), distanceKm: Math.round(x.km * 10) / 10 })),
        nextCursor: offset + input.limit < ranked.length ? `o_${offset + input.limit}` : null,
      };
    }

    const runQuery = (fromIds: number[] | null, toIds: number[] | null) =>
      prisma.passengerRequest.findMany({
        where: whereFor(fromIds, toIds),
        orderBy: [{ departureDate: 'asc' }, { createdAt: 'desc' }],
        take: input.limit + 1,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        include: requestInclude,
      });

    let rows;
    if (nearby) {
      rows = await runQuery(...(await expandPlaces()));
    } else {
      rows = await runQuery(...exact);
      // Exact places matched nothing on the first page → widen once to the
      // settlements within the nearby radius and mark the response.
      if (rows.length === 0 && !cursor && (fromId !== null || toId !== null)) {
        const [fromIds, toIds] = await expandPlaces();
        if ((fromIds?.length ?? 0) > 1 || (toIds?.length ?? 0) > 1) {
          nearby = true;
          rows = await runQuery(fromIds, toIds);
        }
      }
    }

    const hasMore = rows.length > input.limit;
    const slice = hasMore ? rows.slice(0, input.limit) : rows;
    const toCard = await decorate(slice);
    return {
      data: slice.map(toCard),
      nextCursor: hasMore ? `${nearby ? 'nb_' : ''}${slice[slice.length - 1]!.id}` : null,
      ...(nearby ? { nearby: true } : {}),
    };
  }

  async function listMy(passengerId: string): Promise<{ data: MyPassengerRequestDTO[]; nextCursor: string | null }> {
    // Bound the query so a heavy user can't pull an unbounded result set. Fetch
    // one extra to detect a further page, then expose a cursor (created-at desc,
    // keyed on id) without changing the response shape.
    const LIMIT = 50;
    const rows = await prisma.passengerRequest.findMany({
      where: { passengerId },
      orderBy: [{ createdAt: 'desc' }],
      take: LIMIT + 1,
      include: requestInclude,
    });
    const hasMore = rows.length > LIMIT;
    const slice = hasMore ? rows.slice(0, LIMIT) : rows;
    const [likedSet, pending] = await Promise.all([
      engagement.likedIds('passenger_request', slice.map((r) => r.id), passengerId),
      prisma.passengerRequestResponse.groupBy({
        by: ['requestId'],
        where: { requestId: { in: slice.map((r) => r.id) }, status: 'pending' },
        _count: { _all: true },
      }),
    ]);
    const pendingBy = new Map(pending.map((c) => [c.requestId, c._count._all]));
    return {
      // Owner list feeds the lean request card too — no metrics rendered, so no
      // contactReveal groupBy. Full detail is fetched on open.
      data: slice.map((r) => ({
        ...toDTO(r, { liked: likedSet.has(r.id), myResponse: null }),
        pendingResponsesCount: pendingBy.get(r.id) ?? 0,
      })),
      nextCursor: hasMore ? slice[slice.length - 1]!.id : null,
    };
  }

  async function cancel(id: string, passengerId: string): Promise<void> {
    const req = await prisma.passengerRequest.findUnique({ where: { id } });
    if (!req) throw Errors.notFound('PassengerRequest');
    if (req.passengerId !== passengerId) throw Errors.forbidden();
    if (req.status !== 'open') throw Errors.conflict('Request is not open');

    // Conditional: a concurrent acceptResponse() may have closed it (trip and
    // booking already created) — don't relabel that as cancelled.
    const { count } = await prisma.passengerRequest.updateMany({
      where: { id, status: 'open' },
      data: { status: 'cancelled' },
    });
    if (count !== 1) throw Errors.conflict('Request is not open');
  }

  async function update(
    id: string,
    passengerId: string,
    input: UpdatePassengerRequestInput,
  ): Promise<PassengerRequestDTO> {
    const req = await prisma.passengerRequest.findUnique({ where: { id }, include: requestInclude });
    if (!req) throw Errors.notFound('PassengerRequest');
    if (req.passengerId !== passengerId) throw Errors.forbidden();
    if (req.status !== 'open') throw Errors.conflict('Request is not open');
    if (input.originPoint) assertPointNear(input.originPoint, req.origin, 'originPoint');
    if (input.destinationPoint) assertPointNear(input.destinationPoint, req.destination, 'destinationPoint');

    if (input.departureDate !== undefined) {
      const departure = new Date(input.departureDate);
      const now = new Date();
      if (departure <= now) throw Errors.validation({ departureDate: 'must be in the future' });
      const maxAhead = new Date(now.getTime() + 60 * 24 * 60 * 60 * 1000); // 60 days
      if (departure > maxAhead) throw Errors.validation({ departureDate: 'too far ahead (max 60 days)' });
    }

    await prisma.passengerRequest.update({
      where: { id },
      data: {
        ...(input.seatsNeeded !== undefined ? { seatsNeeded: input.seatsNeeded } : {}),
        ...(input.departureDate !== undefined ? { departureDate: new Date(input.departureDate) } : {}),
        ...(input.flexible !== undefined ? { flexible: input.flexible } : {}),
        ...(input.flightNumber !== undefined ? { flightNumber: input.flightNumber } : {}),
        ...(input.comment !== undefined
          ? { comment: input.comment === null ? null : redactContactInfo(input.comment).clean }
          : {}),
        ...(input.originPoint !== undefined
          ? pointColumns('origin', input.originPoint, await nearestAreaId(prisma, req.originCityId, input.originPoint))
          : {}),
        ...(input.destinationPoint !== undefined
          ? pointColumns(
              'destination',
              input.destinationPoint,
              await nearestAreaId(prisma, req.destinationCityId, input.destinationPoint),
            )
          : {}),
      },
    });
    return getById(id, passengerId);
  }

  async function getById(id: string, viewerId: string | null = null): Promise<PassengerRequestDTO> {
    const row = await prisma.passengerRequest.findUnique({
      where: { id },
      include: requestInclude,
    });
    if (!row) throw Errors.notFound('PassengerRequest');
    const [liked, myResp] = await Promise.all([
      engagement.isLiked('passenger_request', id, viewerId),
      viewerId
        ? prisma.passengerRequestResponse.findUnique({
            where: { requestId_driverId: { requestId: id, driverId: viewerId } },
            select: { id: true, status: true },
          })
        : Promise.resolve(null),
    ]);
    // Views are counted via an explicit client POST /:id/view, not on read.
    const contacts = await prisma.contactReveal.count({
      where: { contextType: 'passenger_request', contextId: row.id },
    });
    return toDTO(row, { liked, contacts, myResponse: myResp });
  }

  async function like(id: string, userId: string): Promise<{ liked: boolean }> {
    const req = await prisma.passengerRequest.findUnique({ where: { id }, select: { id: true } });
    if (!req) throw Errors.notFound('PassengerRequest');
    await engagement.like('passenger_request', id, userId);
    return { liked: true };
  }

  async function recordView(
    id: string,
    viewer: { userId: string | null; anonId: string | null },
  ): Promise<void> {
    await engagement.recordView('passenger_request', id, viewer);
  }

  async function unlike(id: string, userId: string): Promise<{ liked: boolean }> {
    await engagement.unlike('passenger_request', id, userId);
    return { liked: false };
  }

  // Per-day open-request counts for a route — calendar hints in the date
  // picker. Days are Kyrgyzstan-local (fixed UTC+6).
  async function calendar(query: { from_id: number; to_id: number }) {
    const rows = await prisma.$queryRaw<{ day: string; n: number }[]>`
      SELECT to_char(departure_date AT TIME ZONE 'Asia/Bishkek', 'YYYY-MM-DD') AS day,
             COUNT(*)::int AS n
      FROM passenger_requests
      WHERE status = 'open'
        AND departure_date > NOW()
        AND origin_city_id = ${query.from_id}
        AND destination_city_id = ${query.to_id}
      GROUP BY 1
      ORDER BY 1
    `;
    return { data: rows.map((r) => ({ date: r.day, count: r.n })) };
  }

  return { create, list, listMy, cancel, update, getById, like, unlike, recordView, calendar };
}

// ─── Response DTO ─────────────────────────────────────────────────────
export interface RequestResponseDTO {
  id: string;
  requestId: string;
  driverId: string;
  price: number;
  departureTime: string;
  message: string | null;
  status: string;
  bookingId: string | null;
  expiresAt: string;
  createdAt: string;
  driver: {
    id: string;
    name: string;
    avatarUrl: string | null;
    rating: number | null;
    ratingCount: number;
    verified: boolean;
  };
}

const RESPONSE_TTL_HOURS = 48;

function toResponseDTO(row: {
  id: string;
  requestId: string;
  driverId: string;
  price: number;
  departureTime: Date;
  message: string | null;
  status: string;
  bookingId: string | null;
  expiresAt: Date;
  createdAt: Date;
  driver: {
    id: string;
    name: string;
    avatarUrl: string | null;
    rating: { toNumber: () => number } | number;
    ratingCount: number;
    driverProfile: { verificationStatus: string } | null;
  };
}): RequestResponseDTO {
  return {
    id: row.id,
    requestId: row.requestId,
    driverId: row.driverId,
    price: row.price,
    departureTime: row.departureTime.toISOString(),
    message: row.message,
    status: row.status,
    bookingId: row.bookingId,
    expiresAt: row.expiresAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    driver: {
      id: row.driver.id,
      name: row.driver.name,
      avatarUrl: toFileUrl(row.driver.avatarUrl),
      rating:
        row.driver.ratingCount >= RATING_VISIBLE_AFTER
          ? typeof row.driver.rating === 'number'
            ? row.driver.rating
            : row.driver.rating.toNumber()
          : null,
      ratingCount: row.driver.ratingCount,
      verified: row.driver.driverProfile?.verificationStatus === 'verified',
    },
  };
}

const driverResponseSelect = {
  id: true,
  name: true,
  avatarUrl: true,
  rating: true,
  ratingCount: true,
  driverProfile: { select: { verificationStatus: true } },
} as const;

export function createPassengerRequestResponsesService(prisma: PrismaClient, notifier: Notifier) {
  async function respond(driverId: string, requestId: string, input: RespondInput): Promise<RequestResponseDTO> {
    const request = await prisma.passengerRequest.findUnique({ where: { id: requestId } });
    if (!request) throw Errors.notFound('PassengerRequest');
    if (request.status !== 'open') throw Errors.conflict('Request is not open');
    if (request.passengerId === driverId) throw Errors.validation({ reason: 'cannot_respond_to_own_request' });
    // A suspended driver may not respond to requests.
    const driverProfile = await prisma.driverProfile.findUnique({
      where: { userId: driverId },
      select: { verificationStatus: true },
    });
    if (driverProfile?.verificationStatus === 'suspended') {
      throw Errors.forbidden({ reason: 'driver_suspended' });
    }
    // Phase 1: responding as a driver requires a car (not verification).
    const hasCar = await prisma.car.count({ where: { userId: driverId, deletedAt: null } });
    if (hasCar === 0) throw Errors.conflict('Add a car before responding', { reason: 'no_car' });

    const departureTime = new Date(input.departureTime);
    if (departureTime <= new Date()) throw Errors.validation({ departureTime: 'must be in the future' });

    const expiresAt = new Date(Date.now() + RESPONSE_TTL_HOURS * 60 * 60_000);

    const existing = await prisma.passengerRequestResponse.findUnique({
      where: { requestId_driverId: { requestId, driverId } },
    });
    if (existing && existing.status === 'pending') {
      throw Errors.conflict('Already responded to this request');
    }

    let row;
    if (existing) {
      row = await prisma.passengerRequestResponse.update({
        where: { id: existing.id },
        data: { price: input.price, departureTime, message: input.message ?? null, status: 'pending', expiresAt },
        include: { driver: { select: driverResponseSelect } },
      });
    } else {
      try {
        row = await prisma.passengerRequestResponse.create({
          data: { requestId, driverId, price: input.price, departureTime, message: input.message ?? null, expiresAt },
          include: { driver: { select: driverResponseSelect } },
        });
      } catch (err) {
        // Concurrent insert raced past the dup-check above and hit the
        // (request_id, driver_id) unique index — surface a clean 409.
        if (typeof err === 'object' && err !== null && (err as { code?: string }).code === 'P2002') {
          throw Errors.conflict('Already responded to this request');
        }
        throw err;
      }
    }

    const driver = await prisma.user.findUnique({ where: { id: driverId }, select: { name: true } });

    await notifier.requestResponseReceived(request.passengerId, {
      responseId: row.id,
      requestId,
      driverName: driver?.name ?? 'Водитель',
      price: input.price,
      departureTime,
    });

    return toResponseDTO(row);
  }

  async function listResponses(requestId: string, passengerId: string): Promise<RequestResponseDTO[]> {
    const request = await prisma.passengerRequest.findUnique({ where: { id: requestId } });
    if (!request) throw Errors.notFound('PassengerRequest');
    if (request.passengerId !== passengerId) throw Errors.forbidden();

    const rows = await prisma.passengerRequestResponse.findMany({
      where: { requestId, status: { in: ['pending', 'accepted', 'declined'] } },
      orderBy: [{ createdAt: 'asc' }],
      include: { driver: { select: driverResponseSelect } },
    });

    return rows.map(toResponseDTO);
  }

  async function acceptResponse(passengerId: string, requestId: string, responseId: string): Promise<{ bookingId: string }> {
    const result = await prisma.$transaction(async (tx) => {
      // Lock the passenger_request row FOR UPDATE so two parallel accepts
      // (two tabs / double-tap on different responses) cannot both observe
      // status='open' and each create a trip + accepted booking. The second
      // waiter blocks here, then re-reads status='closed' below and 409s.
      const locked = await tx.$queryRaw<
        Array<{
          id: string;
          passenger_id: string;
          status: string;
          seats_needed: number;
        }>
      >`
        SELECT id, passenger_id, status, seats_needed
        FROM passenger_requests WHERE id = ${requestId}::uuid FOR UPDATE
      `;
      const request = locked[0];
      if (!request) throw Errors.notFound('PassengerRequest');
      if (request.passenger_id !== passengerId) throw Errors.forbidden();
      if (request.status !== 'open') throw Errors.conflict('Request already closed');

      // Read the response only AFTER the request lock, so a decline / re-offer
      // that committed while we waited is seen (not overwritten to accepted).
      const response = await tx.passengerRequestResponse.findUnique({ where: { id: responseId } });
      if (!response || response.requestId !== requestId) throw Errors.notFound('Response');
      if (response.status !== 'pending') throw Errors.conflict('Response not pending', { current_status: response.status });
      if (response.expiresAt < new Date()) throw Errors.conflict('Response expired');
      // A response can be accepted up to the 47th hour of its TTL — reject if the
      // agreed departure time has already passed (the created trip would be born
      // un-completable / already-departed).
      if (response.departureTime.getTime() <= Date.now()) {
        throw Errors.conflict('Departure time already passed', { reason: 'departure_in_past' });
      }
      const full = await tx.passengerRequest.findUniqueOrThrow({
        where: { id: requestId },
        include: requestInclude,
      });

      // Create a Trip for the driver — it inherits the passenger's places and
      // pins, so the driver's map shows exactly where to pick them up.
      const trip = await tx.trip.create({
        data: {
          driverId: response.driverId,
          kind: full.kind,
          originCityId: full.originCityId,
          destinationCityId: full.destinationCityId,
          originCity: full.originCity,
          destinationCity: full.destinationCity,
          originAddress: full.originAddress,
          originLat: full.originLat,
          originLng: full.originLng,
          destinationAddress: full.destinationAddress,
          destinationLat: full.destinationLat,
          destinationLng: full.destinationLng,
          originAreaId: full.originAreaId,
          destinationAreaId: full.destinationAreaId,
          // Validated non-past above → the 'direct' trip is born with a future
          // departure the trips lifecycle can complete.
          departureAt: response.departureTime,
          estimatedDurationMin: estimateDurationMin(full.origin, full.destination),
          seatsTotal: request.seats_needed,
          // All seats are consumed by the accepted booking created below, so a
          // 'direct' trip carries no public availability.
          seatsAvailable: 0,
          pricePerSeat: response.price,
          // 'direct' bypasses the one-active-per-day partial unique index
          // (driver_id, date) WHERE status='active'. These trips are private
          // arrangements not visible in public search.
          status: 'direct',
        },
      });

      // Create accepted booking directly
      const booking = await tx.booking.create({
        data: {
          tripId: trip.id,
          passengerId,
          seatsCount: request.seats_needed,
          pricePerSeatSnapshot: response.price,
          status: 'accepted',
        },
      });

      // Mark this response accepted
      await tx.passengerRequestResponse.update({
        where: { id: responseId },
        data: { status: 'accepted', bookingId: booking.id },
      });

      // Decline all other pending responses
      await tx.passengerRequestResponse.updateMany({
        where: { requestId, status: 'pending', id: { not: responseId } },
        data: { status: 'declined' },
      });

      // Close the request
      await tx.passengerRequest.update({
        where: { id: requestId },
        data: { status: 'closed' },
      });

      return { bookingId: booking.id, driverId: response.driverId };
    });

    const passenger = await prisma.user.findUnique({ where: { id: passengerId }, select: { name: true } });

    await notifier.requestResponseAccepted(result.driverId, {
      responseId,
      requestId,
      bookingId: result.bookingId,
      passengerName: passenger?.name ?? 'Пассажир',
    });

    // Notify declined drivers
    const declinedResponses = await prisma.passengerRequestResponse.findMany({
      where: { requestId, status: 'declined', id: { not: responseId } },
      select: { id: true, driverId: true },
    });
    await Promise.all(
      declinedResponses.map((r) =>
        notifier.requestResponseDeclined(r.driverId, { responseId: r.id, requestId }),
      ),
    );

    return { bookingId: result.bookingId };
  }

  async function declineResponse(passengerId: string, requestId: string, responseId: string): Promise<void> {
    const response = await prisma.passengerRequestResponse.findUnique({ where: { id: responseId } });
    if (!response || response.requestId !== requestId) throw Errors.notFound('Response');
    if (response.status !== 'pending') throw Errors.conflict('Response not pending');

    const request = await prisma.passengerRequest.findUnique({ where: { id: requestId } });
    if (!request) throw Errors.notFound('PassengerRequest');
    if (request.passengerId !== passengerId) throw Errors.forbidden();

    const { count } = await prisma.passengerRequestResponse.updateMany({
      where: { id: responseId, status: 'pending' },
      data: { status: 'declined' },
    });
    if (count !== 1) throw Errors.conflict('Response not pending');

    await notifier.requestResponseDeclined(response.driverId, { responseId, requestId });
  }

  // Response-id-only variants (Telegram callback_data fits a single uuid). The
  // request id is derived; ownership and state are checked by the delegates.
  async function requestIdOf(responseId: string): Promise<string> {
    const r = await prisma.passengerRequestResponse.findUnique({
      where: { id: responseId },
      select: { requestId: true },
    });
    if (!r) throw Errors.notFound('Response');
    return r.requestId;
  }

  async function acceptResponseById(passengerId: string, responseId: string): Promise<{ bookingId: string }> {
    return acceptResponse(passengerId, await requestIdOf(responseId), responseId);
  }

  async function declineResponseById(passengerId: string, responseId: string): Promise<void> {
    return declineResponse(passengerId, await requestIdOf(responseId), responseId);
  }

  return { respond, listResponses, acceptResponse, declineResponse, acceptResponseById, declineResponseById };
}
