import { beforeEach, describe, expect, it } from 'vitest';
import { CITY } from '../../../tests/cities.js';
import { testPrisma } from '../../../tests/setup.js';
import { expireBookingsJob } from './expireBookings.js';
import { createUser, createVerifiedDriver } from '../../../tests/factories.js';

describe('expire_bookings cron', () => {
  beforeEach(() => {
    // setup.ts truncates between tests
  });

  async function seed() {
    const d = await createVerifiedDriver(testPrisma, { plate: `EX${Math.floor(Math.random() * 1e5)}` });
    const trip = await testPrisma.trip.create({
      data: {
        driverId: d.id,
        originCity: 'Бишкек', originCityId: CITY['Бишкек'],
        destinationCity: 'Ош', destinationCityId: CITY['Ош'],
        originAddress: 'x',
        departureAt: new Date(Date.now() + 4 * 60 * 60_000),
        estimatedDurationMin: 600,
        seatsTotal: 3,
        seatsAvailable: 3,
        pricePerSeat: 800,
        luggage: 'no',
        status: 'active',
      },
    });
    return { driver: d, tripId: trip.id };
  }

  it('flips pending bookings past expires_at to expired + emits notification', async () => {
    const { tripId } = await seed();
    const pStale = await createUser(testPrisma);
    const pFresh = await createUser(testPrisma);

    await testPrisma.booking.createMany({
      data: [
        {
          tripId,
          passengerId: pStale.id,
          seatsCount: 1,
          status: 'pending',
          expiresAt: new Date(Date.now() - 60_000), // past
        },
        {
          tripId,
          passengerId: pFresh.id,
          seatsCount: 1,
          status: 'pending',
          expiresAt: new Date(Date.now() + 10 * 60_000), // future
        },
      ],
    });

    await expireBookingsJob.run(testPrisma);

    const all = await testPrisma.booking.findMany({ orderBy: { expiresAt: 'asc' } });
    const statuses = Object.fromEntries(all.map((b) => [b.passengerId, b.status]));
    expect(statuses[pStale.id]).toBe('expired');
    expect(statuses[pFresh.id]).toBe('pending');

    const notifs = await testPrisma.notification.findMany({ where: { type: 'booking_expired' } });
    expect(notifs).toHaveLength(1);
    expect(notifs[0]!.userId).toBe(pStale.id);
  });

  it('is a no-op with no stale bookings', async () => {
    await expireBookingsJob.run(testPrisma);
    expect(await testPrisma.notification.count()).toBe(0);
  });
});
