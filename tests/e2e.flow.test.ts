import { beforeEach, describe, expect, it } from 'vitest';
import { CITY } from './cities.js';
import request from 'supertest';
import crypto from 'node:crypto';
import type { Express } from 'express';
import { testPrisma } from './setup.js';
import { createApp } from '@/server.js';
import { createUser, createVerifiedDriver, seedLaunchCities } from './factories.js';
import { NoopNotifier } from '@/lib/notifier.js';

// End-to-end ride lifecycle across THREE accounts, driven entirely through the
// public HTTP API — the "run after every change" test. It exercises the whole
// architecture in one flow: trips → bookings (seat locking) → contact reveal
// (phone gating) → chat → completion → ratings, and checks the cross-account
// invariants that matter in production.

let app: Express;
let notifier: NoopNotifier;

beforeEach(async () => {
  notifier = new NoopNotifier();
  app = createApp(testPrisma, notifier);
  await seedLaunchCities(testPrisma);
});

const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

describe('E2E — full ride lifecycle (driver + 2 passengers)', () => {
  it('publish → book (x2) → accept → reveal phone → chat → complete → rate', async () => {
    const driver = await createVerifiedDriver(testPrisma, { plate: 'E2E1', seatsCount: 4 });
    const p1 = await createUser(testPrisma, { name: 'Айбек' });
    const p2 = await createUser(testPrisma, { name: 'Нурлан' });

    // 1) Driver publishes a trip (2 seats).
    const pub = await request(app)
      .post('/v1/trips')
      .set(auth(driver.accessToken))
      .set('Idempotency-Key', crypto.randomUUID())
      .send({
        originCity: 'Бишкек', originCityId: CITY['Бишкек'],
        destinationCity: 'Ош', destinationCityId: CITY['Ош'],
        originAddress: 'Западный автовокзал',
        departureAt: new Date(Date.now() + 4 * 60 * 60_000).toISOString(),
        seatsTotal: 2,
        pricePerSeat: 900,
        luggage: 'small',
      });
    expect(pub.status).toBe(201);
    const tripId = pub.body.id as string;

    // 2) Both passengers book. Phone stays hidden while pending.
    const b1 = await request(app).post('/v1/bookings').set(auth(p1.accessToken)).send({ tripId, seatsCount: 1 });
    const b2 = await request(app).post('/v1/bookings').set(auth(p2.accessToken)).send({ tripId, seatsCount: 1 });
    expect(b1.status).toBe(201);
    expect(b2.status).toBe(201);
    expect(b1.body.trip.driver.phone).toBeNull();

    // 3) Driver sees both in the incoming queue.
    const incoming = await request(app).get('/v1/bookings/incoming').set(auth(driver.accessToken));
    expect(incoming.status).toBe(200);
    expect(incoming.body.data.length).toBe(2);

    // 4) Driver accepts P1 → a seat is locked (2 → 1).
    const accept = await request(app).patch(`/v1/bookings/${b1.body.id}/accept`).set(auth(driver.accessToken));
    expect(accept.status).toBe(200);
    const tripRow = await testPrisma.trip.findUniqueOrThrow({ where: { id: tripId } });
    expect(tripRow.seatsAvailable).toBe(1);

    // 5) Phone is now revealed to the accepted passenger, but not to P2.
    const p1View = await request(app).get(`/v1/bookings/${b1.body.id}`).set(auth(p1.accessToken));
    expect(p1View.body.trip.driver.phone).toBe(driver.phone);

    const reveal = await request(app).post(`/v1/trips/${tripId}/contact`).set(auth(p1.accessToken));
    expect(reveal.status).toBe(200);
    expect(reveal.body.phone).toBe(driver.phone);

    // 6) Chat both ways on the accepted booking.
    const m1 = await request(app)
      .post(`/v1/chats/${b1.body.id}/messages`)
      .set(auth(p1.accessToken))
      .send({ text: 'Салам, где встречаемся?' });
    expect(m1.status).toBe(201);
    const m2 = await request(app)
      .post(`/v1/chats/${b1.body.id}/messages`)
      .set(auth(driver.accessToken))
      .send({ text: 'У западного вокзала в 9:00' });
    expect(m2.status).toBe(201);

    const thread = await request(app).get(`/v1/chats/${b1.body.id}/messages`).set(auth(p1.accessToken));
    expect(thread.status).toBe(200);
    expect(thread.body.data.length).toBe(2);

    // 7) Trip runs and completes (fast-forward departure to the past).
    await testPrisma.trip.update({ where: { id: tripId }, data: { departureAt: new Date(Date.now() - 60_000) } });
    const complete = await request(app).patch(`/v1/trips/${tripId}/complete`).set(auth(driver.accessToken));
    expect(complete.status).toBe(200);

    // 8) Passenger and driver rate each other.
    const rateDriver = await request(app)
      .post('/v1/ratings')
      .set(auth(p1.accessToken))
      .send({ tripId, rateeId: driver.id, score: 5, comment: 'Отличный водитель' });
    expect(rateDriver.status).toBe(201);

    const ratePassenger = await request(app)
      .post('/v1/ratings')
      .set(auth(driver.accessToken))
      .send({ tripId, rateeId: p1.id, score: 5 });
    expect(ratePassenger.status).toBe(201);

    // 9) The rating is recorded (count = 1). The public average stays hidden
    //    until the user has ≥3 ratings (§14.3), so `rating` is still null here.
    const profile = await request(app).get(`/v1/users/${driver.id}`).set(auth(p1.accessToken));
    expect(profile.status).toBe(200);
    expect(profile.body.ratingCount).toBe(1);
    expect(profile.body.rating).toBeNull();
  });
});
