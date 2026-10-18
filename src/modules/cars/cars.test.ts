import { beforeEach, describe, expect, it } from 'vitest';
import { CITY } from '../../../tests/cities.js';
import request from 'supertest';
import type { Express } from 'express';
import { testPrisma } from '../../../tests/setup.js';
import { createApp } from '@/server.js';
import { createUser } from '../../../tests/factories.js';

// Garage (cars) — GET/POST /v1/cars, DELETE /v1/cars/:id. Anyone authed can add
// a car (Phase 1: publishing a trip is gated on having one). Rules: max 5,
// unique plate per user, soft-delete blocked while an active trip rides on it.

let app: Express;
beforeEach(() => {
  app = createApp(testPrisma);
});

const VALID = { make: 'Toyota', model: 'Camry', color: 'White', plate: 'ABCD12', seatsCount: 4 };
const add = (token: string, body: Record<string, unknown>) =>
  request(app).post('/v1/cars').set('Authorization', `Bearer ${token}`).send(body);

describe('POST /v1/cars — add a car', () => {
  it('adds a car and lists it', async () => {
    const u = await createUser(testPrisma);
    const res = await add(u.accessToken, VALID);
    expect(res.status).toBe(201);
    expect(res.body.plate).toBe('ABCD12');

    const list = await request(app).get('/v1/cars').set('Authorization', `Bearer ${u.accessToken}`);
    expect(list.status).toBe(200);
    expect(list.body.data).toHaveLength(1);
  });

  it('rejects an invalid plate (400 VALIDATION_ERROR)', async () => {
    const u = await createUser(testPrisma);
    const res = await add(u.accessToken, { ...VALID, plate: 'ab' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects a missing make (400)', async () => {
    const u = await createUser(testPrisma);
    const res = await add(u.accessToken, { ...VALID, make: '' });
    expect(res.status).toBe(400);
  });

  it('rejects a duplicate plate for the same user (409 duplicate_plate)', async () => {
    const u = await createUser(testPrisma);
    await add(u.accessToken, VALID);
    const res = await add(u.accessToken, { ...VALID, plate: 'ABCD12' });
    expect(res.status).toBe(409);
    expect(res.body.error.details.reason).toBe('duplicate_plate');
  });

  it('enforces a max of 5 cars (409 max_cars)', async () => {
    const u = await createUser(testPrisma);
    for (const plate of ['CAR001', 'CAR002', 'CAR003', 'CAR004', 'CAR005']) {
      expect((await add(u.accessToken, { ...VALID, plate })).status).toBe(201);
    }
    const res = await add(u.accessToken, { ...VALID, plate: 'CAR006' });
    expect(res.status).toBe(409);
    expect(res.body.error.details.reason).toBe('max_cars');
  });

  it('requires authentication (401)', async () => {
    const res = await request(app).post('/v1/cars').send(VALID);
    expect(res.status).toBe(401);
  });
});

describe('DELETE /v1/cars/:id — remove a car', () => {
  it('soft-deletes an own car', async () => {
    const u = await createUser(testPrisma);
    const created = await add(u.accessToken, VALID);
    const del = await request(app).delete(`/v1/cars/${created.body.id}`).set('Authorization', `Bearer ${u.accessToken}`);
    expect(del.status).toBe(204);

    const list = await request(app).get('/v1/cars').set('Authorization', `Bearer ${u.accessToken}`);
    expect(list.body.data).toHaveLength(0);
  });

  it('blocks deletion while an active trip rides on the car (409 car_in_use)', async () => {
    const u = await createUser(testPrisma);
    const created = await add(u.accessToken, VALID);
    await testPrisma.trip.create({
      data: {
        driverId: u.id,
        carId: created.body.id,
        originCity: 'Бишкек', originCityId: CITY['Бишкек'],
        destinationCity: 'Ош', destinationCityId: CITY['Ош'],
        originAddress: 'x',
        departureAt: new Date(Date.now() + 4 * 60 * 60_000),
        estimatedDurationMin: 600,
        seatsTotal: 3,
        seatsAvailable: 3,
        pricePerSeat: 900,
        status: 'active',
      },
    });
    const del = await request(app).delete(`/v1/cars/${created.body.id}`).set('Authorization', `Bearer ${u.accessToken}`);
    expect(del.status).toBe(409);
    expect(del.body.error.details.reason).toBe('car_in_use');
  });

  it("forbids deleting another user's car (403 not_owner)", async () => {
    const owner = await createUser(testPrisma);
    const other = await createUser(testPrisma);
    const created = await add(owner.accessToken, VALID);
    const del = await request(app)
      .delete(`/v1/cars/${created.body.id}`)
      .set('Authorization', `Bearer ${other.accessToken}`);
    expect(del.status).toBe(403);
    expect(del.body.error.details.reason).toBe('not_owner');
  });
});
