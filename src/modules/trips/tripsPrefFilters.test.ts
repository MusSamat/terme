import { beforeEach, describe, expect, it } from 'vitest';
import { CITY } from '../../../tests/cities.js';
import request from 'supertest';
import type { Express } from 'express';
import { testPrisma } from '../../../tests/setup.js';
import { createApp } from '@/server.js';
import { createUser, createVerifiedDriver, seedLaunchCities } from '../../../tests/factories.js';

// Trip-search preference filters (only_verified was already covered): women_only,
// no_smoking (preferences.smoking === false), pets (preferences.animals === true).
// Each stores a JSON preferences map; the query maps to a JSON-path filter.

let app: Express;
beforeEach(async () => {
  app = createApp(testPrisma);
  await seedLaunchCities(testPrisma);
});

async function seedTrip(driverId: string, preferences: Record<string, boolean>, pricePerSeat: number) {
  await testPrisma.trip.create({
    data: {
      driverId,
      originCity: 'Бишкек', originCityId: CITY['Бишкек'],
      destinationCity: 'Ош', destinationCityId: CITY['Ош'],
      originAddress: 'x',
      departureAt: new Date(Date.now() + 4 * 60 * 60_000),
      estimatedDurationMin: 600,
      seatsTotal: 3,
      seatsAvailable: 3,
      pricePerSeat,
      luggage: 'no',
      status: 'active',
      preferences,
    },
  });
}

async function search(qs: string): Promise<{ status: number; body: { data: { pricePerSeat: number }[] } }> {
  const caller = await createUser(testPrisma);
  const res = await request(app)
    .get(`/v1/trips?from_city=Бишкек&to_city=Ош&${qs}`)
    .set('Authorization', `Bearer ${caller.accessToken}`);
  return res;
}

describe('GET /v1/trips — preference filters', () => {
  it('women_only=true returns only women-only trips', async () => {
    const a = await createVerifiedDriver(testPrisma, { plate: 'PF1A' });
    const b = await createVerifiedDriver(testPrisma, { plate: 'PF1B' });
    await seedTrip(a.id, { women_only: true }, 700);
    await seedTrip(b.id, { women_only: false }, 800);

    const res = await search('women_only=true');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0]!.pricePerSeat).toBe(700);
  });

  it('no_smoking=true returns only non-smoking trips', async () => {
    const a = await createVerifiedDriver(testPrisma, { plate: 'PF2A' });
    const b = await createVerifiedDriver(testPrisma, { plate: 'PF2B' });
    await seedTrip(a.id, { smoking: false }, 700);
    await seedTrip(b.id, { smoking: true }, 800);

    const res = await search('no_smoking=true');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0]!.pricePerSeat).toBe(700);
  });

  it('pets=true returns only pet-friendly trips', async () => {
    const a = await createVerifiedDriver(testPrisma, { plate: 'PF3A' });
    const b = await createVerifiedDriver(testPrisma, { plate: 'PF3B' });
    await seedTrip(a.id, { animals: true }, 700);
    await seedTrip(b.id, { animals: false }, 800);

    const res = await search('pets=true');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0]!.pricePerSeat).toBe(700);
  });

  it('no preference filter returns all trips on the route', async () => {
    const a = await createVerifiedDriver(testPrisma, { plate: 'PF4A' });
    const b = await createVerifiedDriver(testPrisma, { plate: 'PF4B' });
    await seedTrip(a.id, { women_only: true }, 700);
    await seedTrip(b.id, { women_only: false }, 800);

    const res = await search('sort=price_asc');
    expect(res.body.data).toHaveLength(2);
  });
});
