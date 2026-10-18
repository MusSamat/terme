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

const BISHKEK_BBOX = '74.45,42.78,74.75,42.97';

async function tripAt(plate: string, lat: number | null, lng: number | null, to: 'Ош' | 'Нарын' = 'Ош') {
  const d = await createVerifiedDriver(testPrisma, { plate });
  return testPrisma.trip.create({
    data: {
      driverId: d.id,
      originCityId: CITY['Бишкек'], originCity: 'Бишкек',
      destinationCityId: CITY[to], destinationCity: to,
      originLat: lat, originLng: lng,
      departureAt: new Date(Date.now() + 5 * 60 * 60_000),
      estimatedDurationMin: 600, seatsTotal: 3, seatsAvailable: 3, pricePerSeat: 900, status: 'active',
    },
  });
}

const map = (q: string) => request(app).get(`/v1/map?${q}`);

describe('GET /v1/map', () => {
  it('shows each trip at its exact pin when zoomed in, clusters when zoomed out', async () => {
    await tripAt('M1', 42.8769, 74.565); // Западный автовокзал
    await tripAt('M2', 42.8826, 74.6316); // Восточный автовокзал
    const close = await map(`kind=trips&bbox=${BISHKEK_BBOX}&zoom=15`);
    expect(close.status).toBe(200);
    expect(close.body.items).toHaveLength(2);
    expect(close.body.items.every((i: { exact: boolean }) => i.exact)).toBe(true);
    expect(close.body.clusters).toEqual([]);

    const far = await map(`kind=trips&bbox=${BISHKEK_BBOX}&zoom=6`);
    expect(far.body.items).toEqual([]);
    expect(far.body.clusters).toEqual([expect.objectContaining({ count: 2 })]);
  });

  it('falls back to the settlement point when a trip has no pin (exact=false)', async () => {
    await tripAt('M3', null, null);
    const res = await map(`kind=trips&bbox=${BISHKEK_BBOX}&zoom=15`);
    expect(res.body.items).toEqual([expect.objectContaining({ exact: false, originCity: 'Бишкек' })]);
  });

  it('filters by destination and serves passenger requests too', async () => {
    await tripAt('M4', 42.87, 74.6, 'Ош');
    await tripAt('M5', 42.88, 74.62, 'Нарын');
    const toNaryn = await map(`kind=trips&bbox=${BISHKEK_BBOX}&zoom=15&to_id=${CITY['Нарын']}`);
    expect(toNaryn.body.items.map((i: { destinationCity: string }) => i.destinationCity)).toEqual(['Нарын']);

    const p = await createUser(testPrisma);
    await testPrisma.passengerRequest.create({
      data: {
        passengerId: p.id,
        originCityId: CITY['Бишкек'], originCity: 'Бишкек',
        destinationCityId: CITY['Ош'], destinationCity: 'Ош',
        originLat: 42.875, originLng: 74.58,
        departureDate: new Date(Date.now() + 26 * 60 * 60_000),
      },
    });
    const reqs = await map(`kind=requests&bbox=${BISHKEK_BBOX}&zoom=15`);
    expect(reqs.body.items).toEqual([expect.objectContaining({ exact: true, seats: 1, price: null })]);
  });
});
