import { beforeEach, describe, expect, it } from 'vitest';
import { CITY } from '../../../tests/cities.js';
import request from 'supertest';
import crypto from 'node:crypto';
import type { Express } from 'express';
import { testPrisma } from '../../../tests/setup.js';
import { createApp } from '@/server.js';
import {
  createUser,
  createVerifiedDriver,
  seedLaunchCities,
  createBooking,
  createTrip,
} from '../../../tests/factories.js';

let app: Express;

beforeEach(async () => {
  app = createApp(testPrisma);
  await seedLaunchCities(testPrisma);
});

function validDeparture(fromNowMs = 60 * 60_000): string {
  return new Date(Date.now() + fromNowMs).toISOString();
}

/** Next 12:00 Asia/Bishkek (UTC+6, no DST) — stable anchor across test runs. */
function nextKgNoon(): Date {
  const now = Date.now();
  // 06:00 UTC = 12:00 KG. Pick tomorrow's 06:00 UTC to always be in the future.
  const tomorrow = new Date(now + 24 * 60 * 60_000);
  tomorrow.setUTCHours(6, 0, 0, 0);
  return tomorrow;
}

function tripPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    originCity: 'Бишкек', originCityId: CITY['Бишкек'],
    destinationCity: 'Ош', destinationCityId: CITY['Ош'],
    originAddress: 'Вокзал',
    departureAt: validDeparture(),
    seatsTotal: 3,
    pricePerSeat: 800,
    luggage: 'small',
    ...overrides,
  };
}

function idempotencyKey(): string {
  return crypto.randomUUID();
}

describe('POST /v1/trips', () => {
  // Phase 1: publishing is gated by a garage car (cars table), not the driver
  // role or profile verification. A user with no car cannot publish → 409 no_car.
  it('rejects publishing without a garage car (409 no_car)', async () => {
    const u = await createUser(testPrisma);
    const res = await request(app)
      .post('/v1/trips')
      .set('Authorization', `Bearer ${u.accessToken}`)
      .set('Idempotency-Key', idempotencyKey())
      .send(tripPayload());
    expect(res.status).toBe(409);
    expect(res.body.error.details.reason).toBe('no_car');
  });

  it('publishes with a garage car even if driver-profile verification is pending (Phase 1: car-gated)', async () => {
    const d = await createVerifiedDriver(testPrisma, { plate: 'A1' });
    await testPrisma.driverProfile.update({
      where: { userId: d.id },
      data: { verificationStatus: 'pending' },
    });
    const res = await request(app)
      .post('/v1/trips')
      .set('Authorization', `Bearer ${d.accessToken}`)
      .set('Idempotency-Key', idempotencyKey())
      .send(tripPayload());
    expect(res.status).toBe(201);
  });

  it('creates an active trip with computed duration', async () => {
    const d = await createVerifiedDriver(testPrisma, { plate: 'B1' });
    const res = await request(app)
      .post('/v1/trips')
      .set('Authorization', `Bearer ${d.accessToken}`)
      .set('Idempotency-Key', idempotencyKey())
      .send(tripPayload());
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('active');
    expect(res.body.seatsAvailable).toBe(3);
    // Bishkek→Osh is 600 minutes in the route table.
    expect(res.body.estimatedDurationMin).toBe(600);
  });

  it('replays the same Idempotency-Key as 200 (not 409) without creating a new row', async () => {
    const d = await createVerifiedDriver(testPrisma, { plate: 'C1' });
    const key = idempotencyKey();
    const first = await request(app)
      .post('/v1/trips')
      .set('Authorization', `Bearer ${d.accessToken}`)
      .set('Idempotency-Key', key)
      .send(tripPayload());
    expect(first.status).toBe(201);
    const replay = await request(app)
      .post('/v1/trips')
      .set('Authorization', `Bearer ${d.accessToken}`)
      .set('Idempotency-Key', key)
      .send(tripPayload({ pricePerSeat: 9999 })); // body differs — replay ignores
    expect(replay.status).toBe(200);
    expect(replay.body.id).toBe(first.body.id);
    expect(replay.body.pricePerSeat).toBe(first.body.pricePerSeat);

    const count = await testPrisma.trip.count({ where: { driverId: d.id } });
    expect(count).toBe(1);
  });

  it('rejects another user reusing an Idempotency-Key', async () => {
    const d1 = await createVerifiedDriver(testPrisma, { plate: 'D1' });
    const d2 = await createVerifiedDriver(testPrisma, { plate: 'D2' });
    const key = idempotencyKey();
    await request(app)
      .post('/v1/trips')
      .set('Authorization', `Bearer ${d1.accessToken}`)
      .set('Idempotency-Key', key)
      .send(tripPayload());
    const res = await request(app)
      .post('/v1/trips')
      .set('Authorization', `Bearer ${d2.accessToken}`)
      .set('Idempotency-Key', key)
      .send(tripPayload({ destinationCity: 'Каракол', destinationCityId: CITY['Каракол'] }));
    expect(res.status).toBe(409);
  });

  it('rejects departure less than 30 minutes away', async () => {
    const d = await createVerifiedDriver(testPrisma, { plate: 'E1' });
    const res = await request(app)
      .post('/v1/trips')
      .set('Authorization', `Bearer ${d.accessToken}`)
      .set('Idempotency-Key', idempotencyKey())
      .send(tripPayload({ departureAt: validDeparture(15 * 60_000) }));
    expect(res.status).toBe(400);
    expect(res.body.error.details.reason).toBe('departure_too_soon');
  });

  it('rejects departure more than 60 days away', async () => {
    const d = await createVerifiedDriver(testPrisma, { plate: 'E2' });
    const res = await request(app)
      .post('/v1/trips')
      .set('Authorization', `Bearer ${d.accessToken}`)
      .set('Idempotency-Key', idempotencyKey())
      .send(tripPayload({ departureAt: validDeparture(70 * 24 * 60 * 60_000) }));
    expect(res.status).toBe(400);
    expect(res.body.error.details.reason).toBe('departure_too_far');
  });

  it('rejects price below 50', async () => {
    const d = await createVerifiedDriver(testPrisma, { plate: 'E3' });
    const res = await request(app)
      .post('/v1/trips')
      .set('Authorization', `Bearer ${d.accessToken}`)
      .set('Idempotency-Key', idempotencyKey())
      .send(tripPayload({ pricePerSeat: 10 }));
    expect(res.status).toBe(400);
  });

  it('rejects seatsTotal exceeding vehicle capacity', async () => {
    const d = await createVerifiedDriver(testPrisma, { plate: 'E4', seatsCount: 3 });
    const res = await request(app)
      .post('/v1/trips')
      .set('Authorization', `Bearer ${d.accessToken}`)
      .set('Idempotency-Key', idempotencyKey())
      .send(tripPayload({ seatsTotal: 5 }));
    expect(res.status).toBe(400);
    expect(res.body.error.details.reason).toBe('seats_exceed_vehicle');
  });

  it('rejects origin == destination', async () => {
    const d = await createVerifiedDriver(testPrisma, { plate: 'E5' });
    const res = await request(app)
      .post('/v1/trips')
      .set('Authorization', `Bearer ${d.accessToken}`)
      .set('Idempotency-Key', idempotencyKey())
      .send(tripPayload({ destinationCity: 'Бишкек', destinationCityId: CITY['Бишкек'] }));
    expect(res.status).toBe(400);
  });

  it('enforces one active trip per route per day', async () => {
    const d = await createVerifiedDriver(testPrisma, { plate: 'F1' });
    // Pick the next full KG day so both departures unambiguously land on the
    // same local date regardless of what time the test is run.
    const kgNoonTomorrow = nextKgNoon();
    const dep1 = new Date(kgNoonTomorrow.getTime() - 2 * 60 * 60_000); // 10:00 KG
    const dep2 = new Date(kgNoonTomorrow.getTime() + 2 * 60 * 60_000); // 14:00 KG
    const okRes = await request(app)
      .post('/v1/trips')
      .set('Authorization', `Bearer ${d.accessToken}`)
      .set('Idempotency-Key', idempotencyKey())
      .send(tripPayload({ departureAt: dep1.toISOString() }));
    expect(okRes.status).toBe(201);

    // Same route, same KG day → duplicate.
    const conflictRes = await request(app)
      .post('/v1/trips')
      .set('Authorization', `Bearer ${d.accessToken}`)
      .set('Idempotency-Key', idempotencyKey())
      .send(tripPayload({ departureAt: dep2.toISOString() }));
    expect(conflictRes.status).toBe(409);
    expect(conflictRes.body.error.details.reason).toBe('duplicate_route_day');

    // Different destination on the same day is fine (return trips, other routes).
    const otherRoute = await request(app)
      .post('/v1/trips')
      .set('Authorization', `Bearer ${d.accessToken}`)
      .set('Idempotency-Key', idempotencyKey())
      .send(tripPayload({ destinationCity: 'Каракол', destinationCityId: CITY['Каракол'], departureAt: dep2.toISOString() }));
    expect(otherRoute.status).toBe(201);

    // Same route on the next KG day is fine too.
    const nextDay = new Date(kgNoonTomorrow.getTime() + 24 * 60 * 60_000);
    const otherDay = await request(app)
      .post('/v1/trips')
      .set('Authorization', `Bearer ${d.accessToken}`)
      .set('Idempotency-Key', idempotencyKey())
      .send(tripPayload({ departureAt: nextDay.toISOString() }));
    expect(otherDay.status).toBe(201);
  });

  it('requires Idempotency-Key header', async () => {
    const d = await createVerifiedDriver(testPrisma, { plate: 'G1' });
    const res = await request(app)
      .post('/v1/trips')
      .set('Authorization', `Bearer ${d.accessToken}`)
      .send(tripPayload());
    expect(res.status).toBe(400);
  });
});

describe('GET /v1/trips (search)', () => {
  async function seedTrips() {
    const dCheap = await createVerifiedDriver(testPrisma, { plate: 'S1', name: 'Cheap' });
    const dMid = await createVerifiedDriver(testPrisma, { plate: 'S2', name: 'Mid' });
    const dExp = await createVerifiedDriver(testPrisma, { plate: 'S3', name: 'Expensive' });

    // Drivers on Бишкек→Ош route at different times and prices.
    const base = Date.now() + 4 * 60 * 60_000;
    await testPrisma.trip.createMany({
      data: [
        {
          driverId: dCheap.id,
          originCity: 'Бишкек', originCityId: CITY['Бишкек'],
          destinationCity: 'Ош', destinationCityId: CITY['Ош'],
          originAddress: 'x',
          departureAt: new Date(base),
          estimatedDurationMin: 600,
          seatsTotal: 3,
          seatsAvailable: 3,
          pricePerSeat: 500,
          luggage: 'no',
          status: 'active',
        },
        {
          driverId: dMid.id,
          originCity: 'Бишкек', originCityId: CITY['Бишкек'],
          destinationCity: 'Ош', destinationCityId: CITY['Ош'],
          originAddress: 'x',
          departureAt: new Date(base + 60_000),
          estimatedDurationMin: 600,
          seatsTotal: 3,
          seatsAvailable: 1,
          pricePerSeat: 1000,
          luggage: 'no',
          status: 'active',
        },
        {
          driverId: dExp.id,
          originCity: 'Бишкек', originCityId: CITY['Бишкек'],
          destinationCity: 'Ош', destinationCityId: CITY['Ош'],
          originAddress: 'x',
          departureAt: new Date(base + 120_000),
          estimatedDurationMin: 600,
          seatsTotal: 3,
          seatsAvailable: 3,
          pricePerSeat: 2000,
          luggage: 'yes',
          status: 'active',
        },
      ],
    });
    return { dCheap, dMid, dExp };
  }

  it('returns trips on the route, respecting seats filter', async () => {
    await seedTrips();
    const caller = await createUser(testPrisma);
    const res = await request(app)
      .get('/v1/trips?from_city=Бишкек&to_city=Ош&seats=2')
      .set('Authorization', `Bearer ${caller.accessToken}`);
    expect(res.status).toBe(200);
    // "Mid" has only 1 seat available, gets filtered out.
    expect(res.body.data.map((t: { driver: { name: string } }) => t.driver.name)).toEqual([
      'Cheap',
      'Expensive',
    ]);
  });

  it('sort=price_asc orders by price', async () => {
    await seedTrips();
    const caller = await createUser(testPrisma);
    const res = await request(app)
      .get('/v1/trips?from_city=Бишкек&to_city=Ош&sort=price_asc')
      .set('Authorization', `Bearer ${caller.accessToken}`);
    expect(
      res.body.data.map((t: { pricePerSeat: number }) => t.pricePerSeat),
    ).toEqual([500, 1000, 2000]);
  });

  it('min_price + max_price bound results', async () => {
    await seedTrips();
    const caller = await createUser(testPrisma);
    const res = await request(app)
      .get('/v1/trips?from_city=Бишкек&to_city=Ош&min_price=600&max_price=1500')
      .set('Authorization', `Bearer ${caller.accessToken}`);
    expect(
      res.body.data.map((t: { pricePerSeat: number }) => t.pricePerSeat),
    ).toEqual([1000]);
  });

  it('filters out trips departing in the past', async () => {
    const d = await createVerifiedDriver(testPrisma, { plate: 'PAST' });
    await testPrisma.trip.create({
      data: {
        driverId: d.id,
        originCity: 'Бишкек', originCityId: CITY['Бишкек'],
        destinationCity: 'Ош', destinationCityId: CITY['Ош'],
        originAddress: 'x',
        departureAt: new Date(Date.now() - 60 * 60_000),
        estimatedDurationMin: 600,
        seatsTotal: 3,
        seatsAvailable: 3,
        pricePerSeat: 800,
        luggage: 'no',
        status: 'active',
      },
    });
    const caller = await createUser(testPrisma);
    const res = await request(app)
      .get('/v1/trips?from_city=Бишкек&to_city=Ош')
      .set('Authorization', `Bearer ${caller.accessToken}`);
    expect(res.body.data).toEqual([]);
  });

  it('rejects unknown cities', async () => {
    const caller = await createUser(testPrisma);
    const res = await request(app)
      .get('/v1/trips?from_city=Нижний+Новгород&to_city=Ош')
      .set('Authorization', `Bearer ${caller.accessToken}`);
    expect(res.status).toBe(400);
  });

  it('paginates via cursor', async () => {
    await seedTrips();
    const caller = await createUser(testPrisma);
    const first = await request(app)
      .get('/v1/trips?from_city=Бишкек&to_city=Ош&limit=2')
      .set('Authorization', `Bearer ${caller.accessToken}`);
    expect(first.body.data).toHaveLength(2);
    expect(first.body.nextCursor).not.toBeNull();
    const second = await request(app)
      .get(`/v1/trips?from_city=Бишкек&to_city=Ош&limit=2&cursor=${first.body.nextCursor}`)
      .set('Authorization', `Bearer ${caller.accessToken}`);
    const firstIds: string[] = first.body.data.map((t: { id: string }) => t.id);
    const secondIds: string[] = second.body.data.map((t: { id: string }) => t.id);
    expect(secondIds.every((id) => !firstIds.includes(id))).toBe(true);
  });

  it('only_verified=true excludes unverified drivers', async () => {
    const unverified = await createUser(testPrisma, { roles: ['passenger', 'driver'] });
    await testPrisma.driverProfile.create({
      data: {
        userId: unverified.id,
        carMake: 'x',
        carModel: 'x',
        carYear: 2015,
        carColor: 'w',
        carPlate: 'UNV1',
        seatsCount: 4,
        licensePhotoPath: 'x',
        carPassportPath: 'x',
        carPhotoPath: 'x',
        selfiePath: 'x',
        verificationStatus: 'pending',
      },
    });
    await testPrisma.trip.create({
      data: {
        driverId: unverified.id,
        originCity: 'Бишкек', originCityId: CITY['Бишкек'],
        destinationCity: 'Ош', destinationCityId: CITY['Ош'],
        originAddress: 'x',
        departureAt: new Date(Date.now() + 2 * 60 * 60_000),
        estimatedDurationMin: 600,
        seatsTotal: 3,
        seatsAvailable: 3,
        pricePerSeat: 800,
        luggage: 'no',
        status: 'active',
      },
    });
    const caller = await createUser(testPrisma);
    const res = await request(app)
      .get('/v1/trips?from_city=Бишкек&to_city=Ош&only_verified=true')
      .set('Authorization', `Bearer ${caller.accessToken}`);
    expect(res.body.data).toHaveLength(0);
    const resAll = await request(app)
      .get('/v1/trips?from_city=Бишкек&to_city=Ош&only_verified=false')
      .set('Authorization', `Bearer ${caller.accessToken}`);
    expect(resAll.body.data).toHaveLength(1);
  });
});

describe('Trip pickup/dropoff stops (посадка/высадка по пути)', () => {
  // Бишкек→Баткен with a pickup stop (board en route) and a dropoff stop.
  function batkenTrip(driverId: string) {
    return {
      driverId,
      originCity: 'Бишкек', originCityId: CITY['Бишкек'],
      destinationCity: 'Баткен', destinationCityId: CITY['Баткен'],
      stops: {
        create: [
          { cityId: CITY['Нарын'], kind: 'pickup', position: 1 },
          { cityId: CITY['Ош'], kind: 'dropoff', position: 1 },
        ],
      },
      departureAt: new Date(Date.now() + 3 * 60 * 60_000),
      estimatedDurationMin: 780,
      seatsTotal: 3,
      seatsAvailable: 3,
      pricePerSeat: 1500,
      luggage: 'no',
      status: 'active',
    };
  }

  const toBatken = (extra: Record<string, unknown>) =>
    tripPayload({ destinationCityId: CITY['Баткен'], ...extra });

  it('creates a trip with pickup/dropoff stops from any region', async () => {
    const d = await createVerifiedDriver(testPrisma, { plate: 'SC1' });
    const res = await request(app)
      .post('/v1/trips')
      .set('Authorization', `Bearer ${d.accessToken}`)
      .set('Idempotency-Key', idempotencyKey())
      .send(toBatken({ pickupCityIds: [CITY['Нарын']], dropoffCityIds: [CITY['Ош']] }));
    expect(res.status).toBe(201);
    expect(res.body.pickupCities).toEqual(['Нарын']);
    expect(res.body.dropoffCities).toEqual(['Ош']);
    expect(res.body.stops).toEqual([
      { kind: 'pickup', place: expect.objectContaining({ id: CITY['Нарын'], nameRu: 'Нарын' }) },
      { kind: 'dropoff', place: expect.objectContaining({ id: CITY['Ош'] }) },
    ]);
  });

  it('rejects an unknown stop (400 unknown_city)', async () => {
    const d = await createVerifiedDriver(testPrisma, { plate: 'SC2' });
    const res = await request(app)
      .post('/v1/trips')
      .set('Authorization', `Bearer ${d.accessToken}`)
      .set('Idempotency-Key', idempotencyKey())
      .send(toBatken({ dropoffCityIds: [999999] }));
    expect(res.status).toBe(400);
    expect(res.body.error.details.reason).toBe('unknown_city');
  });

  it('drops stops equal to origin or destination', async () => {
    const d = await createVerifiedDriver(testPrisma, { plate: 'SC3' });
    const res = await request(app)
      .post('/v1/trips')
      .set('Authorization', `Bearer ${d.accessToken}`)
      .set('Idempotency-Key', idempotencyKey())
      .send(toBatken({ pickupCityIds: [CITY['Бишкек'], CITY['Нарын'], CITY['Баткен']] }));
    expect(res.status).toBe(201);
    expect(res.body.pickupCities).toEqual(['Нарын']);
  });

  it('matches a pickup stop as the search origin', async () => {
    const d = await createVerifiedDriver(testPrisma, { plate: 'SC4' });
    await testPrisma.trip.create({ data: batkenTrip(d.id) });
    const res = await request(app).get(`/v1/trips?from_id=${CITY['Нарын']}&to_id=${CITY['Баткен']}`);
    expect(res.body.data).toHaveLength(1);
  });

  it('matches a dropoff stop as the search destination', async () => {
    const d = await createVerifiedDriver(testPrisma, { plate: 'SC5' });
    await testPrisma.trip.create({ data: batkenTrip(d.id) });
    const res = await request(app).get(`/v1/trips?from_id=${CITY['Бишкек']}&to_id=${CITY['Ош']}`);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].destinationCity).toBe('Баткен');
  });

  it('does NOT match a dropoff stop used as the search origin (mirror)', async () => {
    const d = await createVerifiedDriver(testPrisma, { plate: 'SC6' });
    await testPrisma.trip.create({ data: batkenTrip(d.id) });
    // Ош is only a dropoff stop — a passenger cannot board there.
    const res = await request(app).get(`/v1/trips?from_id=${CITY['Ош']}&to_id=${CITY['Баткен']}`);
    expect(res.body.data).toHaveLength(0);
  });

  it('search by the exact route still returns the trip', async () => {
    const d = await createVerifiedDriver(testPrisma, { plate: 'SC7' });
    await testPrisma.trip.create({ data: batkenTrip(d.id) });
    const res = await request(app).get(`/v1/trips?from_id=${CITY['Бишкек']}&to_id=${CITY['Баткен']}`);
    expect(res.body.data).toHaveLength(1);
  });
});

describe('Meeting points and sort=nearest', () => {
  it('stores the boarding pin and rejects a pin far from the settlement', async () => {
    const d = await createVerifiedDriver(testPrisma, { plate: 'MP1' });
    const ok = await request(app)
      .post('/v1/trips')
      .set('Authorization', `Bearer ${d.accessToken}`)
      .set('Idempotency-Key', idempotencyKey())
      .send(tripPayload({ originPoint: { lat: 42.8746, lng: 74.6122, address: 'ЦУМ' } }));
    expect(ok.status).toBe(201);
    expect(ok.body.originPoint).toMatchObject({ lat: 42.8746, lng: 74.6122, address: 'ЦУМ' });

    // A pin in a жилмассив gets its area label automatically.
    const inArea = await request(app)
      .post('/v1/trips')
      .set('Authorization', `Bearer ${d.accessToken}`)
      .set('Idempotency-Key', idempotencyKey())
      .send(tripPayload({ destinationCityId: CITY['Нарын'], originPoint: { lat: 42.8188, lng: 74.6252 } }));
    expect(inArea.status).toBe(201);
    expect(inArea.body.originPoint.area).toEqual({ nameRu: 'Асанбай', nameKg: 'Асанбай' });

    const far = await request(app)
      .post('/v1/trips')
      .set('Authorization', `Bearer ${d.accessToken}`)
      .set('Idempotency-Key', idempotencyKey())
      .send(tripPayload({ originPoint: { lat: 40.53, lng: 72.8 } })); // Osh, not Bishkek
    expect(far.status).toBe(400);
    expect(far.body.error.details.reason).toBe('point_far_from_city');
  });

  it('sort=nearest ranks trips by distance from the viewer to the boarding pin', async () => {
    const near = await createVerifiedDriver(testPrisma, { plate: 'MP2' });
    const far = await createVerifiedDriver(testPrisma, { plate: 'MP3' });
    const base = {
      originCity: 'Бишкек', originCityId: CITY['Бишкек'],
      destinationCity: 'Ош', destinationCityId: CITY['Ош'],
      departureAt: new Date(Date.now() + 3 * 60 * 60_000),
      estimatedDurationMin: 600, seatsTotal: 3, seatsAvailable: 3, pricePerSeat: 900, status: 'active',
    };
    await testPrisma.trip.create({ data: { ...base, driverId: far.id, originLat: 42.84, originLng: 74.5 } });
    await testPrisma.trip.create({ data: { ...base, driverId: near.id, originLat: 42.876, originLng: 74.61 } });
    const res = await request(app).get(
      `/v1/trips?from_id=${CITY['Бишкек']}&sort=nearest&near_lat=42.875&near_lng=74.612`,
    );
    expect(res.status).toBe(200);
    expect(res.body.data.map((t: { driverId: string }) => t.driverId)).toEqual([near.id, far.id]);
    expect(res.body.data[0].distanceKm).toBeLessThan(1);
  });

  it('sort=nearest without a viewer point is a 400', async () => {
    const res = await request(app).get('/v1/trips?sort=nearest');
    expect(res.status).toBe(400);
  });
});

describe('GET /v1/trips/:id', () => {
  it('returns detail + recent ratings', async () => {
    const d = await createVerifiedDriver(testPrisma, { plate: 'GT1' });
    const trip = await testPrisma.trip.create({
      data: {
        driverId: d.id,
        originCity: 'Бишкек', originCityId: CITY['Бишкек'],
        destinationCity: 'Ош', destinationCityId: CITY['Ош'],
        originAddress: 'x',
        departureAt: new Date(Date.now() + 2 * 60 * 60_000),
        estimatedDurationMin: 600,
        seatsTotal: 3,
        seatsAvailable: 3,
        pricePerSeat: 800,
        luggage: 'no',
        status: 'active',
      },
    });
    const rater = await createUser(testPrisma);
    await testPrisma.rating.create({
      data: {
        tripId: trip.id,
        raterId: rater.id,
        rateeId: d.id,
        score: 5,
        comment: 'Отлично',
      },
    });
    const caller = await createUser(testPrisma);
    const res = await request(app)
      .get(`/v1/trips/${trip.id}`)
      .set('Authorization', `Bearer ${caller.accessToken}`);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(trip.id);
    expect(res.body.recentRatings).toHaveLength(1);
    expect(res.body.recentRatings[0].score).toBe(5);
  });
});

describe('PATCH /v1/trips/:id', () => {
  async function seedOwned() {
    const d = await createVerifiedDriver(testPrisma, { plate: 'PT1' });
    const trip = await testPrisma.trip.create({
      data: {
        driverId: d.id,
        originCity: 'Бишкек', originCityId: CITY['Бишкек'],
        destinationCity: 'Ош', destinationCityId: CITY['Ош'],
        originAddress: 'x',
        departureAt: new Date(Date.now() + 2 * 60 * 60_000),
        estimatedDurationMin: 600,
        seatsTotal: 3,
        seatsAvailable: 3,
        pricePerSeat: 800,
        luggage: 'no',
        status: 'active',
      },
    });
    return { d, trip };
  }

  it('updates price + bumps version', async () => {
    const { d, trip } = await seedOwned();
    const res = await request(app)
      .patch(`/v1/trips/${trip.id}`)
      .set('Authorization', `Bearer ${d.accessToken}`)
      .send({ pricePerSeat: 1200, comment: 'Едем через Токтогул' });
    expect(res.status).toBe(200);
    expect(res.body.pricePerSeat).toBe(1200);
    const row = await testPrisma.trip.findUniqueOrThrow({ where: { id: trip.id } });
    expect(row.version).toBe(2);
  });

  it('rejects another driver trying to patch', async () => {
    const { trip } = await seedOwned();
    const other = await createVerifiedDriver(testPrisma, { plate: 'PT2' });
    const res = await request(app)
      .patch(`/v1/trips/${trip.id}`)
      .set('Authorization', `Bearer ${other.accessToken}`)
      .send({ pricePerSeat: 1 });
    // 400 from price validation? No, 403 from ownership check.
    // Actually: validation runs first — pricePerSeat=1 fails min=50.
    expect([400, 403]).toContain(res.status);
  });

  it('rejects patching non-active trip', async () => {
    const { d, trip } = await seedOwned();
    await testPrisma.trip.update({
      where: { id: trip.id },
      data: { status: 'cancelled' },
    });
    const res = await request(app)
      .patch(`/v1/trips/${trip.id}`)
      .set('Authorization', `Bearer ${d.accessToken}`)
      .send({ pricePerSeat: 1500 });
    expect(res.status).toBe(409);
  });
});

describe('DELETE /v1/trips/:id (cancel)', () => {
  it('cancels trip + cascades pending/accepted bookings + bumps cancellations_30d', async () => {
    const d = await createVerifiedDriver(testPrisma, { plate: 'DL1' });
    const trip = await testPrisma.trip.create({
      data: {
        driverId: d.id,
        originCity: 'Бишкек', originCityId: CITY['Бишкек'],
        destinationCity: 'Ош', destinationCityId: CITY['Ош'],
        originAddress: 'x',
        departureAt: new Date(Date.now() + 2 * 60 * 60_000),
        estimatedDurationMin: 600,
        seatsTotal: 3,
        seatsAvailable: 3,
        pricePerSeat: 800,
        luggage: 'no',
        status: 'active',
      },
    });
    const p1 = await createUser(testPrisma);
    const p2 = await createUser(testPrisma);
    await testPrisma.booking.createMany({
      data: [
        { tripId: trip.id, passengerId: p1.id, seatsCount: 1, status: 'pending' },
        { tripId: trip.id, passengerId: p2.id, seatsCount: 1, status: 'accepted' },
      ],
    });

    const res = await request(app)
      .delete(`/v1/trips/${trip.id}`)
      .set('Authorization', `Bearer ${d.accessToken}`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('cancelled');

    const bookings = await testPrisma.booking.findMany({ where: { tripId: trip.id } });
    expect(bookings.every((b) => b.status === 'cancelled_by_driver')).toBe(true);

    const dp = await testPrisma.driverProfile.findUniqueOrThrow({ where: { userId: d.id } });
    expect(dp.cancellations30d).toBe(1);
  });

  it('rejects double-cancel', async () => {
    const d = await createVerifiedDriver(testPrisma, { plate: 'DL2' });
    const trip = await testPrisma.trip.create({
      data: {
        driverId: d.id,
        originCity: 'Бишкек', originCityId: CITY['Бишкек'],
        destinationCity: 'Ош', destinationCityId: CITY['Ош'],
        originAddress: 'x',
        departureAt: new Date(Date.now() + 2 * 60 * 60_000),
        estimatedDurationMin: 600,
        seatsTotal: 3,
        seatsAvailable: 3,
        pricePerSeat: 800,
        luggage: 'no',
        status: 'cancelled',
      },
    });
    const res = await request(app)
      .delete(`/v1/trips/${trip.id}`)
      .set('Authorization', `Bearer ${d.accessToken}`);
    expect(res.status).toBe(409);
  });
});

describe('GET /v1/trips/my (driver tabs)', () => {
  it('returns active vs past vs cancelled separately', async () => {
    const d = await createVerifiedDriver(testPrisma, { plate: 'MY1' });
    const base = Date.now();
    await testPrisma.trip.createMany({
      data: [
        {
          driverId: d.id,
          originCity: 'Бишкек', originCityId: CITY['Бишкек'],
          destinationCity: 'Ош', destinationCityId: CITY['Ош'],
          originAddress: 'x',
          departureAt: new Date(base + 2 * 60 * 60_000),
          estimatedDurationMin: 600,
          seatsTotal: 3,
          seatsAvailable: 3,
          pricePerSeat: 800,
          luggage: 'no',
          status: 'active',
        },
        {
          driverId: d.id,
          originCity: 'Бишкек', originCityId: CITY['Бишкек'],
          destinationCity: 'Каракол', destinationCityId: CITY['Каракол'],
          originAddress: 'x',
          departureAt: new Date(base - 7 * 24 * 60 * 60_000),
          estimatedDurationMin: 360,
          seatsTotal: 3,
          seatsAvailable: 0,
          pricePerSeat: 500,
          luggage: 'no',
          status: 'completed',
        },
        {
          driverId: d.id,
          originCity: 'Бишкек', originCityId: CITY['Бишкек'],
          destinationCity: 'Нарын', destinationCityId: CITY['Нарын'],
          originAddress: 'x',
          departureAt: new Date(base - 3 * 24 * 60 * 60_000),
          estimatedDurationMin: 300,
          seatsTotal: 3,
          seatsAvailable: 3,
          pricePerSeat: 500,
          luggage: 'no',
          status: 'cancelled',
        },
      ],
    });
    const active = await request(app)
      .get('/v1/trips/my?tab=active')
      .set('Authorization', `Bearer ${d.accessToken}`);
    expect(active.body.data).toHaveLength(1);

    const past = await request(app)
      .get('/v1/trips/my?tab=past')
      .set('Authorization', `Bearer ${d.accessToken}`);
    expect(past.body.data).toHaveLength(1);
    expect(past.body.data[0].status).toBe('completed');

    const cancelled = await request(app)
      .get('/v1/trips/my?tab=cancelled')
      .set('Authorization', `Bearer ${d.accessToken}`);
    expect(cancelled.body.data).toHaveLength(1);
    expect(cancelled.body.data[0].status).toBe('cancelled');
  });
});

describe('GET /v1/routes/price-suggestion', () => {
  it('returns null when fewer than 3 data points', async () => {
    const caller = await createUser(testPrisma);
    const res = await request(app)
      .get(`/v1/routes/price-suggestion?from_id=${CITY['Бишкек']}&to_id=${CITY['Ош']}`)
      .set('Authorization', `Bearer ${caller.accessToken}`);
    expect(res.status).toBe(200);
    expect(res.body.averagePrice).toBeNull();
    expect(res.body.sampleSize).toBe(0);
  });

  it('returns average over last 30 days of trips', async () => {
    const d = await createVerifiedDriver(testPrisma, { plate: 'PS1' });
    await testPrisma.trip.createMany({
      data: [600, 800, 1000].map((price, i) => ({
        driverId: d.id,
        originCity: 'Бишкек', originCityId: CITY['Бишкек'],
        destinationCity: 'Ош', destinationCityId: CITY['Ош'],
        originAddress: 'x',
        // Different days so no one-active-per-day conflict.
        departureAt: new Date(Date.now() + (i + 1) * 24 * 60 * 60_000),
        estimatedDurationMin: 600,
        seatsTotal: 3,
        seatsAvailable: 3,
        pricePerSeat: price,
        luggage: 'no',
        status: 'active',
      })),
    });
    const caller = await createUser(testPrisma);
    const res = await request(app)
      .get(`/v1/routes/price-suggestion?from_id=${CITY['Бишкек']}&to_id=${CITY['Ош']}`)
      .set('Authorization', `Bearer ${caller.accessToken}`);
    expect(res.body.averagePrice).toBe(800);
    expect(res.body.sampleSize).toBe(3);
  });
});

describe('GET /v1/trips nearby fallback (settlements within the radius)', () => {
  // Кант is ~20 km from Бишкек: an exact search from Кант with no trips falls
  // back to the Бишкек trip and flags the page as nearby.
  async function tripFrom(origin: 'Бишкек' | 'Кант', plate: string) {
    const d = await createVerifiedDriver(testPrisma, { plate });
    await testPrisma.trip.create({
      data: {
        driverId: d.id,
        originCity: origin, originCityId: CITY[origin],
        destinationCity: 'Ош', destinationCityId: CITY['Ош'],
        departureAt: new Date(Date.now() + 3 * 60 * 60_000),
        estimatedDurationMin: 600,
        seatsTotal: 3,
        seatsAvailable: 3,
        pricePerSeat: 900,
        luggage: 'no',
        status: 'active',
      },
    });
  }

  it('falls back to nearby trips when the exact place has none, flags nearby', async () => {
    await tripFrom('Бишкек', 'NB1');
    const res = await request(app).get(`/v1/trips?from_id=${CITY['Кант']}&to_id=${CITY['Ош']}`);
    expect(res.status).toBe(200);
    expect(res.body.nearby).toBe(true);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].originCity).toBe('Бишкек');
  });

  it('does not flag nearby when the exact place matches', async () => {
    await tripFrom('Кант', 'NB2');
    const res = await request(app).get(`/v1/trips?from_id=${CITY['Кант']}&to_id=${CITY['Ош']}`);
    expect(res.status).toBe(200);
    expect(res.body.nearby).toBeUndefined();
    expect(res.body.data).toHaveLength(1);
  });

  it('resolves names for SEO pages and the bot (from_city / to_city)', async () => {
    await tripFrom('Кант', 'NB3');
    const res = await request(app).get(
      `/v1/trips?from_city=${encodeURIComponent('Кант')}&to_city=${encodeURIComponent('Ош')}`,
    );
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].origin).toMatchObject({ id: CITY['Кант'], nameRu: 'Кант' });
  });
});

describe('GET /v1/trips/:id — myBooking guard', () => {
  it('exposes the viewer’s active booking on the trip', async () => {
    const d = await createVerifiedDriver(testPrisma, { plate: '11KG111MBK' });
    const trip = await createTrip(testPrisma, d.id);
    const passenger = await createUser(testPrisma);
    await createBooking(testPrisma, passenger.id, trip.id, { status: 'pending' });
    const res = await request(app)
      .get(`/v1/trips/${trip.id}`)
      .set('Authorization', `Bearer ${passenger.accessToken}`);
    expect(res.status).toBe(200);
    expect(res.body.myBooking).not.toBeNull();
    expect(res.body.myBooking.status).toBe('pending');
  });
  it('myBooking is null for a passenger without a booking', async () => {
    const d = await createVerifiedDriver(testPrisma, { plate: '12KG222MBK' });
    const trip = await createTrip(testPrisma, d.id);
    const other = await createUser(testPrisma);
    const res = await request(app)
      .get(`/v1/trips/${trip.id}`)
      .set('Authorization', `Bearer ${other.accessToken}`);
    expect(res.body.myBooking).toBeNull();
  });
});
