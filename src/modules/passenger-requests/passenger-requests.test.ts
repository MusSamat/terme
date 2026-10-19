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

// ─── Helpers ──────────────────────────────────────────────────────────────────

const tomorrow = () => new Date(Date.now() + 26 * 60 * 60_000).toISOString();
const dayAfter  = () => new Date(Date.now() + 50 * 60 * 60_000).toISOString();

const validBody = () => ({
  originCity:      'Бишкек', originCityId: CITY['Бишкек'],
  destinationCity: 'Ош', destinationCityId: CITY['Ош'],
  seatsNeeded:     1,
  departureDate:   tomorrow(),
  flexible:        false,
});

async function createRequest(passenger: { accessToken: string }, overrides: object = {}) {
  return request(app)
    .post('/v1/passenger-requests')
    .set('Authorization', `Bearer ${passenger.accessToken}`)
    .send({ ...validBody(), ...overrides });
}

// ─── POST /v1/passenger-requests ─────────────────────────────────────────────

describe('POST /v1/passenger-requests', () => {
  it('creates a request and returns 201 with DTO', async () => {
    const p = await createUser(testPrisma);
    const res = await createRequest(p);

    expect(res.status).toBe(201);
    expect(res.body.status).toBe('open');
    expect(res.body.originCity).toBe('Бишкек');
    expect(res.body.passenger.id).toBe(p.id);
    expect(await testPrisma.passengerRequest.count()).toBe(1);
  });

  it('enforces one open request per route per day (reverse route allowed)', async () => {
    const p = await createUser(testPrisma);
    const first = await createRequest(p);
    expect(first.status).toBe(201);

    // Same route, same KG day -> duplicate.
    const dup = await createRequest(p);
    expect(dup.status).toBe(409);
    expect(dup.body.error.details.reason).toBe('duplicate_route_day');

    // Reverse route (A->B vs B->A) on the same day is a different route -> OK.
    const reverse = await createRequest(p, { originCity: 'Ош', originCityId: CITY['Ош'], destinationCity: 'Бишкек', destinationCityId: CITY['Бишкек'] });
    expect(reverse.status).toBe(201);

    // Same route on another day -> OK.
    const otherDay = await createRequest(p, { departureDate: dayAfter() });
    expect(otherDay.status).toBe(201);
  });

  it('401 without token', async () => {
    const res = await request(app)
      .post('/v1/passenger-requests')
      .send(validBody());
    expect(res.status).toBe(401);
  });

  it('400 when departure is in the past', async () => {
    const p = await createUser(testPrisma);
    const res = await createRequest(p, { departureDate: new Date(Date.now() - 60_000).toISOString() });
    expect(res.status).toBe(400);
  });

  it('400 when departure is more than 60 days ahead', async () => {
    const p = await createUser(testPrisma);
    const far = new Date(Date.now() + 61 * 24 * 60 * 60_000).toISOString();
    const res = await createRequest(p, { departureDate: far });
    expect(res.status).toBe(400);
  });

  it('400 for unknown origin city', async () => {
    const p = await createUser(testPrisma);
    const res = await createRequest(p, { originCity: 'НеизвестныйГород', originCityId: 999999 });
    expect(res.status).toBe(400);
  });

  it('400 for unknown destination city', async () => {
    const p = await createUser(testPrisma);
    const res = await createRequest(p, { destinationCity: 'НеизвестныйГород', destinationCityId: 999999 });
    expect(res.status).toBe(400);
  });

  it('stores optional comment and flexible flag', async () => {
    const p = await createUser(testPrisma);
    const res = await createRequest(p, { comment: 'Буду с велосипедом', flexible: true });
    expect(res.status).toBe(201);
    expect(res.body.comment).toBe('Буду с велосипедом');
    expect(res.body.flexible).toBe(true);
  });
});

// ─── GET /v1/passenger-requests (public list) ─────────────────────────────────

describe('GET /v1/passenger-requests', () => {
  it('returns open requests ordered by departure asc', async () => {
    const p = await createUser(testPrisma);
    await createRequest(p, { departureDate: dayAfter() });
    await createRequest(p, { departureDate: tomorrow() });

    const res = await request(app).get('/v1/passenger-requests');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
    expect(new Date(res.body.data[0].departureDate) <= new Date(res.body.data[1].departureDate)).toBe(true);
  });

  it('filters by from_city', async () => {
    const p = await createUser(testPrisma);
    await createRequest(p);                                             // Бишкек → Ош
    await createRequest(p, { originCity: 'Ош', originCityId: CITY['Ош'], destinationCity: 'Каракол', destinationCityId: CITY['Каракол'] });

    const res = await request(app).get('/v1/passenger-requests?from_city=Ош');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].originCity).toBe('Ош');
  });

  it('filters by to_city', async () => {
    const p = await createUser(testPrisma);
    await createRequest(p);                                             // → Ош
    await createRequest(p, { originCity: 'Ош', originCityId: CITY['Ош'], destinationCity: 'Каракол', destinationCityId: CITY['Каракол'] });

    const res = await request(app).get('/v1/passenger-requests?to_city=Каракол');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].destinationCity).toBe('Каракол');
  });

  it('filters by minimum seats', async () => {
    const p = await createUser(testPrisma);
    await createRequest(p, { seatsNeeded: 1 });
    // One open request per route/day is enforced — put the 2nd on another day.
    await createRequest(p, { seatsNeeded: 3, departureDate: dayAfter() });

    const res = await request(app).get('/v1/passenger-requests?seats=2');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].seatsNeeded).toBe(3);
  });

  it('excludes closed and cancelled requests', async () => {
    const p = await createUser(testPrisma);
    const created = await createRequest(p);
    // Close via cancel
    await request(app)
      .delete(`/v1/passenger-requests/${created.body.id}`)
      .set('Authorization', `Bearer ${p.accessToken}`);

    const res = await request(app).get('/v1/passenger-requests');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(0);
  });

  it('paginates with cursor', async () => {
    // One open request per passenger per route/day — use distinct passengers so
    // all three coexist on the same route.
    for (let i = 0; i < 3; i++) {
      const pi = await createUser(testPrisma);
      await createRequest(pi, { departureDate: new Date(Date.now() + (26 + i) * 60 * 60_000).toISOString() });
    }

    const first = await request(app).get('/v1/passenger-requests?limit=2');
    expect(first.body.data).toHaveLength(2);
    expect(first.body.nextCursor).not.toBeNull();

    const second = await request(app).get(`/v1/passenger-requests?limit=2&cursor=${first.body.nextCursor}`);
    expect(second.body.data).toHaveLength(1);
    expect(second.body.nextCursor).toBeNull();
  });

  it('hides passenger rating until 3 ratings exist', async () => {
    const p = await createUser(testPrisma);
    await createRequest(p);

    const res = await request(app).get('/v1/passenger-requests');
    expect(res.body.data[0].passenger.rating).toBeNull();
    expect(res.body.data[0].passenger.ratingCount).toBe(0);
  });
});

// ─── GET /v1/passenger-requests/my ────────────────────────────────────────────

describe('GET /v1/passenger-requests/my', () => {
  it('401 without token', async () => {
    const res = await request(app).get('/v1/passenger-requests/my');
    expect(res.status).toBe(401);
  });

  it('returns only the caller\'s requests (all statuses)', async () => {
    const p1 = await createUser(testPrisma);
    const p2 = await createUser(testPrisma);
    const created = await createRequest(p1);
    await createRequest(p2);

    // Cancel p1's request → status = cancelled
    await request(app)
      .delete(`/v1/passenger-requests/${created.body.id}`)
      .set('Authorization', `Bearer ${p1.accessToken}`);

    const res = await request(app)
      .get('/v1/passenger-requests/my')
      .set('Authorization', `Bearer ${p1.accessToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].status).toBe('cancelled');
  });
});

// ─── GET /v1/passenger-requests/:id ───────────────────────────────────────────

describe('GET /v1/passenger-requests/:id', () => {
  it('returns the request DTO', async () => {
    const p = await createUser(testPrisma);
    const created = await createRequest(p);

    const res = await request(app).get(`/v1/passenger-requests/${created.body.id}`);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(created.body.id);
  });

  it('404 for unknown id', async () => {
    const res = await request(app).get('/v1/passenger-requests/00000000-0000-0000-0000-000000000000');
    expect(res.status).toBe(404);
  });
});

// ─── DELETE /v1/passenger-requests/:id ───────────────────────────────────────

describe('DELETE /v1/passenger-requests/:id', () => {
  it('passenger cancels own open request → 204', async () => {
    const p = await createUser(testPrisma);
    const created = await createRequest(p);

    const res = await request(app)
      .delete(`/v1/passenger-requests/${created.body.id}`)
      .set('Authorization', `Bearer ${p.accessToken}`);
    expect(res.status).toBe(204);

    const row = await testPrisma.passengerRequest.findUniqueOrThrow({ where: { id: created.body.id } });
    expect(row.status).toBe('cancelled');
  });

  it('401 without token', async () => {
    const p = await createUser(testPrisma);
    const created = await createRequest(p);
    const res = await request(app).delete(`/v1/passenger-requests/${created.body.id}`);
    expect(res.status).toBe(401);
  });

  it('403 when another user tries to cancel', async () => {
    const p1 = await createUser(testPrisma);
    const p2 = await createUser(testPrisma);
    const created = await createRequest(p1);

    const res = await request(app)
      .delete(`/v1/passenger-requests/${created.body.id}`)
      .set('Authorization', `Bearer ${p2.accessToken}`);
    expect(res.status).toBe(403);
  });

  it('409 when request is already cancelled', async () => {
    const p = await createUser(testPrisma);
    const created = await createRequest(p);

    await request(app)
      .delete(`/v1/passenger-requests/${created.body.id}`)
      .set('Authorization', `Bearer ${p.accessToken}`);

    const res = await request(app)
      .delete(`/v1/passenger-requests/${created.body.id}`)
      .set('Authorization', `Bearer ${p.accessToken}`);
    expect(res.status).toBe(409);
  });

  it('404 for unknown request', async () => {
    const p = await createUser(testPrisma);
    const res = await request(app)
      .delete('/v1/passenger-requests/00000000-0000-0000-0000-000000000000')
      .set('Authorization', `Bearer ${p.accessToken}`);
    expect(res.status).toBe(404);
  });
});

// ─── POST /v1/passenger-requests/:id/respond ─────────────────────────────────

describe('POST /v1/passenger-requests/:id/respond', () => {
  const respondBody = () => ({
    price:         1200,
    departureTime: new Date(Date.now() + 28 * 60 * 60_000).toISOString(),
    message:       'Буду у автовокзала',
  });

  it('driver responds → 201, notifier fires requestResponseReceived', async () => {
    const p = await createUser(testPrisma);
    const d = await createVerifiedDriver(testPrisma, { plate: 'R001' });
    const created = await createRequest(p);

    const res = await request(app)
      .post(`/v1/passenger-requests/${created.body.id}/respond`)
      .set('Authorization', `Bearer ${d.accessToken}`)
      .send(respondBody());

    expect(res.status).toBe(201);
    expect(res.body.driverId).toBe(d.id);
    expect(res.body.price).toBe(1200);
    expect(res.body.status).toBe('pending');
    expect(notifier.findForUser(p.id, 'request:response_received')).toHaveLength(1);
  });

  it('401 without token', async () => {
    const p = await createUser(testPrisma);
    const created = await createRequest(p);
    const res = await request(app)
      .post(`/v1/passenger-requests/${created.body.id}/respond`)
      .send(respondBody());
    expect(res.status).toBe(401);
  });

  it('400 when driver responds to their own request', async () => {
    const p = await createUser(testPrisma);
    const created = await createRequest(p);

    const res = await request(app)
      .post(`/v1/passenger-requests/${created.body.id}/respond`)
      .set('Authorization', `Bearer ${p.accessToken}`)
      .send(respondBody());
    expect(res.status).toBe(400);
  });

  it('404 for unknown request id', async () => {
    const d = await createVerifiedDriver(testPrisma, { plate: 'R002' });
    const res = await request(app)
      .post('/v1/passenger-requests/00000000-0000-0000-0000-000000000000/respond')
      .set('Authorization', `Bearer ${d.accessToken}`)
      .send(respondBody());
    expect(res.status).toBe(404);
  });

  it('409 when request is closed', async () => {
    const p = await createUser(testPrisma);
    const d = await createVerifiedDriver(testPrisma, { plate: 'R003' });
    const created = await createRequest(p);

    await request(app)
      .delete(`/v1/passenger-requests/${created.body.id}`)
      .set('Authorization', `Bearer ${p.accessToken}`);

    const res = await request(app)
      .post(`/v1/passenger-requests/${created.body.id}/respond`)
      .set('Authorization', `Bearer ${d.accessToken}`)
      .send(respondBody());
    expect(res.status).toBe(409);
  });

  it('400 when departure time is in the past', async () => {
    const p = await createUser(testPrisma);
    const d = await createVerifiedDriver(testPrisma, { plate: 'R004' });
    const created = await createRequest(p);

    const res = await request(app)
      .post(`/v1/passenger-requests/${created.body.id}/respond`)
      .set('Authorization', `Bearer ${d.accessToken}`)
      .send({ ...respondBody(), departureTime: new Date(Date.now() - 60_000).toISOString() });
    expect(res.status).toBe(400);
  });

  it('409 when driver already has a pending response on the same request', async () => {
    const p = await createUser(testPrisma);
    const d = await createVerifiedDriver(testPrisma, { plate: 'R005' });
    const created = await createRequest(p);

    await request(app)
      .post(`/v1/passenger-requests/${created.body.id}/respond`)
      .set('Authorization', `Bearer ${d.accessToken}`)
      .send(respondBody());

    const res = await request(app)
      .post(`/v1/passenger-requests/${created.body.id}/respond`)
      .set('Authorization', `Bearer ${d.accessToken}`)
      .send(respondBody());
    expect(res.status).toBe(409);
  });

  it('driver can re-respond after their previous response was declined', async () => {
    const p = await createUser(testPrisma);
    const d = await createVerifiedDriver(testPrisma, { plate: 'R006' });
    const created = await createRequest(p);

    const firstResp = await request(app)
      .post(`/v1/passenger-requests/${created.body.id}/respond`)
      .set('Authorization', `Bearer ${d.accessToken}`)
      .send(respondBody());
    expect(firstResp.status).toBe(201);

    // Passenger declines
    await request(app)
      .post(`/v1/passenger-requests/${created.body.id}/respond/${firstResp.body.id}/decline`)
      .set('Authorization', `Bearer ${p.accessToken}`);

    // Driver re-responds with updated price
    const secondResp = await request(app)
      .post(`/v1/passenger-requests/${created.body.id}/respond`)
      .set('Authorization', `Bearer ${d.accessToken}`)
      .send({ ...respondBody(), price: 1000 });
    expect(secondResp.status).toBe(201);
    expect(secondResp.body.price).toBe(1000);
    // Still one row (updated), not two
    expect(await testPrisma.passengerRequestResponse.count()).toBe(1);
  });
});

// ─── GET /v1/passenger-requests/:id/responses ────────────────────────────────

describe('GET /v1/passenger-requests/:id/responses', () => {
  it('owner can list responses', async () => {
    const p = await createUser(testPrisma);
    const d = await createVerifiedDriver(testPrisma, { plate: 'L001' });
    const created = await createRequest(p);

    await request(app)
      .post(`/v1/passenger-requests/${created.body.id}/respond`)
      .set('Authorization', `Bearer ${d.accessToken}`)
      .send({ price: 1200, departureTime: new Date(Date.now() + 28 * 60 * 60_000).toISOString() });

    const res = await request(app)
      .get(`/v1/passenger-requests/${created.body.id}/responses`)
      .set('Authorization', `Bearer ${p.accessToken}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].driverId).toBe(d.id);
  });

  it('401 without token', async () => {
    const p = await createUser(testPrisma);
    const created = await createRequest(p);
    const res = await request(app).get(`/v1/passenger-requests/${created.body.id}/responses`);
    expect(res.status).toBe(401);
  });

  it('403 when not the request owner', async () => {
    const p1 = await createUser(testPrisma);
    const p2 = await createUser(testPrisma);
    const created = await createRequest(p1);

    const res = await request(app)
      .get(`/v1/passenger-requests/${created.body.id}/responses`)
      .set('Authorization', `Bearer ${p2.accessToken}`);
    expect(res.status).toBe(403);
  });

  it('404 when request does not exist', async () => {
    const p = await createUser(testPrisma);
    const res = await request(app)
      .get('/v1/passenger-requests/00000000-0000-0000-0000-000000000000/responses')
      .set('Authorization', `Bearer ${p.accessToken}`);
    expect(res.status).toBe(404);
  });
});

// ─── POST /v1/passenger-requests/:id/respond/:responseId/accept ──────────────

describe('POST accept response', () => {
  async function setupWithResponse(opts: { extraDrivers?: number } = {}) {
    const passenger = await createUser(testPrisma);
    const driver    = await createVerifiedDriver(testPrisma, { plate: `A${Math.floor(Math.random() * 1e5)}` });
    const created   = await createRequest(passenger);

    const respRes = await request(app)
      .post(`/v1/passenger-requests/${created.body.id}/respond`)
      .set('Authorization', `Bearer ${driver.accessToken}`)
      .send({ price: 1500, departureTime: new Date(Date.now() + 28 * 60 * 60_000).toISOString() });

    // Optional extra competing drivers
    const extras: Awaited<ReturnType<typeof createVerifiedDriver>>[] = [];
    for (let i = 0; i < (opts.extraDrivers ?? 0); i++) {
      const d = await createVerifiedDriver(testPrisma, { plate: `AX${i}${Math.floor(Math.random() * 1e4)}` });
      await request(app)
        .post(`/v1/passenger-requests/${created.body.id}/respond`)
        .set('Authorization', `Bearer ${d.accessToken}`)
        .send({ price: 1400, departureTime: new Date(Date.now() + 30 * 60 * 60_000).toISOString() });
      extras.push(d);
    }

    return {
      passenger,
      driver,
      extras,
      requestId:  created.body.id,
      responseId: respRes.body.id,
    };
  }

  it('accept creates trip + booking, closes request, notifies driver, returns bookingId', async () => {
    const ctx = await setupWithResponse();

    const res = await request(app)
      .post(`/v1/passenger-requests/${ctx.requestId}/respond/${ctx.responseId}/accept`)
      .set('Authorization', `Bearer ${ctx.passenger.accessToken}`);

    expect(res.status).toBe(200);
    expect(res.body.bookingId).toBeDefined();

    // Trip created in 'direct' status
    const trip = await testPrisma.trip.findFirstOrThrow({ where: { status: 'direct' } });
    expect(trip.driverId).toBe(ctx.driver.id);

    // Booking created in 'accepted' status
    const booking = await testPrisma.booking.findUniqueOrThrow({ where: { id: res.body.bookingId } });
    expect(booking.status).toBe('accepted');
    expect(booking.passengerId).toBe(ctx.passenger.id);

    // Request is now closed
    const req = await testPrisma.passengerRequest.findUniqueOrThrow({ where: { id: ctx.requestId } });
    expect(req.status).toBe('closed');

    // Response is accepted
    const resp = await testPrisma.passengerRequestResponse.findUniqueOrThrow({ where: { id: ctx.responseId } });
    expect(resp.status).toBe('accepted');
    expect(resp.bookingId).toBe(res.body.bookingId);

    // Driver notified
    expect(notifier.findForUser(ctx.driver.id, 'request:response_accepted')).toHaveLength(1);
  });

  it('declines all other pending responses when one is accepted', async () => {
    const ctx = await setupWithResponse({ extraDrivers: 2 });

    await request(app)
      .post(`/v1/passenger-requests/${ctx.requestId}/respond/${ctx.responseId}/accept`)
      .set('Authorization', `Bearer ${ctx.passenger.accessToken}`);

    const declined = await testPrisma.passengerRequestResponse.findMany({
      where: { requestId: ctx.requestId, status: 'declined' },
    });
    expect(declined).toHaveLength(2);

    // Declined drivers notified
    for (const d of ctx.extras) {
      expect(notifier.findForUser(d.id, 'request:response_declined').length).toBeGreaterThan(0);
    }
  });

  it('401 without token', async () => {
    const ctx = await setupWithResponse();
    const res = await request(app)
      .post(`/v1/passenger-requests/${ctx.requestId}/respond/${ctx.responseId}/accept`);
    expect(res.status).toBe(401);
  });

  it('403 when a different user tries to accept', async () => {
    const ctx    = await setupWithResponse();
    const other  = await createUser(testPrisma);

    const res = await request(app)
      .post(`/v1/passenger-requests/${ctx.requestId}/respond/${ctx.responseId}/accept`)
      .set('Authorization', `Bearer ${other.accessToken}`);
    expect(res.status).toBe(403);
  });

  it('409 when response is expired', async () => {
    const ctx = await setupWithResponse();

    // Force-expire the response
    await testPrisma.passengerRequestResponse.update({
      where: { id: ctx.responseId },
      data:  { expiresAt: new Date(Date.now() - 1000) },
    });

    const res = await request(app)
      .post(`/v1/passenger-requests/${ctx.requestId}/respond/${ctx.responseId}/accept`)
      .set('Authorization', `Bearer ${ctx.passenger.accessToken}`);
    expect(res.status).toBe(409);
  });

  it('409 when response is not pending (already declined)', async () => {
    const ctx = await setupWithResponse();

    // Decline first
    await request(app)
      .post(`/v1/passenger-requests/${ctx.requestId}/respond/${ctx.responseId}/decline`)
      .set('Authorization', `Bearer ${ctx.passenger.accessToken}`);

    const res = await request(app)
      .post(`/v1/passenger-requests/${ctx.requestId}/respond/${ctx.responseId}/accept`)
      .set('Authorization', `Bearer ${ctx.passenger.accessToken}`);
    expect(res.status).toBe(409);
  });

  it('409 when request is already closed', async () => {
    const ctx = await setupWithResponse();

    // Accept once
    await request(app)
      .post(`/v1/passenger-requests/${ctx.requestId}/respond/${ctx.responseId}/accept`)
      .set('Authorization', `Bearer ${ctx.passenger.accessToken}`);

    // Second driver tries
    const d2 = await createVerifiedDriver(testPrisma, { plate: `Z${Math.floor(Math.random() * 1e5)}` });
    const r2 = await testPrisma.passengerRequestResponse.create({
      data: {
        requestId:     ctx.requestId,
        driverId:      d2.id,
        price:         1000,
        departureTime: new Date(Date.now() + 30 * 60 * 60_000),
        expiresAt:     new Date(Date.now() + 48 * 60 * 60_000),
      },
    });

    const res = await request(app)
      .post(`/v1/passenger-requests/${ctx.requestId}/respond/${r2.id}/accept`)
      .set('Authorization', `Bearer ${ctx.passenger.accessToken}`);
    expect(res.status).toBe(409);
  });
});

// ─── POST /v1/passenger-requests/:id/respond/:responseId/decline ─────────────

describe('POST decline response', () => {
  async function setupWithPendingResponse() {
    const passenger = await createUser(testPrisma);
    const driver    = await createVerifiedDriver(testPrisma, { plate: `D${Math.floor(Math.random() * 1e5)}` });
    const created   = await createRequest(passenger);

    const respRes = await request(app)
      .post(`/v1/passenger-requests/${created.body.id}/respond`)
      .set('Authorization', `Bearer ${driver.accessToken}`)
      .send({ price: 1200, departureTime: new Date(Date.now() + 28 * 60 * 60_000).toISOString() });

    return {
      passenger,
      driver,
      requestId:  created.body.id,
      responseId: respRes.body.id,
    };
  }

  it('passenger declines → 204, notifier fires for driver', async () => {
    const ctx = await setupWithPendingResponse();

    const res = await request(app)
      .post(`/v1/passenger-requests/${ctx.requestId}/respond/${ctx.responseId}/decline`)
      .set('Authorization', `Bearer ${ctx.passenger.accessToken}`);

    expect(res.status).toBe(204);

    const resp = await testPrisma.passengerRequestResponse.findUniqueOrThrow({ where: { id: ctx.responseId } });
    expect(resp.status).toBe('declined');

    expect(notifier.findForUser(ctx.driver.id, 'request:response_declined')).toHaveLength(1);
  });

  it('401 without token', async () => {
    const ctx = await setupWithPendingResponse();
    const res = await request(app)
      .post(`/v1/passenger-requests/${ctx.requestId}/respond/${ctx.responseId}/decline`);
    expect(res.status).toBe(401);
  });

  it('403 when not the request owner', async () => {
    const ctx   = await setupWithPendingResponse();
    const other = await createUser(testPrisma);

    const res = await request(app)
      .post(`/v1/passenger-requests/${ctx.requestId}/respond/${ctx.responseId}/decline`)
      .set('Authorization', `Bearer ${other.accessToken}`);
    expect(res.status).toBe(403);
  });

  it('409 when response is already declined', async () => {
    const ctx = await setupWithPendingResponse();

    await request(app)
      .post(`/v1/passenger-requests/${ctx.requestId}/respond/${ctx.responseId}/decline`)
      .set('Authorization', `Bearer ${ctx.passenger.accessToken}`);

    const res = await request(app)
      .post(`/v1/passenger-requests/${ctx.requestId}/respond/${ctx.responseId}/decline`)
      .set('Authorization', `Bearer ${ctx.passenger.accessToken}`);
    expect(res.status).toBe(409);
  });

  it('404 for unknown response id', async () => {
    const ctx = await setupWithPendingResponse();
    const res = await request(app)
      .post(`/v1/passenger-requests/${ctx.requestId}/respond/00000000-0000-0000-0000-000000000000/decline`)
      .set('Authorization', `Bearer ${ctx.passenger.accessToken}`);
    expect(res.status).toBe(404);
  });
});

describe('GET /v1/passenger-requests — blocked owners', () => {
  it("hides a blocked passenger's open requests from the public feed", async () => {
    const p = await createUser(testPrisma);
    expect((await createRequest(p)).status).toBe(201);
    await testPrisma.user.update({ where: { id: p.id }, data: { isBlocked: true } });
    const res = await request(app).get('/v1/passenger-requests');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(0);
  });
});
