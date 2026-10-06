import type { Job } from '@/cron/scheduler.js';
import { logger } from '@/lib/logger.js';

// Likes/favourites of listings whose time has passed (or that are completed /
// cancelled / deleted) have no value — a user can't act on a past trip. This
// keeps `listing_likes` lean: once a day, drop every like whose target trip or
// passenger request is no longer live-and-upcoming (also sweeps orphaned likes
// whose target row is gone — the table is polymorphic, so there's no FK to do
// it for us). The denormalised likes_count on past/terminal listings is left
// as-is: those listings never surface in active feeds, so a stale count is
// harmless.
export const cleanupStaleLikesJob: Job = {
  name: 'cleanup_stale_likes',
  schedule: '30 3 * * *', // daily at 03:30
  maxRuntimeSec: 60,
  async run(prisma) {
    // Trip likes: keep ONLY when the trip is still active/direct AND in the
    // future. Everything else (completed, cancelled, departed, orphaned) goes.
    const trips = await prisma.$executeRaw`
      DELETE FROM listing_likes l
      WHERE l.target_type = 'trip'
        AND NOT EXISTS (
          SELECT 1 FROM trips t
          WHERE t.id = l.target_id
            AND t.status IN ('active', 'direct')
            AND t.departure_at > NOW()
        )
    `;
    // Request likes: keep ONLY when the request is still open AND upcoming.
    const requests = await prisma.$executeRaw`
      DELETE FROM listing_likes l
      WHERE l.target_type = 'passenger_request'
        AND NOT EXISTS (
          SELECT 1 FROM passenger_requests r
          WHERE r.id = l.target_id
            AND r.status = 'open'
            AND r.departure_date > NOW()
        )
    `;
    const total = trips + requests;
    if (total > 0) {
      logger.info({ trips, requests, total }, 'cleanup_stale_likes: removed stale likes');
    }
  },
};
