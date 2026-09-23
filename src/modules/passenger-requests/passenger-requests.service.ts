import type { PrismaClient } from '@prisma/client';
import { Errors } from '@/lib/errors.js';
import { toFileUrl } from '@/lib/uploads.js';
import { createEngagementService } from '@/lib/engagement.js';
import { districtCityNames } from '@/lib/cityArea.js';
import { redactContactInfo } from '@/lib/contentFilter.js';
import { bishkekDayRange } from '@/lib/dates.js';
import type { Notifier } from '@/lib/notifier.js';
import type { CreatePassengerRequestInput, ListRequestsInput, RespondInput, UpdatePassengerRequestInput } from './passenger-requests.schemas.js';

export interface PassengerRequestDTO {
  id: string;
  passengerId: string;
  originCity: string;
  destinationCity: string;
  seatsNeeded: number;
  departureDate: string;
  flexible: boolean;
  comment: string | null;
  status: string;
  createdAt: string;
  liked: boolean;
  // The viewing driver's own response to this request (guards double-respond).
  myResponse: { id: string; status: string } | null;
  metrics: { views: number; likes: number; contacts: number };
  passenger: {
    id: string;
    name: string;
    avatarUrl: string | null;
    rating: number | null;
    ratingCount: number;
  };
}

// Browse card DTO — a strict subset of PassengerRequestDTO carrying only what
// the request card renders. The detail (getById) still returns the full DTO
// (comment, metrics), fetched when a card opens. Keep in sync with the web
// RequestCard component and the PassengerRequestCardItem OpenAPI schema.
export interface PassengerRequestCardItem {
  id: string;
  passengerId: string;
  originCity: string;
  destinationCity: string;
  seatsNeeded: number;
  departureDate: string;
  flexible: boolean;
  status: string;
  liked: boolean;
  myResponse: { id: string; status: string } | null;
  passenger: {
    id: string;
    name: string;
    avatarUrl: string | null;
    rating: number | null;
    ratingCount: number;
  };
}

const RATING_VISIBLE_AFTER = 3;

// Lean projection for browse cards — a strict subset of toDTO.
export function toCardItem(
  row: {
    id: string;
    passengerId: string;
    originCity: string;
    destinationCity: string;
    seatsNeeded: number;
    departureDate: Date;
    flexible: boolean;
    status: string;
    passenger: {
      id: string;
      name: string;
      avatarUrl: string | null;
      rating: { toNumber: () => number } | number;
      ratingCount: number;
    };
  },
  opts: { liked: boolean; myResponse?: { id: string; status: string } | null },
): PassengerRequestCardItem {
  return {
    id: row.id,
    passengerId: row.passengerId,
    originCity: row.originCity,
    destinationCity: row.destinationCity,
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
        row.passenger.ratingCount >= RATING_VISIBLE_AFTER
          ? typeof row.passenger.rating === 'number'
            ? row.passenger.rating
            : row.passenger.rating.toNumber()
          : null,
      ratingCount: row.passenger.ratingCount,
    },
  };
}

export function toDTO(
  row: {
    id: string;
    passengerId: string;
    originCity: string;
    destinationCity: string;
    seatsNeeded: number;
    departureDate: Date;
    flexible: boolean;
    comment: string | null;
    status: string;
    createdAt: Date;
    viewsCount: number;
    likesCount: number;
    passenger: {
      id: string;
      name: string;
      avatarUrl: string | null;
      rating: { toNumber: () => number } | number;
      ratingCount: number;
    };
  },
  opts: { liked: boolean; contacts?: number; myResponse?: { id: string; status: string } | null },
): PassengerRequestDTO {
  return {
    id: row.id,
    passengerId: row.passengerId,
    originCity: row.originCity,
    destinationCity: row.destinationCity,
    seatsNeeded: row.seatsNeeded,
    departureDate: row.departureDate.toISOString(),
    flexible: row.flexible,
    comment: row.comment,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    liked: opts.liked,
    myResponse: opts.myResponse ?? null,
    metrics: { views: row.viewsCount, likes: row.likesCount, contacts: opts.contacts ?? 0 },
    passenger: {
      id: row.passenger.id,
      name: row.passenger.name,
      avatarUrl: toFileUrl(row.passenger.avatarUrl),
      rating:
        row.passenger.ratingCount >= RATING_VISIBLE_AFTER
          ? typeof row.passenger.rating === 'number'
            ? row.passenger.rating
            : row.passenger.rating.toNumber()
          : null,
      ratingCount: row.passenger.ratingCount,
    },
  };
}

export const passengerSelect = {
  id: true,
  name: true,
  avatarUrl: true,
  rating: true,
  ratingCount: true,
} as const;

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

    // Validate cities exist
    const [origin, dest] = await Promise.all([
      prisma.city.findFirst({ where: { nameRu: input.originCity, isActive: true } }),
      prisma.city.findFirst({ where: { nameRu: input.destinationCity, isActive: true } }),
    ]);
    if (!origin) throw Errors.validation({ originCity: 'unknown city' });
    if (!dest) throw Errors.validation({ destinationCity: 'unknown city' });

    // Business rule: one open request per route per day (mirrors trips —
    // duplicates only clutter the feed).
    const { start: dayStart, end: dayEnd } = bishkekDayRange(departure);
    const duplicate = await prisma.passengerRequest.count({
      where: {
        passengerId,
        status: 'open',
        originCity: input.originCity,
        destinationCity: input.destinationCity,
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
        originCity: input.originCity,
        destinationCity: input.destinationCity,
        seatsNeeded: input.seatsNeeded,
        departureDate: departure,
        flexible: input.flexible ?? false,
        comment: redactContactInfo(input.comment).clean,
        status: 'open',
      },
      include: { passenger: { select: passengerSelect } },
    });

    return toDTO(row, { liked: false, myResponse: null });
  }

  async function list(
    input: ListRequestsInput,
    viewerId: string | null = null,
  ): Promise<{ data: PassengerRequestCardItem[]; nextCursor: string | null; nearby?: boolean }> {
    const take = input.limit + 1;
    const now = new Date();

    // "nb_" cursor prefix = the first page fell back to the same-raion tier
    // (see trips.service.search) — keep the expanded filter on later pages.
    let nearby = input.cursor?.startsWith('nb_') ?? false;
    const cursor = nearby ? input.cursor!.slice(3) : input.cursor;

    const runQuery = (fromNames: string[] | null, toNames: string[] | null) =>
      prisma.passengerRequest.findMany({
        where: {
          status: 'open',
          departureDate: { gte: now },
          ...(fromNames ? { originCity: { in: fromNames } } : {}),
          ...(toNames ? { destinationCity: { in: toNames } } : {}),
          // Single-day window (same semantics as the trips search «Сегодня» chip).
          // Day is the Asia/Bishkek calendar day (bishkekDayRange) so it matches
          // the calendar the user sees. Floor the window at "now" so «today»
          // doesn't list already-departed requests (departure_date > NOW()).
          ...(input.date
            ? (() => {
                const { start, end } = bishkekDayRange(new Date(input.date));
                return {
                  departureDate: { gte: start > now ? start : now, lt: end },
                };
              })()
            : {}),
          ...(input.seats ? { seatsNeeded: { gte: input.seats } } : {}),
        },
        orderBy: [{ departureDate: 'asc' }, { createdAt: 'desc' }],
        take,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        include: { passenger: { select: passengerSelect } },
      });

    const expandCities = async (): Promise<[string[] | null, string[] | null]> =>
      Promise.all([
        input.from_city ? districtCityNames(prisma, input.from_city) : Promise.resolve(null),
        input.to_city ? districtCityNames(prisma, input.to_city) : Promise.resolve(null),
      ]);

    let rows;
    if (nearby) {
      rows = await runQuery(...(await expandCities()));
    } else {
      rows = await runQuery(
        input.from_city ? [input.from_city] : null,
        input.to_city ? [input.to_city] : null,
      );
      // Exact cities matched nothing on the first page → widen once to the
      // same-raion tier ("sub-cities") and mark the response.
      if (rows.length === 0 && !cursor && (input.from_city || input.to_city)) {
        const [fromNames, toNames] = await expandCities();
        if ((fromNames?.length ?? 0) > 1 || (toNames?.length ?? 0) > 1) {
          nearby = true;
          rows = await runQuery(fromNames, toNames);
        }
      }
    }

    const hasMore = rows.length > input.limit;
    const slice = hasMore ? rows.slice(0, input.limit) : rows;
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
    return {
      data: slice.map((r) =>
        // Info-lean card DTO: only the fields the request card renders (no
        // comment, no metrics, no createdAt). No per-page contactReveal groupBy
        // either. Full data comes from the detail (getById) when a card opens.
        toCardItem(r, {
          liked: likedSet.has(r.id),
          myResponse: respByRequest.get(r.id) ?? null,
        }),
      ),
      nextCursor: hasMore ? `${nearby ? 'nb_' : ''}${slice[slice.length - 1]!.id}` : null,
      ...(nearby ? { nearby: true } : {}),
    };
  }

  async function listMy(passengerId: string): Promise<{ data: PassengerRequestDTO[]; nextCursor: string | null }> {
    // Bound the query so a heavy user can't pull an unbounded result set. Fetch
    // one extra to detect a further page, then expose a cursor (created-at desc,
    // keyed on id) without changing the response shape.
    const LIMIT = 50;
    const rows = await prisma.passengerRequest.findMany({
      where: { passengerId },
      orderBy: [{ createdAt: 'desc' }],
      take: LIMIT + 1,
      include: { passenger: { select: passengerSelect } },
    });
    const hasMore = rows.length > LIMIT;
    const slice = hasMore ? rows.slice(0, LIMIT) : rows;
    const likedSet = await engagement.likedIds('passenger_request', slice.map((r) => r.id), passengerId);
    return {
      // Owner list feeds the lean request card too — no metrics rendered, so no
      // contactReveal groupBy. Full detail is fetched on open.
      data: slice.map((r) => toDTO(r, { liked: likedSet.has(r.id), myResponse: null })),
      nextCursor: hasMore ? slice[slice.length - 1]!.id : null,
    };
  }

  async function cancel(id: string, passengerId: string): Promise<void> {
    const req = await prisma.passengerRequest.findUnique({ where: { id } });
    if (!req) throw Errors.notFound('PassengerRequest');
    if (req.passengerId !== passengerId) throw Errors.forbidden();
    if (req.status !== 'open') throw Errors.conflict('Request is not open');

    await prisma.passengerRequest.update({
      where: { id },
      data: { status: 'cancelled' },
    });
  }

  async function update(
    id: string,
    passengerId: string,
    input: UpdatePassengerRequestInput,
  ): Promise<PassengerRequestDTO> {
    const req = await prisma.passengerRequest.findUnique({ where: { id } });
    if (!req) throw Errors.notFound('PassengerRequest');
    if (req.passengerId !== passengerId) throw Errors.forbidden();
    if (req.status !== 'open') throw Errors.conflict('Request is not open');

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
        ...(input.comment !== undefined
          ? { comment: input.comment === null ? null : redactContactInfo(input.comment).clean }
          : {}),
      },
    });
    return getById(id, passengerId);
  }

  async function getById(id: string, viewerId: string | null = null): Promise<PassengerRequestDTO> {
    const row = await prisma.passengerRequest.findUnique({
      where: { id },
      include: { passenger: { select: passengerSelect } },
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
  async function calendar(query: { from_city: string; to_city: string }) {
    const rows = await prisma.$queryRaw<{ day: string; n: number }[]>`
      SELECT to_char(departure_date AT TIME ZONE 'Asia/Bishkek', 'YYYY-MM-DD') AS day,
             COUNT(*)::int AS n
      FROM passenger_requests
      WHERE status = 'open'
        AND departure_date > NOW()
        AND origin_city = ${query.from_city}
        AND destination_city = ${query.to_city}
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

      // Lock the passenger_request row FOR UPDATE so two parallel accepts
      // (two tabs / double-tap on different responses) cannot both observe
      // status='open' and each create a trip + accepted booking. The second
      // waiter blocks here, then re-reads status='closed' below and 409s.
      const locked = await tx.$queryRaw<
        Array<{
          id: string;
          passenger_id: string;
          status: string;
          origin_city: string;
          destination_city: string;
          seats_needed: number;
        }>
      >`
        SELECT id, passenger_id, status, origin_city, destination_city, seats_needed
        FROM passenger_requests WHERE id = ${requestId}::uuid FOR UPDATE
      `;
      const request = locked[0];
      if (!request) throw Errors.notFound('PassengerRequest');
      if (request.passenger_id !== passengerId) throw Errors.forbidden();
      if (request.status !== 'open') throw Errors.conflict('Request already closed');

      // Create a Trip for the driver
      const trip = await tx.trip.create({
        data: {
          driverId: response.driverId,
          originCity: request.origin_city,
          destinationCity: request.destination_city,
          originAddress: request.origin_city,
          // Validated non-past above → the 'direct' trip is born with a future
          // departure the trips lifecycle can complete.
          departureAt: response.departureTime,
          estimatedDurationMin: 0,
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

    await prisma.passengerRequestResponse.update({
      where: { id: responseId },
      data: { status: 'declined' },
    });

    await notifier.requestResponseDeclined(response.driverId, { responseId, requestId });
  }

  return { respond, listResponses, acceptResponse, declineResponse };
}
