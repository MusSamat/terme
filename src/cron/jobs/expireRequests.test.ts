import { describe, expect, it } from 'vitest';
import { CITY } from '../../../tests/cities.js';
import { testPrisma } from '../../../tests/setup.js';
import { expireRequestsJob } from './expireRequests.js';
import { createUser } from '../../../tests/factories.js';

describe('expire_requests cron', () => {
  it('flips open requests past their departure date to expired, leaves the rest', async () => {
    const passenger = await createUser(testPrisma);
    const base = {
      passengerId: passenger.id,
      originCity: 'Бишкек', originCityId: CITY['Бишкек'],
      destinationCity: 'Ош', destinationCityId: CITY['Ош'],
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

  it('expires pending driver offers past their TTL or on a closed request', async () => {
    const passenger = await createUser(testPrisma);
    const driver = await createUser(testPrisma);
    const driver2 = await createUser(testPrisma);
    const req = await testPrisma.passengerRequest.create({
      data: {
        passengerId: passenger.id,
        originCity: 'Бишкек', originCityId: CITY['Бишкек'],
        destinationCity: 'Ош', destinationCityId: CITY['Ош'],
        departureDate: new Date(Date.now() + 24 * 60 * 60_000),
      },
    });
    const offer = (driverId: string, expiresAt: Date) =>
      testPrisma.passengerRequestResponse.create({
        data: { requestId: req.id, driverId, price: 900, departureTime: new Date(Date.now() + 86_400_000), expiresAt },
      });
    const old = await offer(driver.id, new Date(Date.now() - 60_000));
    const live = await offer(driver2.id, new Date(Date.now() + 60 * 60_000));

    await expireRequestsJob.run(testPrisma);
    expect((await testPrisma.passengerRequestResponse.findUnique({ where: { id: old.id } }))?.status).toBe('expired');
    expect((await testPrisma.passengerRequestResponse.findUnique({ where: { id: live.id } }))?.status).toBe('pending');

    await testPrisma.passengerRequest.update({ where: { id: req.id }, data: { status: 'cancelled' } });
    await expireRequestsJob.run(testPrisma);
    expect((await testPrisma.passengerRequestResponse.findUnique({ where: { id: live.id } }))?.status).toBe('expired');
  });

  it('is a no-op with nothing to expire', async () => {
    await expect(expireRequestsJob.run(testPrisma)).resolves.toBeUndefined();
  });
});
