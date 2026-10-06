import type { Job } from '@/cron/scheduler.js';
import { logger } from '@/lib/logger.js';

// Passenger requests whose departure date has passed are no longer actionable —
// flip them from 'open' to 'expired' so they drop out of active feeds, stop
// accepting driver offers, and show the right status everywhere. Mirrors
// expire_bookings; runs every minute. (Clients also treat an open-but-past
// request as expired for display, so there's no window where it reads as «Открыта».)
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
    if (expired > 0) {
      logger.info({ count: expired }, 'expire_requests: requests expired');
    }
  },
};
