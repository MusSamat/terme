import type { PrismaClient } from '@prisma/client';
import type { Notifier } from '@/lib/notifier.js';
import { CronScheduler } from './scheduler.js';
import { cleanupExpiredOtpJob } from './jobs/cleanupOtp.js';
import { cleanupExpiredRefreshJob } from './jobs/cleanupRefreshTokens.js';
import { escalateVerificationsJob } from './jobs/escalateVerifications.js';
import { autoCompleteTripsJob } from './jobs/autoCompleteTrips.js';
import { tripReminder2hJob } from './jobs/tripReminder2h.js';
import { expireBookingsJob } from './jobs/expireBookings.js';
import { escalateComplaintsJob } from './jobs/escalateComplaints.js';
import { recalcCancellationsJob } from './jobs/recalcCancellations.js';
import { hardDeleteUsersJob } from './jobs/hardDeleteUsers.js';
import { analyticsRecalcJob } from './jobs/analyticsRecalc.js';
import { dbBackupJob } from './jobs/dbBackup.js';
import { filesBackupJob } from './jobs/filesBackup.js';

export function buildScheduler(prisma: PrismaClient, notifier?: Notifier): CronScheduler {
  const scheduler = new CronScheduler(prisma, notifier);
  scheduler.register(cleanupExpiredOtpJob);
  scheduler.register(cleanupExpiredRefreshJob);
  scheduler.register(escalateVerificationsJob);
  scheduler.register(autoCompleteTripsJob);
  scheduler.register(tripReminder2hJob);
  scheduler.register(expireBookingsJob);
  scheduler.register(escalateComplaintsJob);
  scheduler.register(recalcCancellationsJob);
  scheduler.register(hardDeleteUsersJob);
  scheduler.register(analyticsRecalcJob);
  scheduler.register(dbBackupJob);
  scheduler.register(filesBackupJob);
  return scheduler;
}

export { CronScheduler } from './scheduler.js';
export type { Job } from './scheduler.js';
