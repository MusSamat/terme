import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { testPrisma } from '../../../tests/setup.js';
import { createApp } from '@/server.js';
import { createUser, createVerifiedDriver, createTrip, seedLaunchCities } from '../../../tests/factories.js';

// Phone reveal («Позвонить») — POST /v1/trips/:id/contact and
// /v1/passenger-requests/:id/contact. Call-first (no booking needed), audited,
// and daily-limited (CONTACT_DAILY_CAP distinct people, lower for new accounts). Covers the
// happy path, self-reveal guard, not-found, and the anti-scrape rate limit.

let app: Express;

/** Older than CONTACT_NEW_ACCOUNT_DAYS with a completed trip → the full cap. */
async function makeEstablished(userId: string): Promise<void> {
  await testPrisma.user.update({
    where: { id: userId },
    data: { createdAt: new Date(Date.now() - 30 * 24 * 60 * 60_000) },
  });
  const d = await createVerifiedDriver(testPrisma, { plate: `EST${Math.floor(Math.random() * 1e6)}` });
  const t = await createTrip(testPrisma, d.id);
  await testPrisma.booking.create({
    data: { tripId: t.id, passengerId: userId, seatsCount: 1, status: 'completed' },
  });
}
beforeEach(async () => {
  app = createApp(testPrisma);
  await seedLaunchCities(testPrisma);
});

describe('POST /v1/trips/:id/contact — reveal driver phone', () => {
  it('reveals the driver phone and writes an audit row', async () => {
    const driver = await createVerifiedDriver(testPrisma, { plate: 'C1' });
    const trip = await createTrip(testPrisma, driver.id);
    const viewer = await createUser(testPrisma);

    const res = await request(app)
      .post(`/v1/trips/${trip.id}/contact`)
      .set('Authorization', `Bearer ${viewer.accessToken}`);

    expect(res.status).toBe(200);
    expect(res.body.phone).toBe(driver.phone);
    const reveals = await testPrisma.contactReveal.count({ where: { viewerId: viewer.id } });
    expect(reveals).toBe(1);
  });

  it('rejects revealing your own trip (400 own_trip)', async () => {
    const driver = await createVerifiedDriver(testPrisma, { plate: 'C2' });
    const trip = await createTrip(testPrisma, driver.id);
    const res = await request(app)
      .post(`/v1/trips/${trip.id}/contact`)
      .set('Authorization', `Bearer ${driver.accessToken}`);
    expect(res.status).toBe(400);
    expect(res.body.error.details.reason).toBe('own_trip');
  });

  it('404 for a non-existent trip', async () => {
    const viewer = await createUser(testPrisma);
    const res = await request(app)
      .post(`/v1/trips/${'0'.repeat(8)}-0000-0000-0000-000000000000/contact`)
      .set('Authorization', `Bearer ${viewer.accessToken}`);
    expect(res.status).toBe(404);
  });

  it('caps DISTINCT people per day (429 CONTACT_LIMIT); re-revealing a known one stays free', async () => {
    const driver = await createVerifiedDriver(testPrisma, { plate: 'C3' });
    const trip = await createTrip(testPrisma, driver.id);
    const viewer = await createUser(testPrisma);
    await makeEstablished(viewer.id);

    // 30 distinct people already revealed today, one of them this driver.
    const others = await Promise.all(Array.from({ length: 29 }, () => createUser(testPrisma)));
    await testPrisma.contactReveal.createMany({
      data: [driver.id, ...others.map((o) => o.id)].map((targetUserId) => ({
        viewerId: viewer.id,
        targetUserId,
        contextType: 'trip',
        contextId: trip.id,
      })),
    });
    const again = await request(app)
      .post(`/v1/trips/${trip.id}/contact`)
      .set('Authorization', `Bearer ${viewer.accessToken}`);
    expect(again.status).toBe(200);

    const driver2 = await createVerifiedDriver(testPrisma, { plate: 'C3B' });
    const trip2 = await createTrip(testPrisma, driver2.id);
    const res = await request(app)
      .post(`/v1/trips/${trip2.id}/contact`)
      .set('Authorization', `Bearer ${viewer.accessToken}`);
    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe('CONTACT_LIMIT');
    expect(res.body.error.details.reason).toBe('contact_reveal_daily_limit');
  });

  it('new accounts get the lower cap (10 distinct people)', async () => {
    const viewer = await createUser(testPrisma); // created now → "new"
    const targets = await Promise.all(Array.from({ length: 10 }, () => createUser(testPrisma)));
    const driver = await createVerifiedDriver(testPrisma, { plate: 'C3C' });
    const trip = await createTrip(testPrisma, driver.id);
    await testPrisma.contactReveal.createMany({
      data: targets.map((t) => ({
        viewerId: viewer.id,
        targetUserId: t.id,
        contextType: 'trip',
        contextId: trip.id,
      })),
    });
    const res = await request(app)
      .post(`/v1/trips/${trip.id}/contact`)
      .set('Authorization', `Bearer ${viewer.accessToken}`);
    expect(res.status).toBe(429);
    expect(res.body.error.details.limit).toBe(10);
  });

  it('parallel reveals cannot slip past the cap (advisory lock)', async () => {
    const viewer = await createUser(testPrisma);
    const drivers = await Promise.all(
      Array.from({ length: 15 }, (_, i) => createVerifiedDriver(testPrisma, { plate: `CP${i}` })),
    );
    const trips = await Promise.all(drivers.map((d) => createTrip(testPrisma, d.id)));
    const results = await Promise.all(
      trips.map((t) =>
        request(app).post(`/v1/trips/${t.id}/contact`).set('Authorization', `Bearer ${viewer.accessToken}`),
      ),
    );
    expect(results.filter((r) => r.status === 200)).toHaveLength(10);
    expect(results.filter((r) => r.status === 429)).toHaveLength(5);
  });

  it('requires authentication (401)', async () => {
    const driver = await createVerifiedDriver(testPrisma, { plate: 'C4' });
    const trip = await createTrip(testPrisma, driver.id);
    const res = await request(app).post(`/v1/trips/${trip.id}/contact`);
    expect(res.status).toBe(401);
  });
});
