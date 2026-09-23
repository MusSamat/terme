import cron from 'node-cron';
import os from 'node:os';
import type { PrismaClient } from '@prisma/client';
import { logger } from '@/lib/logger.js';

/**
 * Cron scheduler with distributed locks, per TZ §21.1:
 *   "Для предотвращения двойного выполнения при нескольких инстансах —
 *    перед каждой задачей INSERT в таблицу cron_locks с UNIQUE ограничением."
 *
 * Pattern: take the lock with an UPSERT that only succeeds if the existing
 * row is expired. Release by deleting the row at the end. If the job
 * crashes, lockedUntil expires and the next run recovers.
 */

export interface Job {
  name: string;
  schedule: string;       // cron expression
  maxRuntimeSec: number;  // lock TTL — pick > typical runtime
  run(prisma: PrismaClient): Promise<void>;
}

const INSTANCE_ID = `${os.hostname()}#${process.pid}`;

async function acquire(prisma: PrismaClient, job: Job): Promise<boolean> {
  const now = new Date();
  const until = new Date(now.getTime() + job.maxRuntimeSec * 1000);

  // Atomic: upsert if (a) no row yet or (b) existing lock already expired.
  // Prisma has no "upsert where" clause, so we use a raw parametrised INSERT
  // ... ON CONFLICT DO UPDATE with a WHERE predicate.
  const result = await prisma.$executeRaw`
    INSERT INTO cron_locks (job_name, locked_at, locked_until, locked_by)
    VALUES (${job.name}, ${now}, ${until}, ${INSTANCE_ID})
    ON CONFLICT (job_name) DO UPDATE
      SET locked_at = EXCLUDED.locked_at,
          locked_until = EXCLUDED.locked_until,
          locked_by = EXCLUDED.locked_by
      WHERE cron_locks.locked_until < ${now}
  `;
  return result > 0;
}

async function release(prisma: PrismaClient, jobName: string): Promise<void> {
  const deleted = await prisma.$executeRaw`
    DELETE FROM cron_locks
    WHERE job_name = ${jobName} AND locked_by = ${INSTANCE_ID}
  `;
  // 0 rows deleted means our lock is gone — it expired mid-run (job overran
  // maxRuntimeSec) and another live instance stole it. Surface this: it means
  // the job likely ran concurrently on two instances.
  if (deleted === 0) {
    const holder = await prisma.cronLock
      .findUnique({ where: { jobName }, select: { lockedBy: true } })
      .catch(() => null);
    logger.warn(
      { job: jobName, currentHolder: holder?.lockedBy ?? null },
      'cron lock stolen mid-run — job overran maxRuntimeSec and was re-acquired by another instance',
    );
  }
}

const STOP_DRAIN_TIMEOUT_MS = 10_000;

export class CronScheduler {
  private tasks: cron.ScheduledTask[] = [];
  // In-flight run promises, keyed by job name. stop() awaits these so a running
  // job finishes (and releases its lock) before Prisma is disconnected.
  private inFlight = new Map<string, Promise<void>>();

  constructor(private readonly prisma: PrismaClient) {}

  register(job: Job): void {
    const task = cron.schedule(
      job.schedule,
      () => {
        // Skip overlapping ticks for the same job (a slow run shouldn't stack).
        if (this.inFlight.has(job.name)) {
          logger.debug({ job: job.name }, 'cron skipped — previous run still in flight');
          return;
        }
        const run = this.runOnce(job).finally(() => this.inFlight.delete(job.name));
        this.inFlight.set(job.name, run);
        void run;
      },
      { scheduled: false },
    );
    this.tasks.push(task);
    logger.debug({ job: job.name, schedule: job.schedule }, 'cron registered');
  }

  private async runOnce(job: Job): Promise<void> {
    const acquired = await acquire(this.prisma, job).catch((err) => {
      logger.error({ err, job: job.name }, 'cron lock error');
      return false;
    });
    if (!acquired) {
      logger.debug({ job: job.name }, 'cron skipped — another instance holds lock');
      return;
    }
    const start = Date.now();
    try {
      await job.run(this.prisma);
      logger.info({ job: job.name, duration_ms: Date.now() - start }, 'cron job done');
    } catch (err) {
      logger.error({ err, job: job.name }, 'cron job failed');
    } finally {
      await release(this.prisma, job.name).catch((err) =>
        logger.error({ err, job: job.name }, 'cron release error'),
      );
    }
  }

  start(): void {
    this.tasks.forEach((t) => t.start());
    logger.info({ count: this.tasks.length }, 'cron scheduler started');
  }

  async stop(): Promise<void> {
    // Stop scheduling new ticks first, then drain any in-flight run (bounded)
    // so shutdown doesn't disconnect Prisma out from under a running job.
    await Promise.all(this.tasks.map((t) => t.stop()));
    const running = [...this.inFlight.values()];
    if (running.length > 0) {
      logger.info({ count: running.length }, 'cron scheduler waiting for in-flight jobs');
      const drain = Promise.allSettled(running);
      const timeout = new Promise<void>((resolve) => {
        const t = setTimeout(() => {
          logger.warn('cron drain timeout — proceeding with shutdown');
          resolve();
        }, STOP_DRAIN_TIMEOUT_MS);
        t.unref();
      });
      await Promise.race([drain, timeout]);
    }
    logger.info('cron scheduler stopped');
  }
}
