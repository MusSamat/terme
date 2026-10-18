import { beforeEach, describe, expect, it } from 'vitest';
import { CITY } from '../../../tests/cities.js';
import request from 'supertest';
import type { Express } from 'express';
import { testPrisma } from '../../../tests/setup.js';
import { createApp } from '@/server.js';
import {
  createAdmin,
  createUser,
  createVerifiedDriver,
} from '../../../tests/factories.js';

let app: Express;

beforeEach(() => {
  app = createApp(testPrisma);
});

describe('GET /v1/admin/analytics/kpi', () => {
  it('reports user/trip/complaint/rating counters', async () => {
    const admin = await createAdmin(testPrisma);
    const d = await createVerifiedDriver(testPrisma, { plate: 'KPI1' });
    // A trip from the driver
    await testPrisma.trip.create({
      data: {
        driverId: d.id,
        originCity: 'Бишкек', originCityId: CITY['Бишкек'],
        destinationCity: 'Ош', destinationCityId: CITY['Ош'],
        originAddress: 'x',
        departureAt: new Date(Date.now() + 4 * 60 * 60_000),
        estimatedDurationMin: 600,
        seatsTotal: 3,
        seatsAvailable: 3,
        pricePerSeat: 800,
        luggage: 'no',
        status: 'active',
      },
    });
    // An open complaint
    const reporter = await createUser(testPrisma);
    await testPrisma.complaint.create({
      data: {
        reporterId: reporter.id,
        category: 'other',
        description: 'x',
        status: 'new',
      },
    });

    const res = await request(app)
      .get('/v1/admin/analytics/kpi')
      .set('Authorization', `Bearer ${admin.accessToken}`);
    expect(res.status).toBe(200);
    expect(res.body.publishedTripsNow).toBe(1);
    expect(res.body.openComplaints).toBe(1);
    expect(res.body.activeDrivers7d).toBe(1);
    expect(res.body.users).toMatchObject({ total: expect.any(Number) });
  });

  it('acceptance rate is null when no decisions in 7d', async () => {
    const admin = await createAdmin(testPrisma);
    const res = await request(app)
      .get('/v1/admin/analytics/kpi')
      .set('Authorization', `Bearer ${admin.accessToken}`);
    expect(res.body.acceptanceRate7d).toBeNull();
  });
});

describe('GET /v1/admin/analytics/charts/:name', () => {
  it('returns a registrations_by_day array', async () => {
    const admin = await createAdmin(testPrisma);
    await createUser(testPrisma);
    await createUser(testPrisma);
    const res = await request(app)
      .get('/v1/admin/analytics/charts/registrations_by_day')
      .set('Authorization', `Bearer ${admin.accessToken}`);
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('registrations_by_day');
    expect(Array.isArray(res.body.data)).toBe(true);
  });

  it('returns top_routes for existing trips', async () => {
    const admin = await createAdmin(testPrisma);
    const d = await createVerifiedDriver(testPrisma, { plate: 'TR1' });
    await testPrisma.trip.create({
      data: {
        driverId: d.id,
        originCity: 'Бишкек', originCityId: CITY['Бишкек'],
        destinationCity: 'Ош', destinationCityId: CITY['Ош'],
        originAddress: 'x',
        departureAt: new Date(Date.now() + 4 * 60 * 60_000),
        estimatedDurationMin: 600,
        seatsTotal: 3,
        seatsAvailable: 3,
        pricePerSeat: 800,
        luggage: 'no',
        status: 'active',
      },
    });
    const res = await request(app)
      .get('/v1/admin/analytics/charts/top_routes')
      .set('Authorization', `Bearer ${admin.accessToken}`);
    expect(res.body.data[0]).toMatchObject({ from: 'Бишкек', to: 'Ош', count: 1 });
  });

  it('404s unknown chart', async () => {
    const admin = await createAdmin(testPrisma);
    const res = await request(app)
      .get('/v1/admin/analytics/charts/unknown_chart')
      .set('Authorization', `Bearer ${admin.accessToken}`);
    expect(res.status).toBe(400); // Zod rejects at validation level
  });
});
