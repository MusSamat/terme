import { Prisma } from '@prisma/client';
import type { PrismaClient } from '@prisma/client';
import { Errors } from '@/lib/errors.js';
import { sliceAndNext } from '@/lib/pagination.js';
import type { Notifier } from '@/lib/notifier.js';
import type { RatingCreateInput } from './ratings.schemas.js';
import { logger } from '@/lib/logger.js';

// ─── Business constants from TZ §14 ────────────────────────────────
const RATING_WINDOW_DAYS = 7;           // §14.4
const RATING_VISIBLE_AFTER = 3;         // §14.3 — hide avg until N
const RATING_SAMPLE = 50;               // §14.3 — rolling window
const WARN_THRESHOLD = 4.0;             // §14.3 "rating_warning"
const REVIEW_THRESHOLD = 3.5;           // §14.3 admin low_rating_review
const SUSPEND_THRESHOLD = 3.0;          // §14.3 suspend driver
const SPAM_SAME_COMMENT_THRESHOLD = 5;  // §14.4 — alert admin after N identical

export interface RatingsService {
  create(
    raterId: string,
    body: RatingCreateInput,
  ): Promise<{ id: string; rateeNewAverage: number | null }>;
  pending(
    userId: string,
    query: { cursor?: string; limit: number },
  ): Promise<{
    data: Array<{
      tripId: string;
      counterpartId: string;
      counterpartName: string;
      direction: 'driver' | 'passenger';
      departureAt: Date;
      expiresAt: Date;
    }>;
    nextCursor: string | null;
  }>;
}

export function createRatingsService(prisma: PrismaClient, notifier: Notifier): RatingsService {
  // ─── Create ─────────────────────────────────────────────────────────
  async function create(
    raterId: string,
    body: RatingCreateInput,
  ): Promise<{ id: string; rateeNewAverage: number | null }> {
    if (raterId === body.rateeId) {
      throw Errors.validation({ reason: 'cannot_rate_self' });
    }

    // Verify the rater+ratee actually shared this trip in a completed booking
    // (TZ §14.4 "Нельзя оценить без completed поездки"). Look up the trip +
    // any booking that joins the two parties with status=completed.
    const trip = await prisma.trip.findUnique({
      where: { id: body.tripId },
      include: {
        bookings: {
          where: {
            status: 'completed',
            OR: [
              { passengerId: raterId },
              { passengerId: body.rateeId },
            ],
          },
          select: { passengerId: true, status: true },
        },
      },
    });
    if (!trip) throw Errors.notFound('Trip');
    if (trip.status !== 'completed') {
      throw Errors.conflict('Trip not completed', { current_status: trip.status });
    }

    // Valid directions:
    //   passenger → driver : rater is any passenger on this trip, ratee is trip.driver
    //   driver    → passenger : rater is trip.driver, ratee is a passenger on this trip
    const isDriverRating = raterId === trip.driverId && body.rateeId !== trip.driverId;
    const isPassengerRating = body.rateeId === trip.driverId && raterId !== trip.driverId;
    if (!isDriverRating && !isPassengerRating) {
      throw Errors.forbidden({ reason: 'not_a_trip_participant' });
    }
    // If it's passenger→driver, ensure rater actually has a completed booking.
    if (isPassengerRating) {
      const raterBooking = trip.bookings.find((b) => b.passengerId === raterId);
      if (!raterBooking) {
        throw Errors.forbidden({ reason: 'no_completed_booking' });
      }
    }
    // Driver→passenger: ratee must be a passenger of a completed booking.
    if (isDriverRating) {
      const rateeBooking = trip.bookings.find((b) => b.passengerId === body.rateeId);
      if (!rateeBooking) {
        throw Errors.forbidden({ reason: 'ratee_not_in_trip' });
      }
    }

    // 7-day window (§14.4). Use trip.departureAt as anchor — the moment trips
    // become completable.
    const windowEnd = new Date(trip.departureAt.getTime() + RATING_WINDOW_DAYS * 24 * 60 * 60_000);
    if (Date.now() > windowEnd.getTime()) {
      throw Errors.conflict('Rating window closed', {
        reason: 'rating_window_closed',
        window_end: windowEnd.toISOString(),
      });
    }

    // Unique (trip, rater, ratee) — UNIQUE constraint, but explicit check gives
    // a clearer code.
    const dup = await prisma.rating.findUnique({
      where: {
        tripId_raterId_rateeId: {
          tripId: body.tripId,
          raterId,
          rateeId: body.rateeId,
        },
      },
    });
    if (dup) throw Errors.conflict('Already rated', { reason: 'already_rated' });

    let created;
    try {
      created = await prisma.rating.create({
        data: {
          tripId: body.tripId,
          raterId,
          rateeId: body.rateeId,
          score: body.score,
          tags: body.tags,
          comment: body.comment ?? null,
        },
      });
    } catch (e) {
      // Concurrent insert can win the race between our findUnique dup-check and
      // create() — the UNIQUE (trip, rater, ratee) constraint throws P2002.
      // Translate to the same clean 409 the explicit check returns.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw Errors.conflict('Already rated', { reason: 'already_rated' });
      }
      throw e;
    }

    // Post-insert aggregation + warnings (TZ §14.3 pseudocode).
    const { average } = await recalcAverage(prisma, body.rateeId);
    await applyRatingSideEffects(prisma, notifier, {
      rateeId: body.rateeId,
      raterId,
      trip,
      average,
      comment: body.comment ?? null,
      score: body.score,
    });

    return { id: created.id, rateeNewAverage: average };
  }

  // ─── Pending ────────────────────────────────────────────────────────
  // Return trips the caller can still rate. One row per (trip, counterpart):
  //   • as passenger: each completed booking where you were passenger and you
  //     haven't rated the driver yet.
  //   • as driver: each completed booking on your trip where you haven't rated
  //     that passenger yet.
  async function pending(
    userId: string,
    query: { cursor?: string; limit: number },
  ): Promise<Awaited<ReturnType<RatingsService['pending']>>> {
    // Cursor here is an opaque id — we use the booking id as stable key since
    // there's one "pending rating row" per booking from the user's POV.

    const since = new Date(Date.now() - RATING_WINDOW_DAYS * 24 * 60 * 60_000);

    // Cursor = booking id of the last item on the previous page. The merged list
    // is ordered by departure_at DESC, so translate the cursor into its anchor
    // (departure_at, booking id) and push a keyset predicate into both queries.
    // Rows strictly "after" the anchor: earlier departure, or same departure with
    // a larger id (stable tiebreaker matching the in-memory sort's id fallback).
    let cursorAnchor: { departureAt: Date; bookingId: string } | null = null;
    if (query.cursor) {
      const anchorRows = await prisma.$queryRaw<Array<{ departure_at: Date }>>`
        SELECT t.departure_at
        FROM bookings b
        JOIN trips t ON t.id = b.trip_id
        WHERE b.id = ${query.cursor}::uuid
        LIMIT 1
      `;
      const anchor = anchorRows[0];
      if (anchor) {
        cursorAnchor = { departureAt: anchor.departure_at, bookingId: query.cursor };
      }
    }
    const cursorDeparture = cursorAnchor?.departureAt ?? null;
    const cursorBookingId = cursorAnchor?.bookingId ?? null;

    // take+1 to detect "has more"; LIMIT each source so neither scans unbounded.
    const sqlLimit = query.limit + 1;

    // Passenger-side: bookings where user = passenger, status = completed,
    // no rating from user to driver yet, within window.
    const asPassengerRows = await prisma.$queryRaw<
      Array<{
        booking_id: string;
        trip_id: string;
        driver_id: string;
        driver_name: string;
        departure_at: Date;
      }>
    >`
      SELECT b.id AS booking_id,
             t.id AS trip_id,
             t.driver_id,
             du.name AS driver_name,
             t.departure_at
      FROM bookings b
      JOIN trips t ON t.id = b.trip_id
      JOIN users du ON du.id = t.driver_id
      WHERE b.passenger_id = ${userId}::uuid
        AND b.status = 'completed'
        AND t.departure_at >= ${since}
        AND (
          ${cursorDeparture}::timestamptz IS NULL
          OR t.departure_at < ${cursorDeparture}::timestamptz
          OR (t.departure_at = ${cursorDeparture}::timestamptz AND b.id > ${cursorBookingId}::uuid)
        )
        AND NOT EXISTS (
          SELECT 1 FROM ratings r
          WHERE r.trip_id = t.id AND r.rater_id = ${userId}::uuid AND r.ratee_id = t.driver_id
        )
      ORDER BY t.departure_at DESC, b.id ASC
      LIMIT ${sqlLimit}
    `;

    // Driver-side: completed bookings on user's trips where user hasn't rated
    // the passenger yet.
    const asDriverRows = await prisma.$queryRaw<
      Array<{
        booking_id: string;
        trip_id: string;
        passenger_id: string;
        passenger_name: string;
        departure_at: Date;
      }>
    >`
      SELECT b.id AS booking_id,
             t.id AS trip_id,
             b.passenger_id,
             pu.name AS passenger_name,
             t.departure_at
      FROM bookings b
      JOIN trips t ON t.id = b.trip_id
      JOIN users pu ON pu.id = b.passenger_id
      WHERE t.driver_id = ${userId}::uuid
        AND b.status = 'completed'
        AND t.departure_at >= ${since}
        AND (
          ${cursorDeparture}::timestamptz IS NULL
          OR t.departure_at < ${cursorDeparture}::timestamptz
          OR (t.departure_at = ${cursorDeparture}::timestamptz AND b.id > ${cursorBookingId}::uuid)
        )
        AND NOT EXISTS (
          SELECT 1 FROM ratings r
          WHERE r.trip_id = t.id AND r.rater_id = ${userId}::uuid AND r.ratee_id = b.passenger_id
        )
      ORDER BY t.departure_at DESC, b.id ASC
      LIMIT ${sqlLimit}
    `;

    const items = [
      ...asPassengerRows.map((r) => ({
        id: r.booking_id,
        tripId: r.trip_id,
        counterpartId: r.driver_id,
        counterpartName: r.driver_name,
        direction: 'driver' as const,
        departureAt: r.departure_at,
        expiresAt: new Date(r.departure_at.getTime() + RATING_WINDOW_DAYS * 24 * 60 * 60_000),
      })),
      ...asDriverRows.map((r) => ({
        id: r.booking_id,
        tripId: r.trip_id,
        counterpartId: r.passenger_id,
        counterpartName: r.passenger_name,
        direction: 'passenger' as const,
        departureAt: r.departure_at,
        expiresAt: new Date(r.departure_at.getTime() + RATING_WINDOW_DAYS * 24 * 60 * 60_000),
      })),
    ].sort((a, b) => {
      const byDeparture = b.departureAt.getTime() - a.departureAt.getTime();
      // Tiebreaker must match SQL "b.id ASC" so the merged order is stable and
      // the cursor keyset lines up across pages.
      return byDeparture !== 0 ? byDeparture : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });

    // Each source already applied the keyset cursor + LIMIT (limit+1). The merged
    // list can hold up to 2*(limit+1) rows; slice to the page and derive the next
    // cursor (booking id of the last emitted row).
    return sliceAndNext(items, query.limit);
  }

  return { create, pending };

  async function applyRatingSideEffects(
    prisma: PrismaClient,
    notifier: Notifier,
    ctx: {
      rateeId: string;
      raterId: string;
      trip: { id: string; driverId: string };
      average: number | null;
      comment: string | null;
      score: number;
    },
  ): Promise<void> {
    const ratee = await prisma.user.findUniqueOrThrow({
      where: { id: ctx.rateeId },
      select: { name: true, roles: true },
    });
    const rater = await prisma.user.findUniqueOrThrow({
      where: { id: ctx.raterId },
      select: { name: true },
    });

    await notifier.ratingReceived(ctx.rateeId, {
      raterName: rater.name,
      score: ctx.score,
      tripId: ctx.trip.id,
    });

    if (ctx.average === null) return;

    // Warning — every user with a low rating hears about it.
    if (ctx.average < WARN_THRESHOLD) {
      await notifier.ratingWarning(ctx.rateeId, { rating: ctx.average });
    }
    // Admin review alert — broadcast to admins, no per-user row (admins aren't
    // in `users`).
    if (ctx.average < REVIEW_THRESHOLD) {
      await notifier.broadcastToAdmins('low_rating_review', {
        user_id: ctx.rateeId,
        user_name: ratee.name,
        rating: ctx.average,
      });
    }
    // Suspend driver — only flip status for users holding the driver role.
    if (ctx.average < SUSPEND_THRESHOLD && ratee.roles.includes('driver')) {
      await prisma.driverProfile.updateMany({
        where: { userId: ctx.rateeId },
        data: { verificationStatus: 'suspended' },
      });
      logger.warn({ userId: ctx.rateeId, average: ctx.average }, 'driver auto-suspended');
    }

    // Spam filter (§14.4): 5+ identical comments by the same rater → admin alert
    if (ctx.comment) {
      const dups = await prisma.rating.count({
        where: { raterId: ctx.raterId, comment: ctx.comment },
      });
      if (dups >= SPAM_SAME_COMMENT_THRESHOLD) {
        await notifier.broadcastToAdmins('spam_review_suspected', {
          rater_id: ctx.raterId,
          rater_name: rater.name,
          comment: ctx.comment,
          occurrences: dups,
        });
      }
    }
  }

  async function recalcAverage(
    prisma: PrismaClient,
    userId: string,
  ): Promise<{ average: number | null; count: number }> {
    // Read behavioural penalty in the same path so it's applied to the recomputed
    // average. The bookings service accumulates it (users.ratingPenalty) instead
    // of writing users.rating directly, so recalcAverage must subtract it rather
    // than overwrite and erase it.
    const [rows, ratee] = await Promise.all([
      prisma.rating.findMany({
        where: { rateeId: userId },
        orderBy: { createdAt: 'desc' },
        take: RATING_SAMPLE,
        select: { score: true },
      }),
      prisma.user.findUniqueOrThrow({
        where: { id: userId },
        select: { ratingPenalty: true },
      }),
    ]);
    const penalty = ratee.ratingPenalty.toNumber();

    if (rows.length < RATING_VISIBLE_AFTER) {
      // Average stays hidden (null) until RATING_VISIBLE_AFTER ratings exist, so
      // the displayed rating column is irrelevant here — leave it untouched
      // (current semantics) and only keep ratingCount fresh for "Новый" labeling.
      // The penalty is preserved in users.ratingPenalty and folds in once the
      // average becomes visible.
      await prisma.user.update({
        where: { id: userId },
        data: { ratingCount: rows.length },
      });
      return { average: null, count: rows.length };
    }
    const avg = rows.reduce((s, r) => s + r.score, 0) / rows.length;
    // newRating = average(recent scores) − ratingPenalty, clamped to [1.0, 5.0].
    const penalized = avg - penalty;
    const clamped = Math.min(5, Math.max(1, penalized));
    const rounded = Math.round(clamped * 100) / 100;
    await prisma.user.update({
      where: { id: userId },
      data: {
        rating: new Prisma.Decimal(rounded),
        ratingCount: rows.length,
      },
    });
    return { average: rounded, count: rows.length };
  }
}
