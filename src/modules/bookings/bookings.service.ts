import type { Prisma, PrismaClient } from '@prisma/client';
import { AppError, Errors, publicPhone } from '@/lib/errors.js';
import { toFileUrl } from '@/lib/uploads.js';
import { cursorArgs, sliceAndNext } from '@/lib/pagination.js';
import { bishkekDayRange } from '@/lib/dates.js';
import { logger } from '@/lib/logger.js';
import type { Notifier, PublicBooking, PublicTrip } from '@/lib/notifier.js';
import type {
  BookingCancelInput,
  BookingCreateInput,
  IncomingBookingsInput,
  MyBookingsInput,
} from './bookings.schemas.js';

// ─── Business-rule constants ──────────────────────────────────────────
// TZ §11.2 step 3 — pending booking auto-expires 1 hour after creation.
const BOOKING_PENDING_TTL_MIN = 60;
// TZ §16.1 — cancellation window for passengers: ≥2h before departure = clean
// cancel; less than 2h = `cancelled_late` (no penalty in MVP, pointer for Stage 3).
const LATE_CANCEL_CUTOFF_HOURS = 2;
// TZ §7.7 "Видимость номера телефона" — the real phone is exposed only once the
// booking is accepted, and for 48h after the trip completes. In every other
// state (pending/viewed/rejected/expired/cancelled) both sides see name +
// rating only. This is the platform's anti-bypass guarantee.
const POST_COMPLETION_PHONE_WINDOW_HOURS = 48;

/** TZ §7.7 — whether the counterparty's phone may be revealed for this booking. */
function isPhoneVisible(bookingStatus: string, tripCompletedAt: Date | null): boolean {
  if (bookingStatus === 'accepted') return true;
  if (bookingStatus === 'completed') {
    // Legacy completed trips without a completedAt were backfilled; if it is
    // still null we treat the window as closed rather than always-open.
    if (!tripCompletedAt) return false;
    return Date.now() - tripCompletedAt.getTime() < POST_COMPLETION_PHONE_WINDOW_HOURS * 60 * 60_000;
  }
  return false;
}

// ─── Public shapes ────────────────────────────────────────────────────
export interface BookingDTO extends PublicBooking {
  trip: PublicTrip & {
    driver: {
      id: string;
      name: string;
      avatarUrl: string | null;
      phone?: string | null;
      rating: number | null;
      ratingCount: number;
    };
    seatsAvailable: number;
    pricePerSeat: number;
  };
  pricePerSeatSnapshot: number;
  passenger: {
    id: string;
    name: string;
    avatarUrl: string | null;
    phone?: string | null;
    rating: number | null;
    ratingCount: number;
  };
}

export interface BookingsService {
  create(
    passengerId: string,
    body: BookingCreateInput,
    idempotencyKey?: string,
  ): Promise<{ booking: BookingDTO; reused: boolean }>;
  accept(bookingId: string, driverUserId: string): Promise<BookingDTO>;
  reject(bookingId: string, driverUserId: string, reason?: string): Promise<BookingDTO>;
  cancel(bookingId: string, userId: string, input: BookingCancelInput): Promise<BookingDTO>;
  noShow(bookingId: string, driverUserId: string): Promise<BookingDTO>;
  listMy(
    passengerId: string,
    query: MyBookingsInput,
  ): Promise<{ data: BookingDTO[]; nextCursor: string | null }>;
  listIncoming(
    driverUserId: string,
    query: IncomingBookingsInput,
  ): Promise<{ data: BookingDTO[]; nextCursor: string | null }>;
  getById(id: string, viewerId: string): Promise<BookingDTO>;
  /** Called when the driver first views a pending booking — sets viewed_at. */
  markViewed(bookingId: string, driverUserId: string): Promise<void>;
}

export function createBookingsService(prisma: PrismaClient, notifier: Notifier): BookingsService {
  // ─── Create ─────────────────────────────────────────────────────────
  // TZ §11.3 critical race protection: wrap in a transaction that SELECTs the
  // trip FOR UPDATE so two simultaneous POSTs cannot both see the same
  // `seats_available` value.
  async function create(
    passengerId: string,
    body: BookingCreateInput,
    idempotencyKey?: string,
  ): Promise<{ booking: BookingDTO; reused: boolean }> {
    // Idempotency-Key replay: a retried request (e.g. the 201 was lost on the
    // wire) returns the ORIGINAL booking instead of a 409 — same contract as
    // POST /trips (TZ §19.1).
    if (idempotencyKey) {
      const prior = await prisma.booking.findUnique({ where: { idempotencyKey } });
      if (prior) {
        if (prior.passengerId !== passengerId) {
          throw Errors.conflict('Idempotency-Key belongs to another user', {
            reason: 'idempotency_key_mismatch',
          });
        }
        return { booking: await loadDTO(prisma, prior.id), reused: true };
      }
    }
    const now = new Date();
    const expiresAt = new Date(now.getTime() + BOOKING_PENDING_TTL_MIN * 60_000);

    const created = await prisma.$transaction(async (tx) => {
      // Lock the trip row.
      const locked = await tx.$queryRaw<
        Array<{
          id: string;
          driver_id: string;
          status: string;
          seats_available: number;
          price_per_seat: number;
          origin_city: string;
          destination_city: string;
          departure_at: Date;
        }>
      >`
        SELECT id, driver_id, status, seats_available, price_per_seat, origin_city, destination_city, departure_at
        FROM trips WHERE id = ${body.tripId}::uuid FOR UPDATE
      `;
      const trip = locked[0];
      if (!trip) throw Errors.notFound('Trip');
      if (trip.status !== 'active') throw Errors.tripNotActive();
      if (trip.driver_id === passengerId) {
        throw Errors.validation({ reason: 'cannot_book_own_trip' });
      }

      // Reject bookings against a driver who has been blocked or soft-deleted.
      const driver = await tx.user.findUnique({
        where: { id: trip.driver_id },
        select: { isBlocked: true, deletedAt: true },
      });
      if (!driver || driver.deletedAt) throw Errors.notFound('Trip');
      if (driver.isBlocked) {
        throw Errors.conflict('Driver is not available', { reason: 'driver_blocked' });
      }
      if (trip.departure_at.getTime() <= now.getTime()) {
        throw Errors.tripNotActive();
      }
      if (trip.seats_available < body.seatsCount) {
        throw Errors.seatsNotAvailable({
          seats_requested: body.seatsCount,
          seats_available: trip.seats_available,
        });
      }

      // Most-specific check first: same trip + same passenger (clearest error).
      const existing = await tx.booking.findFirst({
        where: {
          tripId: body.tripId,
          passengerId,
          status: { in: ['pending', 'viewed', 'accepted'] },
        },
      });
      if (existing) throw Errors.bookingAlreadyExists();

      // Business rule: passenger max 3 pending bookings simultaneously.
      const pendingCount = await tx.booking.count({
        where: { passengerId, status: { in: ['pending', 'viewed'] } },
      });
      if (pendingCount >= 3) {
        throw Errors.conflict('Passenger already has 3 pending bookings', {
          reason: 'max_pending_bookings_exceeded',
        });
      }

      // Business rule: no two bookings to the same driver on the same departure
      // date — keyed off the Asia/Bishkek calendar day so it matches the day the
      // user actually sees (rest of the system uses bishkekDayRange).
      const { start: depDay, end: depDayEnd } = bishkekDayRange(trip.departure_at);
      const sameDriverBooking = await tx.booking.findFirst({
        where: {
          passengerId,
          status: { in: ['pending', 'viewed', 'accepted'] },
          trip: {
            driverId: trip.driver_id,
            departureAt: { gte: depDay, lt: depDayEnd },
          },
        },
      });
      if (sameDriverBooking) {
        throw Errors.conflict('Passenger already has a booking with this driver on this date', {
          reason: 'duplicate_driver_booking',
        });
      }

      try {
        return await tx.booking.create({
          data: {
            tripId: body.tripId,
            passengerId,
            seatsCount: body.seatsCount,
            comment: body.comment ?? null,
            status: 'pending',
            expiresAt,
            // Freeze the price the passenger agreed to at request time.
            pricePerSeatSnapshot: trip.price_per_seat,
            idempotencyKey: idempotencyKey ?? null,
          },
        });
      } catch (err) {
        if (
          typeof err === 'object' &&
          err !== null &&
          (err as { code?: string }).code === 'P2002'
        ) {
          throw Errors.bookingAlreadyExists();
        }
        throw err;
      }
    });

    const full = await loadDTO(prisma, created.id);

    // Notify driver — FIRE-AND-FORGET. The booking is already committed, so a
    // slow or hanging external notifier (the Telegram DM to the driver) must
    // never delay the response or cause a proxy 502. Run it in the background;
    // log failures, never throw, never await.
    void notifier
      .bookingNewRequest(full.trip.driverId, {
        booking: full,
        trip: full.trip,
        passengerName: full.passenger.name,
        passengerRating: full.passenger.rating,
      })
      .catch((err) =>
        logger.error({ err, bookingId: full.id }, 'bookingNewRequest notify failed (booking kept)'),
      );

    return { booking: full, reused: false };
  }

  // ─── Accept ─────────────────────────────────────────────────────────
  async function accept(bookingId: string, driverUserId: string): Promise<BookingDTO> {
    const result = await prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<
        Array<{
          id: string;
          trip_id: string;
          passenger_id: string;
          seats_count: number;
          status: string;
        }>
      >`
        SELECT id, trip_id, passenger_id, seats_count, status
        FROM bookings WHERE id = ${bookingId}::uuid FOR UPDATE
      `;
      const bk = locked[0];
      if (!bk) throw Errors.notFound('Booking');
      if (bk.status !== 'pending' && bk.status !== 'viewed') {
        throw Errors.conflict('Booking not pending', { current_status: bk.status });
      }

      const trip = (
        await tx.$queryRaw<
          Array<{ id: string; driver_id: string; seats_available: number; status: string }>
        >`
          SELECT id, driver_id, seats_available, status
          FROM trips WHERE id = ${bk.trip_id}::uuid FOR UPDATE
        `
      )[0];
      if (!trip) throw Errors.notFound('Trip');
      if (trip.driver_id !== driverUserId) throw Errors.forbidden({ reason: 'not_owner' });
      if (trip.status !== 'active') throw Errors.tripNotActive();
      if (trip.seats_available < bk.seats_count) {
        throw Errors.seatsNotAvailable({
          seats_requested: bk.seats_count,
          seats_available: trip.seats_available,
        });
      }

      // Commit: booking→accepted, trip.seats_available decreases.
      await tx.booking.update({
        where: { id: bk.id },
        data: { status: 'accepted' },
      });
      const remaining = trip.seats_available - bk.seats_count;
      await tx.trip.update({
        where: { id: trip.id },
        data: { seatsAvailable: remaining, version: { increment: 1 } },
      });

      // Business rule: when booking accepted, auto-cancel all other pending
      // bookings for this passenger across all trips.
      await tx.booking.updateMany({
        where: {
          passengerId: bk.passenger_id,
          status: { in: ['pending', 'viewed'] },
          id: { not: bk.id },
        },
        data: {
          status: 'cancelled_by_passenger',
          cancelledBy: 'passenger',
          cancelledAt: new Date(),
        },
      });

      // TZ §12.2 — if seats hit zero, all other pending/viewed bookings expire.
      if (remaining === 0) {
        await tx.booking.updateMany({
          where: {
            tripId: trip.id,
            status: { in: ['pending', 'viewed'] },
            id: { not: bk.id },
          },
          data: { status: 'expired' },
        });
      }

      return bk.id;
    });

    const full = await loadDTO(prisma, result);
    // The request is decided — its bell notification is no longer actionable.
    // Marking it read keeps web and Telegram in sync regardless of where the
    // driver pressed «Принять».
    await prisma.notification.updateMany({
      where: {
        userId: driverUserId,
        type: 'new_booking_request',
        readAt: null,
        payload: { path: ['bookingId'], equals: bookingId },
      },
      data: { readAt: new Date() },
    });
    await notifier.bookingAccepted(full.passenger.id, { booking: full });
    await notifier.bookingRequestConfirmed(full.trip.driverId, {
      booking: full,
      passengerName: full.passenger.name,
    });
    // Chat transitions from pre_booking to full phase on accept.
    await notifier.chatPhaseChanged(full.id, { phase: 'full', bookingId: full.id });

    // If seats hit 0 we also need to notify those who just got expired.
    // (We could do this in the transaction too, but per-notification side
    // effects shouldn't block DB commit.)
    if (full.trip.seatsAvailable === 0) {
      const expiredPeers = await prisma.booking.findMany({
        where: {
          tripId: full.trip.id,
          status: 'expired',
          id: { not: full.id },
        },
        select: {
          id: true,
          passengerId: true,
          tripId: true,
          seatsCount: true,
          status: true,
          createdAt: true,
          expiresAt: true,
          comment: true,
        },
      });
      for (const e of expiredPeers) {
        await notifier.bookingExpired(e.passengerId, {
          booking: {
            id: e.id,
            tripId: e.tripId,
            passengerId: e.passengerId,
            seatsCount: e.seatsCount,
            status: e.status,
            createdAt: e.createdAt,
            expiresAt: e.expiresAt,
            comment: e.comment,
          },
        });
      }
    }

    return full;
  }

  // ─── Reject ─────────────────────────────────────────────────────────
  async function reject(
    bookingId: string,
    driverUserId: string,
    _reason?: string,
  ): Promise<BookingDTO> {
    const bk = await prisma.booking.findUnique({
      where: { id: bookingId },
      include: { trip: { select: { driverId: true } } },
    });
    if (!bk) throw Errors.notFound('Booking');
    if (bk.trip.driverId !== driverUserId) throw Errors.forbidden({ reason: 'not_owner' });
    if (bk.status !== 'pending' && bk.status !== 'viewed') {
      throw Errors.conflict('Booking not pending', { current_status: bk.status });
    }
    await prisma.booking.update({
      where: { id: bookingId },
      data: { status: 'rejected' },
    });

    // Decided → mark the driver's bell notification read (web ⇄ Telegram sync).
    await prisma.notification.updateMany({
      where: {
        userId: driverUserId,
        type: 'new_booking_request',
        readAt: null,
        payload: { path: ['bookingId'], equals: bookingId },
      },
      data: { readAt: new Date() },
    });

    const full = await loadDTO(prisma, bookingId);
    await notifier.bookingRejected(full.passenger.id, { booking: full });
    return full;
  }

  // ─── Cancel (both sides) ────────────────────────────────────────────
  async function cancel(
    bookingId: string,
    userId: string,
    input: BookingCancelInput,
  ): Promise<BookingDTO> {
    const result = await prisma.$transaction(async (tx) => {
      // Lock the booking row FIRST so a concurrent cancel/accept can't decide on
      // a stale status. All seat-return / penalty branching keys off the LOCKED
      // status re-read here — mirrors accept()'s FOR UPDATE discipline.
      const locked = await tx.$queryRaw<
        Array<{
          id: string;
          trip_id: string;
          passenger_id: string;
          seats_count: number;
          status: string;
        }>
      >`
        SELECT id, trip_id, passenger_id, seats_count, status
        FROM bookings WHERE id = ${bookingId}::uuid FOR UPDATE
      `;
      const bk = locked[0];
      if (!bk) throw Errors.notFound('Booking');

      const trip = (
        await tx.$queryRaw<
          Array<{ id: string; driver_id: string; departure_at: Date; status: string }>
        >`
          SELECT id, driver_id, departure_at, status
          FROM trips WHERE id = ${bk.trip_id}::uuid FOR UPDATE
        `
      )[0];
      if (!trip) throw Errors.notFound('Trip');

      const isPassenger = bk.passenger_id === userId;
      const isDriver = trip.driver_id === userId;
      if (!isPassenger && !isDriver) throw Errors.forbidden({ reason: 'not_participant' });
      // Re-check status AFTER the lock — a racing cancel/accept may have already
      // moved it out of an active state.
      if (!['pending', 'viewed', 'accepted'].includes(bk.status)) {
        throw Errors.conflict('Booking not active', { current_status: bk.status });
      }

      const now = new Date();
      const timeToDeparture = trip.departure_at.getTime() - now.getTime();

      let status: string;
      let cancelledBy: 'passenger' | 'driver';
      if (isPassenger) {
        cancelledBy = 'passenger';
        status =
          timeToDeparture < LATE_CANCEL_CUTOFF_HOURS * 60 * 60_000
            ? 'cancelled_late'
            : 'cancelled_by_passenger';
      } else {
        cancelledBy = 'driver';
        status = 'cancelled_by_driver';
      }

      await tx.booking.update({
        where: { id: bk.id },
        data: {
          status,
          cancelledBy,
          cancelledAt: now,
          cancelReasons: input.reasons ?? [],
        },
      });

      // Return seats to the trip pool iff the LOCKED booking was still accepted.
      // Branching on the locked status (not a pre-lock read) prevents a
      // seat-leak on cancel∥accept and a double-return on cancel∥cancel.
      if (bk.status === 'accepted' && trip.status === 'active') {
        await tx.trip.update({
          where: { id: trip.id },
          data: {
            seatsAvailable: { increment: bk.seats_count },
            version: { increment: 1 },
          },
        });
      }

      return {
        bookingId: bk.id,
        cancelledBy,
        otherParty: isPassenger ? trip.driver_id : bk.passenger_id,
        driverId: trip.driver_id,
        wasAccepted: bk.status === 'accepted',
      };
    });

    // TZ §16.2 — driver cancelling an accepted booking loses 0.3 rating.
    // ratingPenalty is the source of truth (recalcAverage subtracts it, so it
    // survives future ratings). We ALSO drop the visible rating now so the
    // sanction is immediate; a later recalc recomputes rating = avg − penalty,
    // re-applying it from the accumulated column — never double-counted, never
    // lost. Floored at 0. Both writes atomic.
    if (result.cancelledBy === 'driver' && result.wasAccepted) {
      await prisma.$executeRaw`
        UPDATE users
        SET rating_penalty = rating_penalty + 0.3,
            rating = GREATEST(0, rating - 0.3)
        WHERE id = ${result.driverId}::uuid`;
    }

    const full = await loadDTO(prisma, result.bookingId);
    await notifier.bookingCancelled(result.otherParty, {
      booking: full,
      cancelledBy: result.cancelledBy,
    });
    return full;
  }

  // ─── No-show ────────────────────────────────────────────────────────
  // TZ §16.1 "Пассажир не явился (no-show) · Водитель нажимает 'Не явился'
  //   после времени отправления · status=no_show, рейтинг пассажира -0.5"
  async function noShow(bookingId: string, driverUserId: string): Promise<BookingDTO> {
    const bk = await prisma.booking.findUnique({
      where: { id: bookingId },
      include: { trip: { select: { driverId: true, departureAt: true } } },
    });
    if (!bk) throw Errors.notFound('Booking');
    if (bk.trip.driverId !== driverUserId) throw Errors.forbidden({ reason: 'not_owner' });
    if (bk.status !== 'accepted') {
      throw Errors.conflict('Booking not accepted', { current_status: bk.status });
    }
    if (bk.trip.departureAt.getTime() > Date.now()) {
      throw Errors.conflict('Trip has not departed yet');
    }

    // Atomic status-guarded transition: updateMany({status:'accepted'}) claims
    // the booking exactly once, so a double-tap can't apply the −0.5 penalty
    // twice. ratingPenalty is the source of truth (recalcAverage subtracts it);
    // we also drop the visible rating now for an immediate sanction, floored at
    // 0 — only when we won the transition.
    await prisma.$transaction(async (tx) => {
      const claimed = await tx.booking.updateMany({
        where: { id: bookingId, status: 'accepted' },
        data: { status: 'no_show' },
      });
      if (claimed.count !== 1) {
        throw Errors.conflict('Booking not accepted');
      }
      await tx.$executeRaw`
        UPDATE users
        SET rating_penalty = rating_penalty + 0.5,
            rating = GREATEST(0, rating - 0.5)
        WHERE id = ${bk.passengerId}::uuid`;
    });

    return loadDTO(prisma, bookingId);
  }

  // ─── Listings ───────────────────────────────────────────────────────
  async function listMy(
    passengerId: string,
    query: MyBookingsInput,
  ): Promise<{ data: BookingDTO[]; nextCursor: string | null }> {
    const where: Prisma.BookingWhereInput = { passengerId };
    if (query.status) where.status = query.status;
    const rows = await prisma.booking.findMany({
      where,
      include: bookingDTOInclude,
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
      ...cursorArgs({ cursor: query.cursor, limit: query.limit }),
    });
    const dtos = rows.map(mapBookingDTO);
    return sliceAndNext(dtos, query.limit);
  }

  async function listIncoming(
    driverUserId: string,
    query: IncomingBookingsInput,
  ): Promise<{ data: BookingDTO[]; nextCursor: string | null }> {
    const where: Prisma.BookingWhereInput = {
      status: { in: ['pending', 'viewed'] },
      trip: { driverId: driverUserId },
      ...(query.tripId ? { tripId: query.tripId } : {}),
    };
    const rows = await prisma.booking.findMany({
      where,
      include: bookingDTOInclude,
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      ...cursorArgs({ cursor: query.cursor, limit: query.limit }),
    });
    const dtos = rows.map(mapBookingDTO);
    return sliceAndNext(dtos, query.limit);
  }

  async function getById(id: string, viewerId: string): Promise<BookingDTO> {
    const dto = await loadDTO(prisma, id);
    if (dto.passenger.id !== viewerId && dto.trip.driverId !== viewerId) {
      throw Errors.forbidden({ reason: 'not_participant' });
    }
    return dto;
  }

  // ─── markViewed ─────────────────────────────────────────────────────
  // TZ §11 — when driver opens a pending booking, stamp viewed_at and notify
  // the passenger so they see a "seen" indicator.
  async function markViewed(bookingId: string, driverUserId: string): Promise<void> {
    const bk = await prisma.booking.findUnique({
      where: { id: bookingId },
      include: { trip: { select: { driverId: true } } },
    });
    if (!bk) return; // silently skip — no error; caller is a read path
    if (bk.trip.driverId !== driverUserId) return;
    if (bk.viewedAt) return; // already marked
    if (bk.status !== 'pending') return;

    await prisma.booking.update({
      where: { id: bookingId },
      data: { viewedAt: new Date(), status: 'viewed' },
    });
    await notifier.bookingViewed(bk.passengerId, {
      bookingId,
      viewedAt: new Date(),
    });
  }

  return {
    create,
    accept,
    reject,
    cancel,
    noShow,
    listMy,
    listIncoming,
    getById,
    markViewed,
  };
}

// ─── Internal helpers ─────────────────────────────────────────────────
// Single source of truth for the relations a BookingDTO needs. Shared by the
// per-id loader and the list queries so lists fetch everything in one findMany
// (no per-row round-trips → no N+1).
const bookingDTOInclude = {
  trip: {
    select: {
      id: true,
      driverId: true,
      originCity: true,
      destinationCity: true,
      departureAt: true,
      seatsAvailable: true,
      pricePerSeat: true,
      completedAt: true,
      driver: {
        select: {
          id: true,
          name: true,
          avatarUrl: true,
          phone: true,
          rating: true,
          ratingCount: true,
        },
      },
    },
  },
  passenger: {
    select: {
      id: true,
      name: true,
      avatarUrl: true,
      phone: true,
      rating: true,
      ratingCount: true,
    },
  },
} satisfies Prisma.BookingInclude;

type BookingRowWithRelations = Prisma.BookingGetPayload<{ include: typeof bookingDTOInclude }>;

/** Pure row → DTO mapping. No DB access — safe to map a whole list in memory. */
function mapBookingDTO(row: BookingRowWithRelations): BookingDTO {
  // TZ §7.7 — gate phone exposure by booking status. Hidden until accepted.
  const showPhone = isPhoneVisible(row.status, row.trip.completedAt);

  return {
    id: row.id,
    tripId: row.tripId,
    passengerId: row.passengerId,
    seatsCount: row.seatsCount,
    status: row.status,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    comment: row.comment,
    // Legacy rows predate the snapshot column — fall back to the live trip price.
    pricePerSeatSnapshot: row.pricePerSeatSnapshot ?? row.trip.pricePerSeat,
    trip: {
      id: row.trip.id,
      driverId: row.trip.driverId,
      originCity: row.trip.originCity,
      destinationCity: row.trip.destinationCity,
      departureAt: row.trip.departureAt,
      seatsAvailable: row.trip.seatsAvailable,
      pricePerSeat: row.trip.pricePerSeat,
      driver: {
        id: row.trip.driver.id,
        name: row.trip.driver.name,
        avatarUrl: toFileUrl(row.trip.driver.avatarUrl),
        phone: showPhone ? publicPhone(row.trip.driver.phone) || null : null,
        rating: row.trip.driver.ratingCount >= 3 ? Number(row.trip.driver.rating) : null,
        ratingCount: row.trip.driver.ratingCount,
      },
    },
    passenger: {
      id: row.passenger.id,
      name: row.passenger.name,
      avatarUrl: toFileUrl(row.passenger.avatarUrl),
      phone: showPhone ? publicPhone(row.passenger.phone) || null : null,
      rating: row.passenger.ratingCount >= 3 ? Number(row.passenger.rating) : null,
      ratingCount: row.passenger.ratingCount,
    },
  };
}

async function loadDTO(prisma: PrismaClient, id: string): Promise<BookingDTO> {
  const row = await prisma.booking.findUnique({
    where: { id },
    include: bookingDTOInclude,
  });
  if (!row) throw Errors.notFound('Booking');
  return mapBookingDTO(row);
}

// silence unused
void AppError;
void logger;
