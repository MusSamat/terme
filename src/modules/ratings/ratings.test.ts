import { beforeEach, describe, expect, it } from 'vitest';
import { CITY } from '../../../tests/cities.js';
import request from 'supertest';
import type { Express } from 'express';
import { testPrisma } from '../../../tests/setup.js';
import { createApp } from '@/server.js';
import {
  createUser,
  createVerifiedDriver,
  seedLaunchCities,
} from '../../../tests/factories.js';
import { NoopNotifier } from '@/lib/notifier.js';

let app: Express;
let notifier: NoopNotifier;

beforeEach(async () => {
  notifier = new NoopNotifier();
  app = createApp(testPrisma, notifier);
  await seedLaunchCities(testPrisma);
});

async function completedTripWithPassenger(): Promise<{
  driver: Awaited<ReturnType<typeof createVerifiedDriver>>;
  passenger: Awaited<ReturnType<typeof createUser>>;
  tripId: string;
}> {
  const driver = await createVerifiedDriver(testPrisma, { plate: `R${Math.floor(Math.random() * 1e5)}` });
  const passenger = await createUser(testPrisma);
  // Past trip, already completed — skip the cron and wire it directly.
  const departure = new Date(Date.now() - 4 * 60 * 60_000);
  const trip = await testPrisma.trip.create({
    data: {
      driverId: driver.id,
      originCity: 'Бишкек', originCityId: CITY['Бишкек'],
      destinationCity: 'Ош', destinationCityId: CITY['Ош'],
      originAddress: 'x',
      departureAt: departure,
      estimatedDurationMin: 60,
      seatsTotal: 3,
      seatsAvailable: 2,
      pricePerSeat: 800,
      luggage: 'no',
      status: 'completed',
    },
  });
  await testPrisma.booking.create({
    data: {
      tripId: trip.id,
      passengerId: passenger.id,
      seatsCount: 1,
      status: 'completed',
    },
  });
  return { driver, passenger, tripId: trip.id };
}

describe('POST /v1/ratings', () => {
  it('passenger rates driver successfully, notifier emits rating_received', async () => {
    const ctx = await completedTripWithPassenger();
    const res = await request(app)
      .post('/v1/ratings')
      .set('Authorization', `Bearer ${ctx.passenger.accessToken}`)
      .send({
        tripId: ctx.tripId,
        rateeId: ctx.driver.id,
        score: 5,
        tags: ['on_time', 'clean_car'],
        comment: 'Отличный водитель!',
      });
    expect(res.status).toBe(201);

    const count = await testPrisma.rating.count();
    expect(count).toBe(1);

    expect(notifier.findForUser(ctx.driver.id, 'rating_received')).toHaveLength(1);
  });

  it('rejects self-rating', async () => {
    const ctx = await completedTripWithPassenger();
    const res = await request(app)
      .post('/v1/ratings')
      .set('Authorization', `Bearer ${ctx.driver.accessToken}`)
      .send({ tripId: ctx.tripId, rateeId: ctx.driver.id, score: 5 });
    expect(res.status).toBe(400);
  });

  it('rejects rating on non-completed trip', async () => {
    const d = await createVerifiedDriver(testPrisma, { plate: 'RT1' });
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
    const p = await createUser(testPrisma);
    const res = await request(app)
      .post('/v1/ratings')
      .set('Authorization', `Bearer ${p.accessToken}`)
      .send({ tripId: trip.id, rateeId: d.id, score: 5 });
    expect(res.status).toBe(409);
  });

  it('rejects rating outside 7-day window', async () => {
    const d = await createVerifiedDriver(testPrisma, { plate: 'RT2' });
    const p = await createUser(testPrisma);
    const long = new Date(Date.now() - 10 * 24 * 60 * 60_000);
    const trip = await testPrisma.trip.create({
      data: {
        driverId: d.id,
        originCity: 'Бишкек', originCityId: CITY['Бишкек'],
        destinationCity: 'Ош', destinationCityId: CITY['Ош'],
        originAddress: 'x',
        departureAt: long,
        estimatedDurationMin: 60,
        seatsTotal: 3,
        seatsAvailable: 2,
        pricePerSeat: 800,
        luggage: 'no',
        status: 'completed',
      },
    });
    await testPrisma.booking.create({
      data: { tripId: trip.id, passengerId: p.id, seatsCount: 1, status: 'completed' },
    });
    const res = await request(app)
      .post('/v1/ratings')
      .set('Authorization', `Bearer ${p.accessToken}`)
      .send({ tripId: trip.id, rateeId: d.id, score: 4 });
    expect(res.status).toBe(409);
    expect(res.body.error.details.reason).toBe('rating_window_closed');
  });

  it('rejects duplicate rating from same rater→ratee', async () => {
    const ctx = await completedTripWithPassenger();
    await request(app)
      .post('/v1/ratings')
      .set('Authorization', `Bearer ${ctx.passenger.accessToken}`)
      .send({ tripId: ctx.tripId, rateeId: ctx.driver.id, score: 5 });
    const res = await request(app)
      .post('/v1/ratings')
      .set('Authorization', `Bearer ${ctx.passenger.accessToken}`)
      .send({ tripId: ctx.tripId, rateeId: ctx.driver.id, score: 3 });
    expect(res.status).toBe(409);
    expect(res.body.error.details.reason).toBe('already_rated');
  });

  it('rejects unknown tag', async () => {
    const ctx = await completedTripWithPassenger();
    const res = await request(app)
      .post('/v1/ratings')
      .set('Authorization', `Bearer ${ctx.passenger.accessToken}`)
      .send({
        tripId: ctx.tripId,
        rateeId: ctx.driver.id,
        score: 5,
        tags: ['made_up_tag'],
      });
    expect(res.status).toBe(400);
  });

  it('stranger cannot rate', async () => {
    const ctx = await completedTripWithPassenger();
    const stranger = await createUser(testPrisma);
    const res = await request(app)
      .post('/v1/ratings')
      .set('Authorization', `Bearer ${stranger.accessToken}`)
      .send({ tripId: ctx.tripId, rateeId: ctx.driver.id, score: 5 });
    expect(res.status).toBe(403);
  });
});

describe('Rating aggregation thresholds', () => {
  async function seedRatings(
    rateeId: string,
    scores: number[],
    daysAgo = 0,
  ): Promise<void> {
    for (const s of scores) {
      const raterId = (
        await testPrisma.user.create({
          data: { phone: `+996700${Math.floor(Math.random() * 900_000 + 100_000)}`, name: 'r' },
        })
      ).id;
      await testPrisma.rating.create({
        data: {
          // Fake tripId — we're bypassing the service's full validation here
          // by directly testing the aggregator via a subsequent real rating.
          tripId: (
            await testPrisma.trip.create({
              data: {
                driverId: rateeId,
                originCity: 'Бишкек', originCityId: CITY['Бишкек'],
                destinationCity: 'Ош', destinationCityId: CITY['Ош'],
                originAddress: 'x',
                departureAt: new Date(Date.now() - (daysAgo + 1) * 24 * 60 * 60_000),
                estimatedDurationMin: 60,
                seatsTotal: 3,
                seatsAvailable: 0,
                pricePerSeat: 800,
                luggage: 'no',
                status: 'completed',
              },
            })
          ).id,
          raterId,
          rateeId,
          score: s,
        },
      });
    }
  }

  it('rating < 4.0 emits rating_warning', async () => {
    // Seed driver with 5 low ratings already, then post a fresh one via the
    // service (which computes the aggregate).
    const ctx = await completedTripWithPassenger();
    await seedRatings(ctx.driver.id, [3, 3, 3, 3, 3]);
    // Fresh rating to trigger the aggregator (also not on the same seeded trips):
    await request(app)
      .post('/v1/ratings')
      .set('Authorization', `Bearer ${ctx.passenger.accessToken}`)
      .send({ tripId: ctx.tripId, rateeId: ctx.driver.id, score: 3 });
    expect(notifier.findForUser(ctx.driver.id, 'rating_warning').length).toBeGreaterThan(0);
  });

  it('rating < 3.0 suspends a driver', async () => {
    const ctx = await completedTripWithPassenger();
    await seedRatings(ctx.driver.id, [1, 1, 1, 1, 2]); // avg=1.2
    await request(app)
      .post('/v1/ratings')
      .set('Authorization', `Bearer ${ctx.passenger.accessToken}`)
      .send({ tripId: ctx.tripId, rateeId: ctx.driver.id, score: 2 });

    const dp = await testPrisma.driverProfile.findUniqueOrThrow({ where: { userId: ctx.driver.id } });
    expect(dp.verificationStatus).toBe('suspended');
  });

  it('rating < 3.5 broadcasts low_rating_review to admins', async () => {
    const ctx = await completedTripWithPassenger();
    await seedRatings(ctx.driver.id, [3, 3, 3, 4, 3]); // avg ~3.2
    await request(app)
      .post('/v1/ratings')
      .set('Authorization', `Bearer ${ctx.passenger.accessToken}`)
      .send({ tripId: ctx.tripId, rateeId: ctx.driver.id, score: 3 });

    const admins = notifier.findForUser('__admins__', 'low_rating_review');
    expect(admins.length).toBeGreaterThan(0);
  });
});

describe('GET /v1/ratings/pending', () => {
  it('lists completed trips the caller still needs to rate', async () => {
    const ctx = await completedTripWithPassenger();
    const res = await request(app)
      .get('/v1/ratings/pending')
      .set('Authorization', `Bearer ${ctx.passenger.accessToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].counterpartId).toBe(ctx.driver.id);
    expect(res.body.data[0].direction).toBe('driver');

    // After rating, it disappears.
    await request(app)
      .post('/v1/ratings')
      .set('Authorization', `Bearer ${ctx.passenger.accessToken}`)
      .send({ tripId: ctx.tripId, rateeId: ctx.driver.id, score: 5 });
    const after = await request(app)
      .get('/v1/ratings/pending')
      .set('Authorization', `Bearer ${ctx.passenger.accessToken}`);
    expect(after.body.data).toHaveLength(0);
  });
});
