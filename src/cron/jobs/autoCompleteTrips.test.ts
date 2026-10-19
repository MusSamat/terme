import { beforeEach, describe, expect, it } from 'vitest';
import { CITY } from '../../../tests/cities.js';
import { testPrisma } from '../../../tests/setup.js';
import { autoCompleteTripsJob } from './autoCompleteTrips.js';
import { createUser, createVerifiedDriver } from '../../../tests/factories.js';
import request from 'supertest';
import { createApp } from '@/server.js';

describe('auto_complete_trips cron', () => {
  beforeEach(() => {
    // setup.ts truncates between tests
  });

  it('closes trips past (departure + duration + 2h), emits rating_request to participants', async () => {
    const d = await createVerifiedDriver(testPrisma, { plate: 'AC1' });
    const p = await createUser(testPrisma);

    // Trip supposedly left 5 hours ago, estimated duration 60 min → due to close.
    const trip = await testPrisma.trip.create({
      data: {
        driverId: d.id,
        originCity: 'Бишкек', originCityId: CITY['Бишкек'],
        destinationCity: 'Токмок', destinationCityId: CITY['Токмок'],
        originAddress: 'x',
        departureAt: new Date(Date.now() - 5 * 60 * 60_000),
        estimatedDurationMin: 60,
        seatsTotal: 3,
        seatsAvailable: 2,
        pricePerSeat: 300,
        luggage: 'no',
        status: 'active',
      },
    });
    await testPrisma.booking.create({
      data: {
        tripId: trip.id,
        passengerId: p.id,
        seatsCount: 1,
        status: 'accepted',
      },
    });

    await autoCompleteTripsJob.run(testPrisma);

    const closed = await testPrisma.trip.findUniqueOrThrow({ where: { id: trip.id } });
    expect(closed.status).toBe('completed');

    const notifs = await testPrisma.notification.findMany({
      where: { type: 'trip_completed_rate' },
    });
    const recipients = new Set(notifs.map((n) => n.userId));
    expect(recipients.has(d.id)).toBe(true);
    expect(recipients.has(p.id)).toBe(true);

    const booking = await testPrisma.booking.findFirstOrThrow({ where: { tripId: trip.id } });
    expect(booking.status).toBe('completed');

    const dp = await testPrisma.driverProfile.findUniqueOrThrow({ where: { userId: d.id } });
    expect(dp.totalTrips).toBe(1);
  });

  it('is a no-op when no trip is due', async () => {
    const d = await createVerifiedDriver(testPrisma, { plate: 'AC2' });
    // Trip is too fresh to close.
    await testPrisma.trip.create({
      data: {
        driverId: d.id,
        originCity: 'Бишкек', originCityId: CITY['Бишкек'],
        destinationCity: 'Ош', destinationCityId: CITY['Ош'],
        originAddress: 'x',
        departureAt: new Date(Date.now() + 60_000),
        estimatedDurationMin: 600,
        seatsTotal: 3,
        seatsAvailable: 3,
        pricePerSeat: 800,
        luggage: 'no',
        status: 'active',
      },
    });
    await autoCompleteTripsJob.run(testPrisma);
    const count = await testPrisma.notification.count();
    expect(count).toBe(0);
  });
});

describe('loyalty farming guard (M8)', () => {
  async function emptyPastTrip(driverId: string) {
    return testPrisma.trip.create({
      data: {
        driverId,
        originCity: 'Бишкек', originCityId: CITY['Бишкек'],
        destinationCity: 'Токмок', destinationCityId: CITY['Токмок'],
        originAddress: 'x',
        departureAt: new Date(Date.now() - 5 * 60 * 60_000),
        estimatedDurationMin: 60,
        seatsTotal: 3,
        seatsAvailable: 3,
        pricePerSeat: 300,
        luggage: 'no',
        status: 'active',
      },
    });
  }

  it('auto-complete of a trip nobody rode awards no points / totalTrips', async () => {
    const d = await createVerifiedDriver(testPrisma, { plate: 'ACF1' });
    const trip = await emptyPastTrip(d.id);
    await autoCompleteTripsJob.run(testPrisma);
    expect((await testPrisma.trip.findUniqueOrThrow({ where: { id: trip.id } })).status).toBe('completed');
    const dp = await testPrisma.driverProfile.findUniqueOrThrow({ where: { userId: d.id } });
    expect(dp.totalTrips).toBe(0);
    expect(await testPrisma.loyaltyTransaction.count({ where: { userId: d.id } })).toBe(0);
  });

  it('manual complete of an empty trip awards nothing either', async () => {
    const d = await createVerifiedDriver(testPrisma, { plate: 'ACF2' });
    const trip = await emptyPastTrip(d.id);
    const res = await request(createApp(testPrisma))
      .patch(`/v1/trips/${trip.id}/complete`)
      .set('Authorization', `Bearer ${d.accessToken}`);
    expect(res.status).toBe(200);
    const user = await testPrisma.user.findUniqueOrThrow({ where: { id: d.id } });
    expect(user.loyaltyPoints).toBe(0);
    const dp = await testPrisma.driverProfile.findUniqueOrThrow({ where: { userId: d.id } });
    expect(dp.totalTrips).toBe(0);
  });
});
