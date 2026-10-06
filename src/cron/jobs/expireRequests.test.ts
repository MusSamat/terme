import { describe, expect, it } from 'vitest';
import { testPrisma } from '../../../tests/setup.js';
import { expireRequestsJob } from './expireRequests.js';
import { createUser } from '../../../tests/factories.js';

describe('expire_requests cron', () => {
  it('flips open requests past their departure date to expired, leaves the rest', async () => {
    const passenger = await createUser(testPrisma);
    const base = {
      passengerId: passenger.id,
      originCity: 'Бишкек',
      destinationCity: 'Ош',
      seatsNeeded: 1,
    };

    const stale = await testPrisma.passengerRequest.create({
      data: { ...base, departureDate: new Date(Date.now() - 60_000), status: 'open' },
    });
    const fresh = await testPrisma.passengerRequest.create({
      data: { ...base, departureDate: new Date(Date.now() + 24 * 60 * 60_000), status: 'open' },
    });
    const cancelled = await testPrisma.passengerRequest.create({
      data: { ...base, departureDate: new Date(Date.now() - 60_000), status: 'cancelled' },
    });

    await expireRequestsJob.run(testPrisma);

    const rows = await testPrisma.passengerRequest.findMany();
    const byId = Object.fromEntries(rows.map((r) => [r.id, r.status]));
    expect(byId[stale.id]).toBe('expired');
    expect(byId[fresh.id]).toBe('open');
    expect(byId[cancelled.id]).toBe('cancelled'); // untouched
  });

  it('is a no-op with nothing to expire', async () => {
    await expect(expireRequestsJob.run(testPrisma)).resolves.toBeUndefined();
  });
});
