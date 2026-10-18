import { beforeEach, describe, expect, it } from 'vitest';
import { CITY } from '../../../tests/cities.js';
import { testPrisma } from '../../../tests/setup.js';
import { recalcCancellationsJob } from './recalcCancellations.js';
import { createVerifiedDriver, createUser } from '../../../tests/factories.js';

describe('recalc_cancellations_30d cron', () => {
  beforeEach(() => {
    // setup.ts truncates between tests
  });

  async function seedTrip(driverId: string) {
    return testPrisma.trip.create({
      data: {
        driverId,
        originCity: 'Бишкек', originCityId: CITY['Бишкек'],
        destinationCity: 'Ош', destinationCityId: CITY['Ош'],
        originAddress: 'x',
        departureAt: new Date(Date.now() - 2 * 24 * 60 * 60_000),
        estimatedDurationMin: 360,
        seatsTotal: 3,
        seatsAvailable: 0,
        pricePerSeat: 800,
        status: 'completed',
      },
    });
  }

  it('counts cancelled_by_driver bookings within last 30 days', async () => {
    const d = await createVerifiedDriver(testPrisma, { plate: 'RC001' });
    const p = await createUser(testPrisma);
    const trip = await seedTrip(d.id);

    await testPrisma.booking.createMany({
      data: [
        // should count
        {
          tripId: trip.id,
          passengerId: p.id,
          seatsCount: 1,
          status: 'cancelled_by_driver',
          cancelledAt: new Date(Date.now() - 5 * 24 * 60 * 60_000),
        },
        // should count
        {
          tripId: trip.id,
          passengerId: (await createUser(testPrisma)).id,
          seatsCount: 1,
          status: 'cancelled_by_driver',
          cancelledAt: new Date(Date.now() - 20 * 24 * 60 * 60_000),
        },
        // should NOT count — wrong status
        {
          tripId: trip.id,
          passengerId: (await createUser(testPrisma)).id,
          seatsCount: 1,
          status: 'cancelled_by_passenger',
          cancelledAt: new Date(Date.now() - 3 * 24 * 60 * 60_000),
        },
        // should NOT count — older than 30 days
        {
          tripId: trip.id,
          passengerId: (await createUser(testPrisma)).id,
          seatsCount: 1,
          status: 'cancelled_by_driver',
          cancelledAt: new Date(Date.now() - 31 * 24 * 60 * 60_000),
        },
      ],
    });

    await recalcCancellationsJob.run(testPrisma);

    const dp = await testPrisma.driverProfile.findUniqueOrThrow({ where: { userId: d.id } });
    expect(dp.cancellations30d).toBe(2);
  });

  it('resets count to 0 when all past cancellations are outside 30-day window', async () => {
    const d = await createVerifiedDriver(testPrisma, { plate: 'RC002' });
    const p = await createUser(testPrisma);
    const trip = await seedTrip(d.id);

    // Seed an old cancellation, then manually set cancellations_30d to a stale value
    await testPrisma.booking.create({
      data: {
        tripId: trip.id,
        passengerId: p.id,
        seatsCount: 1,
        status: 'cancelled_by_driver',
        cancelledAt: new Date(Date.now() - 45 * 24 * 60 * 60_000),
      },
    });
    await testPrisma.driverProfile.update({
      where: { userId: d.id },
      data:  { cancellations30d: 99 }, // stale value
    });

    await recalcCancellationsJob.run(testPrisma);

    const dp = await testPrisma.driverProfile.findUniqueOrThrow({ where: { userId: d.id } });
    expect(dp.cancellations30d).toBe(0);
  });

  it('is independent per driver — does not mix counts', async () => {
    const d1 = await createVerifiedDriver(testPrisma, { plate: 'RC003' });
    const d2 = await createVerifiedDriver(testPrisma, { plate: 'RC004' });

    const trip1 = await seedTrip(d1.id);
    const trip2 = await seedTrip(d2.id);

    const p = await createUser(testPrisma);

    // d1: 3 recent cancellations
    for (let i = 0; i < 3; i++) {
      await testPrisma.booking.create({
        data: {
          tripId: trip1.id,
          passengerId: (await createUser(testPrisma)).id,
          seatsCount: 1,
          status: 'cancelled_by_driver',
          cancelledAt: new Date(Date.now() - (i + 1) * 24 * 60 * 60_000),
        },
      });
    }
    // d2: 1 recent cancellation
    await testPrisma.booking.create({
      data: {
        tripId: trip2.id,
        passengerId: p.id,
        seatsCount: 1,
        status: 'cancelled_by_driver',
        cancelledAt: new Date(Date.now() - 24 * 60 * 60_000),
      },
    });

    await recalcCancellationsJob.run(testPrisma);

    const dp1 = await testPrisma.driverProfile.findUniqueOrThrow({ where: { userId: d1.id } });
    const dp2 = await testPrisma.driverProfile.findUniqueOrThrow({ where: { userId: d2.id } });
    expect(dp1.cancellations30d).toBe(3);
    expect(dp2.cancellations30d).toBe(1);
  });

  it('is a no-op when there are no drivers', async () => {
    // Just verify it doesn't throw on empty tables
    await expect(recalcCancellationsJob.run(testPrisma)).resolves.toBeUndefined();
  });
});
