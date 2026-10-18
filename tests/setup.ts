import { afterAll, beforeAll, beforeEach } from 'vitest';
import { execSync } from 'node:child_process';
import { PrismaClient } from '@prisma/client';

/**
 * Test harness:
 *   • Each test suite gets a freshly-migrated Postgres database.
 *   • Between tests, every table is TRUNCATED to guarantee isolation without
 *     paying the migration cost each time.
 *   • NODE_ENV=test → logger silent, bcrypt rounds=4.
 *
 * Requires TEST_DATABASE_URL to point at a real Postgres 16 instance
 * (see docker-compose.yml service "postgres-test" on :5433, or a local
 * "kosho_test" DB).
 */

process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'silent';
process.env.BASE_URL = 'http://localhost:3000';
process.env.RATE_LIMIT_DISABLED = 'true';
// Use `=` (not `??=`) so these always win over a developer's .env — vitest
// loads .env before setup files run, and a real bot token there would make
// test-time signatures mismatch.
process.env.JWT_ACCESS_SECRET = 'a'.repeat(64);
process.env.JWT_REFRESH_SECRET = 'b'.repeat(64);
process.env.TELEGRAM_BOT_TOKEN = 'test-bot-token-1234567890';
process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  process.env.DATABASE_URL ??
  'postgresql://kosho:kosho@localhost:5433/kosho_test?schema=public';

const prisma = new PrismaClient({
  datasources: { db: { url: process.env.DATABASE_URL } },
});

// Tables to truncate between tests. Order doesn't matter with `RESTART IDENTITY
// CASCADE`. Keep in sync with schema.prisma.
const TABLES = [
  'admin_actions',
  'cron_locks',
  'analytics_snapshots',
  'loyalty_transactions',
  'complaints',
  'notifications',
  'ratings',
  'messages',
  'passenger_request_responses',
  'passenger_requests',
  'listing_likes',
  'listing_views',
  'bookings',
  'trips',
  'refresh_tokens',
  'otp_codes',
  'driver_profiles',
  'users',
  'admins',
  'cities',
];

beforeAll(async () => {
  // Apply migrations to the test DB — idempotent, fast on already-migrated DBs.
  execSync('npx prisma migrate deploy', {
    stdio: 'inherit',
    env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL },
  });
  await prisma.$connect();
});

beforeEach(async () => {
  const q = `TRUNCATE TABLE ${TABLES.map((t) => `"${t}"`).join(', ')} RESTART IDENTITY CASCADE`;
  await prisma.$executeRawUnsafe(q);
});

afterAll(async () => {
  await prisma.$disconnect();
});

export { prisma as testPrisma };
