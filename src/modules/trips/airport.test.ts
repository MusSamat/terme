import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import crypto from 'node:crypto';
import type { Express } from 'express';
import { testPrisma } from '../../../tests/setup.js';
import { CITY } from '../../../tests/cities.js';
import { createApp } from '@/server.js';
import { createUser, createVerifiedDriver } from '../../../tests/factories.js';

// Airport transfers: an airport is a place of its own; a ride to / from it is
// kind='airport' and may run several times a day.

let app: Express;
let manas: number;
let oshAirport: number;

beforeEach(async () => {
  app = createApp(testPrisma);
  manas = (await testPrisma.city.findUniqueOrThrow({ where: { soateCode: 'airport:FRU' } })).id;
  oshAirport = (await testPrisma.city.findUniqueOrThrow({ where: { soateCode: 'airport:OSS' } })).id;
});

const at = (hours: number) => new Date(Date.now() + hours * 60 * 60_000).toISOString();

function publish(token: string, body: Record<string, unknown>) {
  return request(app)
    .post('/v1/trips')
    .set('Authorization', `Bearer ${token}`)
    .set('Idempotency-Key', crypto.randomUUID())
    .send({ seatsTotal: 3, pricePerSeat: 400, luggage: 'yes', ...body });
}

describe('Airport transfers', () => {
  it('pairs each airport with the city it serves', async () => {
    const res = await request(app).get('/v1/cities/airports');
    expect(res.status).toBe(200);
    const byIata = Object.fromEntries(
      res.body.data.map((a: { id: number; serves: { nameRu: string } }) => [a.id, a.serves.nameRu]),
    );
    expect(byIata[manas]).toBe('Бишкек');
    expect(byIata[oshAirport]).toBe('Ош');
  });

  it('finds airports by «аэропорт» in the place picker', async () => {
    const res = await request(app).get(`/v1/cities?q=${encodeURIComponent('аэропорт')}&limit=10`);
    expect(res.body.data.map((c: { type: string }) => c.type)).toContain('airport');
  });

  it('a Бишкек → «Манас» trip is a transfer; several per day are allowed', async () => {
    const d = await createVerifiedDriver(testPrisma, { plate: 'AP1' });
    const first = await publish(d.accessToken, {
      originCityId: CITY['Бишкек'],
      destinationCityId: manas,
      originPoint: { lat: 42.8762, lng: 74.6146, address: 'ЦУМ' },
      departureAt: at(3),
    });
    expect(first.status).toBe(201);
    expect(first.body.kind).toBe('airport');
    expect(first.body.estimatedDurationMin).toBeLessThanOrEqual(60);
    const second = await publish(d.accessToken, {
      originCityId: CITY['Бишкек'],
      destinationCityId: manas,
      departureAt: at(6),
    });
    expect(second.status).toBe(201);
  });

  it('intercity rides keep the one-per-route-per-day rule', async () => {
    const d = await createVerifiedDriver(testPrisma, { plate: 'AP2' });
    const body = { originCityId: CITY['Бишкек'], destinationCityId: CITY['Ош'] };
    expect((await publish(d.accessToken, { ...body, departureAt: at(3) })).body.kind).toBe('intercity');
    expect((await publish(d.accessToken, { ...body, departureAt: at(4) })).status).toBe(409);
  });

  it('kind=airport lists transfers only', async () => {
    const d = await createVerifiedDriver(testPrisma, { plate: 'AP3' });
    await publish(d.accessToken, { originCityId: manas, destinationCityId: CITY['Бишкек'], departureAt: at(3) });
    await publish(d.accessToken, { originCityId: CITY['Бишкек'], destinationCityId: CITY['Ош'], departureAt: at(5) });
    const res = await request(app).get('/v1/trips?kind=airport');
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0]).toMatchObject({ kind: 'airport', originCityId: manas });
  });

  it('a passenger can ask for a pickup at the airport with a flight number', async () => {
    const p = await createUser(testPrisma);
    const res = await request(app)
      .post('/v1/passenger-requests')
      .set('Authorization', `Bearer ${p.accessToken}`)
      .send({
        originCityId: oshAirport,
        destinationCityId: CITY['Ош'],
        seatsNeeded: 2,
        departureDate: at(26),
        flightNumber: 'su 1882',
      });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ kind: 'airport', flightNumber: 'SU 1882' });
    const bad = await request(app)
      .post('/v1/passenger-requests')
      .set('Authorization', `Bearer ${p.accessToken}`)
      .send({ originCityId: oshAirport, destinationCityId: CITY['Ош'], seatsNeeded: 1, departureDate: at(27), flightNumber: '???' });
    expect(bad.status).toBe(400);
  });
});
