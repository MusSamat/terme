import type { Job } from '@/cron/scheduler.js';
import { logger } from '@/lib/logger.js';
import { POINTS_PER_TRIP, awardTripCompletion } from '@/modules/loyalty/loyalty.service.js';

// TZ §10.3 auto-close: active trips where (departure + estimated_duration + 2h)
// is in the past become "completed", and both parties get a rating-request
// notification. Runs every 15 minutes (TZ §21 auto_complete_trips cron).
//
// Implemented in a single SQL pass for atomicity — the UPDATE ... RETURNING
// gives us the ids we just closed without a second query.
export const autoCompleteTripsJob: Job = {
  name: 'auto_complete_trips',
  // Every 15 minutes — we avoid "0,15,30,45 * * * *" because node-cron shows
  // nicer output with the step form; semantics are identical.
  schedule: '*/15 * * * *',
  maxRuntimeSec: 120,
  async run(prisma, notifier) {
    // INTERVAL '2 hours' added to estimated_duration (minutes). Postgres needs
    // explicit interval math; we compose it from the column.
    const closed = await prisma.$queryRaw<
      Array<{ id: string; driver_id: string; origin_city: string; destination_city: string }>
    >`
      UPDATE trips
      SET status = 'completed',
          completed_at = NOW(),
          updated_at = NOW(),
          version = version + 1
      WHERE status IN ('active', 'direct')
        AND departure_at + (estimated_duration_min::text || ' minutes')::interval
            + INTERVAL '2 hours' < NOW()
      RETURNING id, driver_id, origin_city, destination_city
    `;
    if (closed.length === 0) return;

    // Rating-request notifications (TZ §15.2 trip_completed_rate). With a
    // notifier we go through it per participant — that persists the row AND
    // delivers live (socket + telegram), same as manual complete(). Without
    // one (tests / standalone runs) fall back to the silent batch INSERT.
    if (!notifier) {
      await prisma.$executeRaw`
        INSERT INTO notifications (id, user_id, type, channel, payload, created_at)
        SELECT gen_random_uuid(), u.user_id, 'trip_completed_rate', 'telegram',
               jsonb_build_object('trip_id', t.id, 'origin_city', t.origin_city,
                                  'destination_city', t.destination_city),
               NOW()
        FROM trips t
        JOIN LATERAL (
          SELECT t.driver_id AS user_id
          UNION
          SELECT b.passenger_id AS user_id FROM bookings b
            WHERE b.trip_id = t.id AND b.status = 'accepted'
        ) u ON TRUE
        WHERE t.id = ANY(${closed.map((c) => c.id)}::uuid[])
      `;
    } else {
      for (const trip of closed) {
        const users = await prisma.$queryRaw<Array<{ user_id: string }>>`
          SELECT ${trip.driver_id}::uuid AS user_id
          UNION
          SELECT passenger_id AS user_id FROM bookings
            WHERE trip_id = ${trip.id}::uuid AND status = 'accepted'
        `;
        const payload = {
          trip_id: trip.id,
          origin_city: trip.origin_city,
          destination_city: trip.destination_city,
        };
        for (const { user_id } of users) {
          // Fire-and-forget per user: one dead Telegram chat must not stall
          // or fail the whole cron pass.
          void notifier
            .tripCompletedRate(user_id, payload)
            .catch((err) => logger.warn({ err, user_id }, 'auto_complete: notify failed'));
        }
      }
    }

    // Flip all still-accepted bookings to completed so passengers can rate.
    await prisma.booking.updateMany({
      where: { tripId: { in: closed.map((c) => c.id) }, status: 'accepted' },
      data: { status: 'completed' },
    });

    // Award loyalty points (and bump driver totalTrips) for all participants.
    // Each trip's awards run in one transaction so a crash can't half-apply.
    // awardTripCompletion is idempotent via the (userId, tripId, source) UNIQUE,
    // so a re-run or a race with manual complete() never double-awards.
    for (const { id: tripId, driver_id } of closed) {
      // Collect all participants: driver + accepted passengers.
      const participants = await prisma.$queryRaw<Array<{ user_id: string }>>`
        SELECT ${driver_id}::uuid AS user_id
        UNION
        SELECT passenger_id AS user_id FROM bookings
          WHERE trip_id = ${tripId}::uuid AND status = 'completed'
      `;

      await prisma.$transaction(async (tx) => {
        for (const { user_id } of participants) {
          await awardTripCompletion(tx, user_id, tripId, POINTS_PER_TRIP);
          // Notifier is not wired into cron jobs — tier changes surface on the
          // next GET /loyalty/status.
        }
      });
    }

    logger.info({ count: closed.length }, 'auto_complete_trips: closed trips');
  },
};
