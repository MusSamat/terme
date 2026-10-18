import { beforeEach, describe, expect, it } from 'vitest';
import { CITY } from '../../../tests/cities.js';
import request from 'supertest';
import type { Express } from 'express';
import { testPrisma } from '../../../tests/setup.js';
import { createApp } from '@/server.js';
import { createUser, createVerifiedDriver, seedLaunchCities } from '../../../tests/factories.js';

// Contract guard for the feed `date` filter — the exact mismatch that broke the
// mobile client: the API validates `date` as z.string().datetime({offset:true}),
// so a bare "YYYY-MM-DD" is rejected (VALIDATION_ERROR) and only a full ISO
// datetime with a timezone offset filters the list. Mirrors the web's
// normalizeDate (…T00:00:00+06:00). Covers trips AND requests.

let app: Express;

beforeEach(async () => {
  app = createApp(testPrisma);
  await seedLaunchCities(testPrisma);
});

/** YYYY-MM-DD of a Date in Kyrgyzstan time (+06:00). */
function kgDay(d: Date): string {
  return new Date(d.getTime() + 6 * 60 * 60_000).toISOString().slice(0, 10);
}
const kgMidnight = (ymd: string) => `${ymd}T00:00:00+06:00`;

async function seedTrip(driverId: string, departureAt: Date, pricePerSeat: number) {
  await testPrisma.trip.create({
    data: {
      driverId,
      originCity: 'Бишкек', originCityId: CITY['Бишкек'],
      destinationCity: 'Ош', destinationCityId: CITY['Ош'],
      originAddress: 'x',
      departureAt,
      estimatedDurationMin: 600,
      seatsTotal: 3,
      seatsAvailable: 3,
      pricePerSeat,
      luggage: 'no',
      status: 'active',
    },
  });
}

describe('GET /v1/trips — date filter contract', () => {
  it('a full ISO datetime with offset filters to that day only', async () => {
    const a = await createVerifiedDriver(testPrisma, { plate: 'DF1' });
    const b = await createVerifiedDriver(testPrisma, { plate: 'DF2' });
    const dep1 = new Date(Date.now() + 28 * 60 * 60_000); // ~tomorrow
    const dep2 = new Date(Date.now() + 52 * 60 * 60_000); // ~day after
    await seedTrip(a.id, dep1, 700);
    await seedTrip(b.id, dep2, 800);

    const caller = await createUser(testPrisma);
    const res = await request(app)
      .get(`/v1/trips?from_city=Бишкек&to_city=Ош&date=${encodeURIComponent(kgMidnight(kgDay(dep1)))}`)
      .set('Authorization', `Bearer ${caller.accessToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].pricePerSeat).toBe(700); // only day-1's trip
  });

  it('rejects a bare YYYY-MM-DD date (400 VALIDATION_ERROR) — the client bug', async () => {
    const caller = await createUser(testPrisma);
    const res = await request(app)
      .get('/v1/trips?from_city=Бишкек&to_city=Ош&date=2026-08-04')
      .set('Authorization', `Bearer ${caller.accessToken}`);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });
});

describe('GET /v1/passenger-requests — date filter contract', () => {
  it('rejects a bare YYYY-MM-DD date (400 VALIDATION_ERROR)', async () => {
    const res = await request(app).get('/v1/passenger-requests?from_city=Бишкек&to_city=Ош&date=2026-08-04');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('accepts a full ISO datetime with offset', async () => {
    const res = await request(app).get(
      `/v1/passenger-requests?from_city=Бишкек&to_city=Ош&date=${encodeURIComponent(kgMidnight('2026-08-04'))}`,
    );
    expect(res.status).toBe(200);
  });
});
