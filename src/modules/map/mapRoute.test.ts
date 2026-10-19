import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { testPrisma } from '../../../tests/setup.js';
import { CITY } from '../../../tests/cities.js';
import { createApp } from '@/server.js';
import { createUser, createVerifiedDriver } from '../../../tests/factories.js';

let app: Express;
beforeEach(() => {
  app = createApp(testPrisma);
});

const inHours = (h: number) => new Date(Date.now() + h * 60 * 60_000);

async function trip(
  driverId: string,
  over: Partial<{ to: 'Ош' | 'Нарын'; lat: number; lng: number; seats: number; hours: number }> = {},
) {
  const to = over.to ?? 'Ош';
  return testPrisma.trip.create({
    data: {
      driverId,
      originCityId: CITY['Бишкек'], originCity: 'Бишкек',
      destinationCityId: CITY[to], destinationCity: to,
      originLat: over.lat ?? null, originLng: over.lng ?? null,
      departureAt: inHours(over.hours ?? 5),
      estimatedDurationMin: 600, seatsTotal: 3, seatsAvailable: over.seats ?? 3, pricePerSeat: 900,
      status: 'active',
    },
  });
}

function passengerRequest(passengerId: string, over: Partial<{ lat: number; lng: number; hours: number }> = {}) {
  return {
    passengerId,
    originCityId: CITY['Бишкек'], originCity: 'Бишкек',
    destinationCityId: CITY['Ош'], destinationCity: 'Ош',
    originLat: over.lat ?? null, originLng: over.lng ?? null,
    seatsNeeded: 2,
    departureDate: inHours(over.hours ?? 26),
  };
}

const route = (q: string) =>
  request(app).get(`/v1/map/route?from_id=${CITY['Бишкек']}&to_id=${CITY['Ош']}&${q}`);

describe('GET /v1/map/route', () => {
  it('returns every visible trip of the route with a point, names and the driver', async () => {
    const d1 = await createVerifiedDriver(testPrisma, { plate: 'R1', name: 'Азамат' });
    const d2 = await createVerifiedDriver(testPrisma, { plate: 'R2' });
    const pinned = await trip(d1.id, { lat: 42.8769, lng: 74.565 });
    const plain = await trip(d2.id, { hours: 8 });
    // Not on the map: other destination, no free seats, departed, blocked driver.
    await trip(d1.id, { to: 'Нарын' });
    await trip(d2.id, { seats: 0, hours: 30 });
    await trip((await createVerifiedDriver(testPrisma, { plate: 'R5' })).id, { hours: -2 });
    const blocked = await createVerifiedDriver(testPrisma, { plate: 'R3' });
    await trip(blocked.id);
    await testPrisma.user.update({ where: { id: blocked.id }, data: { isBlocked: true } });

    const res = await route('kind=trips');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ kind: 'trips', truncated: false, nearby: false });
    expect(res.body.items.map((i: { id: string }) => i.id)).toEqual([pinned.id, plain.id]);

    const bishkek = await testPrisma.city.findUniqueOrThrow({ where: { id: CITY['Бишкек'] } });
    const osh = await testPrisma.city.findUniqueOrThrow({ where: { id: CITY['Ош'] } });
    expect(res.body.items[0]).toEqual({
      id: pinned.id,
      kind: 'trip',
      lat: 42.8769,
      lng: 74.565,
      exact: true,
      departureAt: pinned.departureAt.toISOString(),
      seatsFree: 3,
      passengers: null,
      price: 900,
      origin: { id: bishkek.id, nameRu: bishkek.nameRu, nameKg: bishkek.nameKg },
      destination: { id: osh.id, nameRu: osh.nameRu, nameKg: osh.nameKg },
      user: { id: d1.id, name: 'Азамат', avatarUrl: null, rating: null, ratingCount: 0 },
    });
    expect(res.body.items[1]).toMatchObject({ exact: false, lat: bishkek.lat, lng: bishkek.lng });
  });

  it('serves passenger requests with passengers (not seatsFree) and no price', async () => {
    const p = await createUser(testPrisma, { name: 'Айгуль' });
    const blocked = await createUser(testPrisma);
    await testPrisma.passengerRequest.create({ data: passengerRequest(p.id, { lat: 42.875, lng: 74.58 }) });
    await testPrisma.passengerRequest.create({ data: passengerRequest(blocked.id) });
    await testPrisma.user.update({ where: { id: blocked.id }, data: { deletedAt: new Date() } });

    const res = await route('kind=requests');
    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([
      expect.objectContaining({
        kind: 'request', lat: 42.875, lng: 74.58, exact: true,
        seatsFree: null, passengers: 2, price: null,
        user: expect.objectContaining({ id: p.id, name: 'Айгуль' }),
      }),
    ]);
  });

  it('filters by Bishkek day', async () => {
    const d = await createVerifiedDriver(testPrisma, { plate: 'R4' });
    await trip(d.id, { hours: 5 });
    const later = await trip(d.id, { hours: 5 + 72 });
    const res = await route(`kind=trips&date=${later.departureAt.toISOString()}`);
    expect(res.body.items.map((i: { id: string }) => i.id)).toEqual([later.id]);
  });

  it('caps at 500 items and flags truncated', async () => {
    // One open request per passenger, route and day → 501 passengers.
    await testPrisma.user.createMany({
      data: Array.from({ length: 501 }, (_, i) => ({
        phone: `+996555${String(i).padStart(6, '0')}`,
        name: 'P',
        roles: ['passenger'],
      })),
    });
    const users = await testPrisma.user.findMany({ where: { phone: { startsWith: '+996555' } } });
    await testPrisma.passengerRequest.createMany({
      data: users.map((u, i) => passengerRequest(u.id, { hours: 26 + i / 60 })),
    });
    const res = await route('kind=requests');
    expect(res.body.items).toHaveLength(500);
    expect(res.body.truncated).toBe(true);
  });

  it('400 without to_id or with from_id = to_id', async () => {
    expect((await request(app).get(`/v1/map/route?kind=trips&from_id=${CITY['Бишкек']}`)).status).toBe(400);
    const same = await request(app).get(
      `/v1/map/route?kind=trips&from_id=${CITY['Бишкек']}&to_id=${CITY['Бишкек']}`,
    );
    expect(same.status).toBe(400);
  });
});
