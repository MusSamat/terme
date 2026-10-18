import { beforeEach, describe, expect, it } from 'vitest';
import { CITY } from '../../../tests/cities.js';
import request from 'supertest';
import type { Express } from 'express';
import { testPrisma } from '../../../tests/setup.js';
import { createApp } from '@/server.js';
import { createUser, createVerifiedDriver, createTrip, seedLaunchCities } from '../../../tests/factories.js';

// «Избранное» — like/unlike a trip or a passenger request and read them back
// from GET /v1/users/me/likes?type=…. Trip like-toggle is covered in the
// engagement suite; this focuses on the liked-LIST feed for both target types.

let app: Express;
beforeEach(async () => {
  app = createApp(testPrisma);
  await seedLaunchCities(testPrisma);
});

const likes = (token: string, type: string) =>
  request(app).get(`/v1/users/me/likes?type=${type}`).set('Authorization', `Bearer ${token}`);

describe('GET /v1/users/me/likes — favourites feed', () => {
  it('a liked trip appears in the feed and disappears after unlike', async () => {
    const driver = await createVerifiedDriver(testPrisma, { plate: 'LK1' });
    const trip = await createTrip(testPrisma, driver.id);
    const u = await createUser(testPrisma);

    await request(app).post(`/v1/trips/${trip.id}/like`).set('Authorization', `Bearer ${u.accessToken}`).expect(200);

    const liked = await likes(u.accessToken, 'trip');
    expect(liked.status).toBe(200);
    expect(liked.body.data).toHaveLength(1);
    expect(liked.body.data[0].id).toBe(trip.id);

    await request(app).delete(`/v1/trips/${trip.id}/like`).set('Authorization', `Bearer ${u.accessToken}`).expect(200);
    const after = await likes(u.accessToken, 'trip');
    expect(after.body.data).toHaveLength(0);
  });

  it('a liked passenger request appears in the feed', async () => {
    const passenger = await createUser(testPrisma);
    const created = await request(app)
      .post('/v1/passenger-requests')
      .set('Authorization', `Bearer ${passenger.accessToken}`)
      .send({
        originCity: 'Бишкек', originCityId: CITY['Бишкек'],
        destinationCity: 'Ош', destinationCityId: CITY['Ош'],
        seatsNeeded: 1,
        departureDate: new Date(Date.now() + 28 * 60 * 60_000).toISOString(),
      });
    expect(created.status).toBe(201);

    const driver = await createUser(testPrisma);
    await request(app)
      .post(`/v1/passenger-requests/${created.body.id}/like`)
      .set('Authorization', `Bearer ${driver.accessToken}`)
      .expect(200);

    const liked = await likes(driver.accessToken, 'passenger_request');
    expect(liked.status).toBe(200);
    expect(liked.body.data).toHaveLength(1);
    expect(liked.body.data[0].id).toBe(created.body.id);

    // The trip feed stays empty — likes are scoped by type.
    expect((await likes(driver.accessToken, 'trip')).body.data).toHaveLength(0);
  });
});
