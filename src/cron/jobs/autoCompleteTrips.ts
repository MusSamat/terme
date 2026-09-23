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
  async run(prisma) {
    // INTERVAL '2 hours' added to estimated_duration (minutes). Postgres needs
    // explicit interval math; we compose it from the column.
    const closed = await prisma.$queryRaw<Array<{ id: string; driver_id: string }>>`
      UPDATE trips
      SET status = 'completed',
          completed_at = NOW(),
          updated_at = NOW(),
          version = version + 1
      WHERE status IN ('active', 'direct')
        AND departure_at + (estimated_duration_min::text || ' minutes')::interval
            + INTERVAL '2 hours' < NOW()
      RETURNING id, driver_id
    `;
    if (closed.length === 0) return;

    // Emit rating_request notifications — one per booking participant (driver
    // + each accepted passenger). TZ §15.2 trip_completed_rate.
    // We do this in a single INSERT from SELECT for efficiency.
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
