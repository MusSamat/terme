import { beforeEach, describe, expect, it } from 'vitest';
import { CITY } from '../../../tests/cities.js';
import request from 'supertest';
import type { Express } from 'express';
import { testPrisma } from '../../../tests/setup.js';
import { createApp } from '@/server.js';
import { createUser, createVerifiedDriver, seedLaunchCities } from '../../../tests/factories.js';
import { NoopNotifier } from '@/lib/notifier.js';

let app: Express;
let notifier: NoopNotifier;

beforeEach(async () => {
  notifier = new NoopNotifier();
  app = createApp(testPrisma, notifier);
  await seedLaunchCities(testPrisma);
});

async function createActiveTrip(opts: {
  driverId: string;
  seatsTotal?: number;
  seatsAvailable?: number;
  status?: string;
  when?: Date;
}): Promise<{ id: string; departureAt: Date }> {
  const departureAt = opts.when ?? new Date(Date.now() + 4 * 60 * 60_000);
  const trip = await testPrisma.trip.create({
    data: {
      driverId: opts.driverId,
      originCity: 'Бишкек', originCityId: CITY['Бишкек'],
      destinationCity: 'Ош', destinationCityId: CITY['Ош'],
      originAddress: 'x',
      departureAt,
      estimatedDurationMin: 600,
      seatsTotal: opts.seatsTotal ?? 3,
      seatsAvailable: opts.seatsAvailable ?? opts.seatsTotal ?? 3,
      pricePerSeat: 800,
      luggage: 'no',
      status: opts.status ?? 'active',
    },
  });
  return { id: trip.id, departureAt };
}

describe('POST /v1/bookings', () => {
  it('creates a pending booking and notifies the driver', async () => {
    const driver = await createVerifiedDriver(testPrisma, { plate: 'B1' });
    const trip = await createActiveTrip({ driverId: driver.id });
    const passenger = await createUser(testPrisma);

    const res = await request(app)
      .post('/v1/bookings')
      .set('Authorization', `Bearer ${passenger.accessToken}`)
      .send({ tripId: trip.id, seatsCount: 1, comment: 'Один пассажир' });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('pending');
    expect(res.body.expiresAt).not.toBeNull();

    expect(notifier.findForUser(driver.id, 'booking:new_request')).toHaveLength(1);
  });

  it('rejects booking your own trip', async () => {
    const d = await createVerifiedDriver(testPrisma, { plate: 'B2' });
    const trip = await createActiveTrip({ driverId: d.id });
    const res = await request(app)
      .post('/v1/bookings')
      .set('Authorization', `Bearer ${d.accessToken}`)
      .send({ tripId: trip.id, seatsCount: 1 });
    expect(res.status).toBe(400);
  });

  it('returns 409 SEATS_NOT_AVAILABLE when not enough seats', async () => {
    const d = await createVerifiedDriver(testPrisma, { plate: 'B3' });
    const trip = await createActiveTrip({ driverId: d.id, seatsAvailable: 1 });
    const p = await createUser(testPrisma);
    const res = await request(app)
      .post('/v1/bookings')
      .set('Authorization', `Bearer ${p.accessToken}`)
      .send({ tripId: trip.id, seatsCount: 2 });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('SEATS_NOT_AVAILABLE');
  });

  it('rejects a second booking from the same passenger on the same trip', async () => {
    const d = await createVerifiedDriver(testPrisma, { plate: 'B4' });
    const trip = await createActiveTrip({ driverId: d.id, seatsTotal: 3, seatsAvailable: 3 });
    const p = await createUser(testPrisma);
    const first = await request(app)
      .post('/v1/bookings')
      .set('Authorization', `Bearer ${p.accessToken}`)
      .send({ tripId: trip.id, seatsCount: 1 });
    expect(first.status).toBe(201);
    const second = await request(app)
      .post('/v1/bookings')
      .set('Authorization', `Bearer ${p.accessToken}`)
      .send({ tripId: trip.id, seatsCount: 1 });
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('BOOKING_ALREADY_EXISTS');
  });

  it('handles concurrent POSTs racing for the last seat (SELECT FOR UPDATE)', async () => {
    const d = await createVerifiedDriver(testPrisma, { plate: 'R1' });
    const trip = await createActiveTrip({ driverId: d.id, seatsTotal: 1, seatsAvailable: 1 });
    const p1 = await createUser(testPrisma);
    const p2 = await createUser(testPrisma);
    const p3 = await createUser(testPrisma);

    // All three racers go for the single seat at once.
    const results = await Promise.all([
      request(app)
        .post('/v1/bookings')
        .set('Authorization', `Bearer ${p1.accessToken}`)
        .send({ tripId: trip.id, seatsCount: 1 }),
      request(app)
        .post('/v1/bookings')
        .set('Authorization', `Bearer ${p2.accessToken}`)
        .send({ tripId: trip.id, seatsCount: 1 }),
      request(app)
        .post('/v1/bookings')
        .set('Authorization', `Bearer ${p3.accessToken}`)
        .send({ tripId: trip.id, seatsCount: 1 }),
    ]);
    const statuses = results.map((r) => r.status).sort();
    // All three may create pending bookings because seats_available doesn't
    // decrement until driver accepts — TZ §11.3 is about accept/rejectraces,
    // but POST /bookings also takes FOR UPDATE to read a consistent snapshot.
    // The spec allows 3 pending bookings here (each only uses 1 seat slot that
    // the driver will later allocate). The core race fix protects /accept.
    expect(statuses).toEqual([201, 201, 201]);

    const bookings = await testPrisma.booking.findMany({ where: { tripId: trip.id } });
    expect(bookings).toHaveLength(3);
    const pendingCount = bookings.filter((b) => b.status === 'pending').length;
    expect(pendingCount).toBe(3);
  });

  it('returns 404 when trip not found', async () => {
    const p = await createUser(testPrisma);
    const res = await request(app)
      .post('/v1/bookings')
      .set('Authorization', `Bearer ${p.accessToken}`)
      .send({ tripId: '00000000-0000-4000-8000-000000000000', seatsCount: 1 });
    expect(res.status).toBe(404);
  });

  it('rejects when trip is not active', async () => {
    const d = await createVerifiedDriver(testPrisma, { plate: 'B5' });
    const trip = await createActiveTrip({ driverId: d.id, status: 'cancelled' });
    const p = await createUser(testPrisma);
    const res = await request(app)
      .post('/v1/bookings')
      .set('Authorization', `Bearer ${p.accessToken}`)
      .send({ tripId: trip.id, seatsCount: 1 });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('TRIP_NOT_ACTIVE');
  });
});

describe('PATCH /v1/bookings/:id/accept', () => {
  it('accepts booking, decrements seats_available, opens chat', async () => {
    const d = await createVerifiedDriver(testPrisma, { plate: 'A1' });
    const trip = await createActiveTrip({ driverId: d.id, seatsTotal: 3, seatsAvailable: 3 });
    const p = await createUser(testPrisma);

    const createRes = await request(app)
      .post('/v1/bookings')
      .set('Authorization', `Bearer ${p.accessToken}`)
      .send({ tripId: trip.id, seatsCount: 2 });
    expect(createRes.status).toBe(201);

    const res = await request(app)
      .patch(`/v1/bookings/${createRes.body.id}/accept`)
      .set('Authorization', `Bearer ${d.accessToken}`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('accepted');

    const freshTrip = await testPrisma.trip.findUniqueOrThrow({ where: { id: trip.id } });
    expect(freshTrip.seatsAvailable).toBe(1);

    expect(notifier.findForUser(p.id, 'booking:accepted')).toHaveLength(1);
  });

  it('hides the phone until accepted and reveals it after — TZ §7.7', async () => {
    const d = await createVerifiedDriver(testPrisma, { plate: 'PH1' });
    const trip = await createActiveTrip({ driverId: d.id, seatsTotal: 3, seatsAvailable: 3 });
    const p = await createUser(testPrisma);

    const createRes = await request(app)
      .post('/v1/bookings')
      .set('Authorization', `Bearer ${p.accessToken}`)
      .send({ tripId: trip.id, seatsCount: 1 });
    expect(createRes.status).toBe(201);
    // Pending booking — the passenger must NOT see the driver's real number.
    expect(createRes.body.trip.driver.phone).toBeNull();

    await request(app)
      .patch(`/v1/bookings/${createRes.body.id}/accept`)
      .set('Authorization', `Bearer ${d.accessToken}`)
      .expect(200);

    const after = await request(app)
      .get(`/v1/bookings/${createRes.body.id}`)
      .set('Authorization', `Bearer ${p.accessToken}`);
    expect(after.status).toBe(200);
    // Accepted — full number is now revealed to both parties.
    expect(after.body.trip.driver.phone).toBe(d.phone);
  });

  it('accepting when seats are filled expires the other pending bookings', async () => {
    const d = await createVerifiedDriver(testPrisma, { plate: 'A2' });
    const trip = await createActiveTrip({ driverId: d.id, seatsTotal: 1, seatsAvailable: 1 });
    const p1 = await createUser(testPrisma);
    const p2 = await createUser(testPrisma);
    const p3 = await createUser(testPrisma);

    const b1 = await request(app)
      .post('/v1/bookings')
      .set('Authorization', `Bearer ${p1.accessToken}`)
      .send({ tripId: trip.id, seatsCount: 1 });
    await request(app)
      .post('/v1/bookings')
      .set('Authorization', `Bearer ${p2.accessToken}`)
      .send({ tripId: trip.id, seatsCount: 1 });
    await request(app)
      .post('/v1/bookings')
      .set('Authorization', `Bearer ${p3.accessToken}`)
      .send({ tripId: trip.id, seatsCount: 1 });

    const acc = await request(app)
      .patch(`/v1/bookings/${b1.body.id}/accept`)
      .set('Authorization', `Bearer ${d.accessToken}`);
    expect(acc.status).toBe(200);

    const all = await testPrisma.booking.findMany({ where: { tripId: trip.id } });
    const byStatus = all.reduce<Record<string, number>>((m, b) => {
      m[b.status] = (m[b.status] ?? 0) + 1;
      return m;
    }, {});
    expect(byStatus.accepted).toBe(1);
    expect(byStatus.expired).toBe(2);

    // Expired passengers were notified.
    expect(notifier.findForUser(p2.id, 'booking:expired')).toHaveLength(1);
    expect(notifier.findForUser(p3.id, 'booking:expired')).toHaveLength(1);
  });

  it('403 when a different driver tries to accept', async () => {
    const d1 = await createVerifiedDriver(testPrisma, { plate: 'A3' });
    const d2 = await createVerifiedDriver(testPrisma, { plate: 'A4' });
    const trip = await createActiveTrip({ driverId: d1.id });
    const p = await createUser(testPrisma);
    const b = await request(app)
      .post('/v1/bookings')
      .set('Authorization', `Bearer ${p.accessToken}`)
      .send({ tripId: trip.id, seatsCount: 1 });

    const res = await request(app)
      .patch(`/v1/bookings/${b.body.id}/accept`)
      .set('Authorization', `Bearer ${d2.accessToken}`);
    expect(res.status).toBe(403);
  });
});

describe('PATCH /v1/bookings/:id/reject', () => {
  it('rejects pending booking without touching seats', async () => {
    const d = await createVerifiedDriver(testPrisma, { plate: 'RJ1' });
    const trip = await createActiveTrip({ driverId: d.id, seatsTotal: 3, seatsAvailable: 3 });
    const p = await createUser(testPrisma);
    const b = await request(app)
      .post('/v1/bookings')
      .set('Authorization', `Bearer ${p.accessToken}`)
      .send({ tripId: trip.id, seatsCount: 2 });

    const res = await request(app)
      .patch(`/v1/bookings/${b.body.id}/reject`)
      .set('Authorization', `Bearer ${d.accessToken}`)
      .send({ reason: 'не подходит' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('rejected');

    const freshTrip = await testPrisma.trip.findUniqueOrThrow({ where: { id: trip.id } });
    expect(freshTrip.seatsAvailable).toBe(3);
    expect(notifier.findForUser(p.id, 'booking:rejected')).toHaveLength(1);
  });
});

describe('PATCH /v1/bookings/:id/cancel', () => {
  it('passenger cancels >2h before — seats return, status=cancelled_by_passenger', async () => {
    const d = await createVerifiedDriver(testPrisma, { plate: 'C1' });
    const trip = await createActiveTrip({
      driverId: d.id,
      seatsTotal: 3,
      seatsAvailable: 3,
      when: new Date(Date.now() + 5 * 60 * 60_000),
    });
    const p = await createUser(testPrisma);
    const b = await request(app)
      .post('/v1/bookings')
      .set('Authorization', `Bearer ${p.accessToken}`)
      .send({ tripId: trip.id, seatsCount: 2 });
    await request(app)
      .patch(`/v1/bookings/${b.body.id}/accept`)
      .set('Authorization', `Bearer ${d.accessToken}`);

    const res = await request(app)
      .patch(`/v1/bookings/${b.body.id}/cancel`)
      .set('Authorization', `Bearer ${p.accessToken}`)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('cancelled_by_passenger');

    const freshTrip = await testPrisma.trip.findUniqueOrThrow({ where: { id: trip.id } });
    expect(freshTrip.seatsAvailable).toBe(3);
  });

  it('passenger cancels <2h before — status=cancelled_late', async () => {
    const d = await createVerifiedDriver(testPrisma, { plate: 'C2' });
    const trip = await createActiveTrip({
      driverId: d.id,
      seatsTotal: 2,
      seatsAvailable: 2,
      when: new Date(Date.now() + 60 * 60_000),
    });
    const p = await createUser(testPrisma);
    const b = await request(app)
      .post('/v1/bookings')
      .set('Authorization', `Bearer ${p.accessToken}`)
      .send({ tripId: trip.id, seatsCount: 1 });
    await request(app)
      .patch(`/v1/bookings/${b.body.id}/accept`)
      .set('Authorization', `Bearer ${d.accessToken}`);

    const res = await request(app)
      .patch(`/v1/bookings/${b.body.id}/cancel`)
      .set('Authorization', `Bearer ${p.accessToken}`)
      .send({});
    expect(res.body.status).toBe('cancelled_late');
  });
});

describe('PATCH /v1/bookings/:id/no-show', () => {
  it('requires trip to have departed, drops passenger rating by 0.5', async () => {
    const d = await createVerifiedDriver(testPrisma, { plate: 'NS1' });
    const trip = await createActiveTrip({
      driverId: d.id,
      seatsTotal: 2,
      seatsAvailable: 2,
      when: new Date(Date.now() + 60 * 60_000),
    });
    const p = await createUser(testPrisma);
    // Seed with existing rating so the decrement is visible.
    await testPrisma.user.update({
      where: { id: p.id },
      data: { rating: 4.5, ratingCount: 10 },
    });
    const b = await request(app)
      .post('/v1/bookings')
      .set('Authorization', `Bearer ${p.accessToken}`)
      .send({ tripId: trip.id, seatsCount: 1 });
    await request(app)
      .patch(`/v1/bookings/${b.body.id}/accept`)
      .set('Authorization', `Bearer ${d.accessToken}`);

    // Trip hasn't departed yet → 409
    const tooEarly = await request(app)
      .patch(`/v1/bookings/${b.body.id}/no-show`)
      .set('Authorization', `Bearer ${d.accessToken}`);
    expect(tooEarly.status).toBe(409);

    // Back-date the trip.
    await testPrisma.trip.update({
      where: { id: trip.id },
      data: { departureAt: new Date(Date.now() - 60 * 60_000) },
    });
    const res = await request(app)
      .patch(`/v1/bookings/${b.body.id}/no-show`)
      .set('Authorization', `Bearer ${d.accessToken}`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('no_show');

    const row = await testPrisma.user.findUniqueOrThrow({ where: { id: p.id } });
    expect(Number(row.rating)).toBeCloseTo(4.0, 1);
  });
});

describe('GET /v1/bookings/my and /incoming', () => {
  it("returns only the caller's bookings (passenger)", async () => {
    const d = await createVerifiedDriver(testPrisma, { plate: 'LM1' });
    const trip = await createActiveTrip({ driverId: d.id });
    const p1 = await createUser(testPrisma);
    const p2 = await createUser(testPrisma);
    await request(app)
      .post('/v1/bookings')
      .set('Authorization', `Bearer ${p1.accessToken}`)
      .send({ tripId: trip.id, seatsCount: 1 });
    await request(app)
      .post('/v1/bookings')
      .set('Authorization', `Bearer ${p2.accessToken}`)
      .send({ tripId: trip.id, seatsCount: 1 });

    const res = await request(app)
      .get('/v1/bookings/my')
      .set('Authorization', `Bearer ${p1.accessToken}`);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].passengerId).toBe(p1.id);
  });

  it('driver sees incoming pending requests only', async () => {
    const d = await createVerifiedDriver(testPrisma, { plate: 'LM2' });
    const trip = await createActiveTrip({ driverId: d.id });
    const p = await createUser(testPrisma);
    const b = await request(app)
      .post('/v1/bookings')
      .set('Authorization', `Bearer ${p.accessToken}`)
      .send({ tripId: trip.id, seatsCount: 1 });

    const res = await request(app)
      .get('/v1/bookings/incoming')
      .set('Authorization', `Bearer ${d.accessToken}`);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].id).toBe(b.body.id);

    // After accept, no longer in incoming
    await request(app)
      .patch(`/v1/bookings/${b.body.id}/accept`)
      .set('Authorization', `Bearer ${d.accessToken}`);
    const after = await request(app)
      .get('/v1/bookings/incoming')
      .set('Authorization', `Bearer ${d.accessToken}`);
    expect(after.body.data).toHaveLength(0);
  });
});

describe('POST /v1/bookings — Idempotency-Key (replay, not 409)', () => {
  it('replays the same key as 200 with the original booking — no duplicate row', async () => {
    const d = await createVerifiedDriver(testPrisma, { plate: 'IDK1' });
    const trip = await createActiveTrip({ driverId: d.id, seatsTotal: 3, seatsAvailable: 3 });
    const p = await createUser(testPrisma);

    const first = await request(app)
      .post('/v1/bookings')
      .set('Authorization', `Bearer ${p.accessToken}`)
      .set('Idempotency-Key', 'idem-key-abc')
      .send({ tripId: trip.id, seatsCount: 1 });
    expect(first.status).toBe(201);

    const replay = await request(app)
      .post('/v1/bookings')
      .set('Authorization', `Bearer ${p.accessToken}`)
      .set('Idempotency-Key', 'idem-key-abc')
      .send({ tripId: trip.id, seatsCount: 1 });
    expect(replay.status).toBe(200); // replay, not 409
    expect(replay.body.id).toBe(first.body.id); // same booking

    expect(await testPrisma.booking.count({ where: { tripId: trip.id } })).toBe(1);
  });

  it('rejects the same key from a different user (409 idempotency_key_mismatch)', async () => {
    const d = await createVerifiedDriver(testPrisma, { plate: 'IDK2' });
    const trip = await createActiveTrip({ driverId: d.id, seatsTotal: 3, seatsAvailable: 3 });
    const p1 = await createUser(testPrisma);
    const p2 = await createUser(testPrisma);

    await request(app)
      .post('/v1/bookings')
      .set('Authorization', `Bearer ${p1.accessToken}`)
      .set('Idempotency-Key', 'shared-key')
      .send({ tripId: trip.id, seatsCount: 1 });

    const other = await request(app)
      .post('/v1/bookings')
      .set('Authorization', `Bearer ${p2.accessToken}`)
      .set('Idempotency-Key', 'shared-key')
      .send({ tripId: trip.id, seatsCount: 1 });
    expect(other.status).toBe(409);
    expect(other.body.error.details.reason).toBe('idempotency_key_mismatch');
  });
});
