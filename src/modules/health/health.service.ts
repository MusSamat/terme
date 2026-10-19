import type { PrismaClient } from '@prisma/client';

export function createHealthService(prisma: PrismaClient) {
  /** Round-trips `SELECT 1`; resolves to the latency in ms. */
  async function pingDb(): Promise<number> {
    const start = process.hrtime.bigint();
    await prisma.$queryRaw`SELECT 1`;
    return Number((process.hrtime.bigint() - start) / 1_000_000n);
  }

  return { pingDb };
}
