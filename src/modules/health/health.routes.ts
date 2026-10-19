import { Router } from 'express';
import type { PrismaClient } from '@prisma/client';
import fs from 'node:fs/promises';
import { env } from '@/config/env.js';
import { logger } from '@/lib/logger.js';
import { createHealthService } from './health.service.js';

/**
 * TZ §27 "Health check · GET /health проверяет БД + Redis + диск"
 * MVP has no Redis — we check DB and the files dir.
 */
export function createHealthRouter(prisma: PrismaClient): Router {
  const router = Router();
  const service = createHealthService(prisma);

  router.get('/health', async (_req, res) => {
    const checks: Record<string, 'ok' | 'fail'> = {};
    let dbLatencyMs: number | null = null;
    let overallOk = true;

    // DB check
    try {
      dbLatencyMs = await service.pingDb();
      checks.db = 'ok';
    } catch (err) {
      logger.error({ err }, 'health: db check failed');
      checks.db = 'fail';
      overallOk = false;
    }

    // Files dir check (writeable)
    try {
      await fs.mkdir(env.FILES_DIR, { recursive: true });
      await fs.access(env.FILES_DIR, fs.constants.W_OK);
      checks.files = 'ok';
    } catch (err) {
      logger.error({ err }, 'health: files dir check failed');
      checks.files = 'fail';
      overallOk = false;
    }

    res.status(overallOk ? 200 : 503).json({
      status: overallOk ? 'ok' : 'degraded',
      checks,
      db_latency_ms: dbLatencyMs,
      uptime_sec: Math.floor(process.uptime()),
      version: process.env.npm_package_version ?? '0.0.0',
    });
  });

  return router;
}
