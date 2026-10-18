import { beforeEach, describe, it, expect } from 'vitest';
import { CITY } from './cities.js';
import request from 'supertest';
import type { Express } from 'express';
import { testPrisma } from './setup.js';
import { createApp } from '@/server.js';
import { createEngagementService } from '@/lib/engagement.js';
import { createUser, createVerifiedDriver, createTrip } from './factories.js';

let app: Express;
beforeEach(() => {
  app = createApp(testPrisma);
});

async function tripViews(id: string): Promise<number> {
  const t = await testPrisma.trip.findUniqueOrThrow({ where: { id }, select: { viewsCount: true } });
  return t.viewsCount;
}

describe('engagement service (unit)', () => {
  it('recordView counts every keyed view (early-stage inflation), skips owner & keyless', async () => {
    const driver = await createVerifiedDriver(testPrisma);
    const trip = await createTrip(testPrisma, driver.id);
    const eng = createEngagementService(testPrisma);

    await eng.recordView('trip', trip.id, { userId: driver.id, anonId: null }); // owner → skip
    await eng.recordView('trip', trip.id, { userId: null, anonId: null }); // no key → skip
    expect(await tripViews(trip.id)).toBe(0);

    const other = await createUser(testPrisma);
    await eng.recordView('trip', trip.id, { userId: null, anonId: 'anon-1' }); // anon → +1
    await eng.recordView('trip', trip.id, { userId: other.id, anonId: null }); // user → +1
    expect(await tripViews(trip.id)).toBe(2);

    // Early stage the counter inflates on EVERY view (repeat views count — only
    // the per-viewer audit row stays unique). Two more views → 4.
    await eng.recordView('trip', trip.id, { userId: null, anonId: 'anon-1' });
    await eng.recordView('trip', trip.id, { userId: other.id, anonId: null });
    expect(await tripViews(trip.id)).toBe(4);
  });

  it('like is a toggle, idempotent, and keeps likes_count consistent', async () => {
    const driver = await createVerifiedDriver(testPrisma);
    const trip = await createTrip(testPrisma, driver.id);
    const u = await createUser(testPrisma);
    const eng = createEngagementService(testPrisma);

    expect(await eng.like('trip', trip.id, u.id)).toBe(true);
    expect(await eng.like('trip', trip.id, u.id)).toBe(false); // second like = no-op
    expect(await eng.isLiked('trip', trip.id, u.id)).toBe(true);
    expect(
      (await testPrisma.trip.findUniqueOrThrow({ where: { id: trip.id }, select: { likesCount: true } })).likesCount,
    ).toBe(1);

    expect(await eng.unlike('trip', trip.id, u.id)).toBe(true);
    expect(await eng.unlike('trip', trip.id, u.id)).toBe(false); // already gone
    expect(
      (await testPrisma.trip.findUniqueOrThrow({ where: { id: trip.id }, select: { likesCount: true } })).likesCount,
    ).toBe(0);
  });
});

describe('trip engagement (HTTP)', () => {
  it('like endpoint toggles; detail shows liked for the liker and public metrics for everyone', async () => {
    const driver = await createVerifiedDriver(testPrisma);
    const trip = await createTrip(testPrisma, driver.id);
    const liker = await createUser(testPrisma);

    await request(app)
      .post(`/v1/trips/${trip.id}/like`)
      .set('Authorization', `Bearer ${liker.accessToken}`)
      .expect(200, { liked: true });

    const asLiker = await request(app)
      .get(`/v1/trips/${trip.id}`)
      .set('Authorization', `Bearer ${liker.accessToken}`)
      .expect(200);
    expect(asLiker.body.liked).toBe(true);
    expect(asLiker.body.metrics.likes).toBe(1); // metrics are public (early stage)

    const asOwner = await request(app)
      .get(`/v1/trips/${trip.id}`)
      .set('Authorization', `Bearer ${driver.accessToken}`)
      .expect(200);
    expect(asOwner.body.metrics.likes).toBe(1);
    expect(asOwner.body.liked).toBe(false);

    await request(app)
      .delete(`/v1/trips/${trip.id}/like`)
      .set('Authorization', `Bearer ${liker.accessToken}`)
      .expect(200, { liked: false });
  });

  it('POST /:id/view counts each anonymous view (early-stage inflation)', async () => {
    const driver = await createVerifiedDriver(testPrisma);
    const trip = await createTrip(testPrisma, driver.id);
    const anonId = '11111111-1111-1111-1111-111111111111';

    await request(app).post(`/v1/trips/${trip.id}/view`).send({ anonId }).expect(204);
    expect(await tripViews(trip.id)).toBe(1);

    // Same visitor again → the counter still increments (deliberate inflation);
    // only the per-viewer audit row is unique.
    await request(app).post(`/v1/trips/${trip.id}/view`).send({ anonId }).expect(204);
    expect(await tripViews(trip.id)).toBe(2);
  });

  it('GET detail no longer changes the view counter (counting is client-driven)', async () => {
    const driver = await createVerifiedDriver(testPrisma);
    const trip = await createTrip(testPrisma, driver.id);
    const viewer = await createUser(testPrisma);
    await request(app)
      .get(`/v1/trips/${trip.id}`)
      .set('Authorization', `Bearer ${viewer.accessToken}`)
      .expect(200);
    expect(await tripViews(trip.id)).toBe(0);
  });
});

describe('passenger-request engagement (HTTP, polymorphic)', () => {
  it('like toggles and owner sees likes in metrics', async () => {
    const passenger = await createUser(testPrisma);
    const pr = await testPrisma.passengerRequest.create({
      data: {
        passengerId: passenger.id,
        originCity: 'Бишкек', originCityId: CITY['Бишкек'],
        destinationCity: 'Ош', destinationCityId: CITY['Ош'],
        seatsNeeded: 1,
        departureDate: new Date(Date.now() + 24 * 60 * 60_000),
      },
    });
    const driver = await createUser(testPrisma, { roles: ['passenger', 'driver'] });

    await request(app)
      .post(`/v1/passenger-requests/${pr.id}/like`)
      .set('Authorization', `Bearer ${driver.accessToken}`)
      .expect(200, { liked: true });

    const asOwner = await request(app)
      .get(`/v1/passenger-requests/${pr.id}`)
      .set('Authorization', `Bearer ${passenger.accessToken}`)
      .expect(200);
    expect(asOwner.body.metrics.likes).toBe(1);
    expect(asOwner.body.liked).toBe(false);
  });
});

describe('self-like guard', () => {
  it('a driver cannot like/unlike their own trip (400 own_listing)', async () => {
    const driver = await createVerifiedDriver(testPrisma);
    const trip = await createTrip(testPrisma, driver.id);

    const like = await request(app)
      .post(`/v1/trips/${trip.id}/like`)
      .set('Authorization', `Bearer ${driver.accessToken}`);
    expect(like.status).toBe(400);
    expect(like.body.error.details.reason).toBe('own_listing');

    const unlike = await request(app)
      .delete(`/v1/trips/${trip.id}/like`)
      .set('Authorization', `Bearer ${driver.accessToken}`);
    expect(unlike.status).toBe(400);
    expect(unlike.body.error.details.reason).toBe('own_listing');
  });

  it('a passenger cannot like their own request (400 own_listing)', async () => {
    const passenger = await createUser(testPrisma);
    const pr = await testPrisma.passengerRequest.create({
      data: {
        passengerId: passenger.id,
        originCity: 'Бишкек', originCityId: CITY['Бишкек'],
        destinationCity: 'Ош', destinationCityId: CITY['Ош'],
        seatsNeeded: 1,
        departureDate: new Date(Date.now() + 28 * 60 * 60_000),
      },
    });

    const like = await request(app)
      .post(`/v1/passenger-requests/${pr.id}/like`)
      .set('Authorization', `Bearer ${passenger.accessToken}`);
    expect(like.status).toBe(400);
    expect(like.body.error.details.reason).toBe('own_listing');
  });
});
