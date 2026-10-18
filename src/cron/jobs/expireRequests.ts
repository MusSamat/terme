import type { Job } from '@/cron/scheduler.js';
import { logger } from '@/lib/logger.js';

// Passenger requests whose departure date has passed are no longer actionable —
// flip them from 'open' to 'expired' so they drop out of active feeds, stop
// accepting driver offers, and show the right status everywhere. Mirrors
// expire_bookings; runs every minute. (Clients also treat an open-but-past
// request as expired for display, so there's no window where it reads as «Открыта».)
// Pending driver offers past their TTL are expired here as well.
export const expireRequestsJob: Job = {
  name: 'expire_requests',
  schedule: '* * * * *',
  maxRuntimeSec: 45,
  async run(prisma) {
    const expired = await prisma.$executeRaw`
      UPDATE passenger_requests
      SET status = 'expired', updated_at = NOW()
      WHERE status = 'open' AND departure_date < NOW()
    `;
    // Driver offers past their 48h TTL (or on a request that is no longer
    // open) stop being actionable too.
    const offers = await prisma.$executeRaw`
      UPDATE passenger_request_responses r
      SET status = 'expired', updated_at = NOW()
      WHERE r.status = 'pending'
        AND (r.expires_at < NOW()
             OR EXISTS (SELECT 1 FROM passenger_requests q WHERE q.id = r.request_id AND q.status <> 'open'))
    `;
    if (expired > 0 || offers > 0) {
      logger.info({ requests: expired, offers }, 'expire_requests: expired');
    }
  },
};
