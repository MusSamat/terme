import { beforeEach, describe, expect, it } from 'vitest';
import { CITY } from '../../../tests/cities.js';
import request from 'supertest';
import type { Express } from 'express';
import { testPrisma } from '../../../tests/setup.js';
import { createApp } from '@/server.js';
import { createUser, createVerifiedDriver } from '../../../tests/factories.js';

let app: Express;

beforeEach(() => {
  app = createApp(testPrisma);
});

describe('GET /v1/users/me/export (GDPR)', () => {
  it('returns JSON with profile, trips, bookings, ratings, messages, complaints', async () => {
    const u = await createUser(testPrisma, { name: 'Exporter' });
    const d = await createVerifiedDriver(testPrisma, { plate: 'EX1' });
    const trip = await testPrisma.trip.create({
      data: {
        driverId: d.id,
        originCity: 'Бишкек', originCityId: CITY['Бишкек'],
        destinationCity: 'Ош', destinationCityId: CITY['Ош'],
        originAddress: 'x',
        departureAt: new Date(Date.now() + 4 * 60 * 60_000),
        estimatedDurationMin: 600,
        seatsTotal: 3,
        seatsAvailable: 2,
        pricePerSeat: 800,
        luggage: 'no',
        status: 'completed',
      },
    });
    const booking = await testPrisma.booking.create({
      data: {
        tripId: trip.id,
        passengerId: u.id,
        seatsCount: 1,
        status: 'completed',
      },
    });
    await testPrisma.message.create({
      data: { bookingId: booking.id, senderId: u.id, text: 'Привет!' },
    });
    await testPrisma.rating.create({
      data: {
        tripId: trip.id,
        raterId: u.id,
        rateeId: d.id,
        score: 5,
        comment: 'super',
      },
    });
    await testPrisma.complaint.create({
      data: {
        reporterId: u.id,
        category: 'other',
        description: 'testing export',
      },
    });

    const res = await request(app)
      .get('/v1/users/me/export')
      .set('Authorization', `Bearer ${u.accessToken}`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/json');
    expect(res.headers['content-disposition']).toContain('attachment');

    const dump = JSON.parse(res.text);
    expect(dump.user.id).toBe(u.id);
    expect(dump.user.name).toBe('Exporter');
    expect(dump.bookings).toHaveLength(1);
    expect(dump.messages).toHaveLength(1);
    expect(dump.ratings_given).toHaveLength(1);
    expect(dump.complaints_filed).toHaveLength(1);
    expect(dump.generated_at).toBeDefined();
  });

  it('does not leak driver doc photo paths', async () => {
    const d = await createVerifiedDriver(testPrisma, { plate: 'EX2' });
    const res = await request(app)
      .get('/v1/users/me/export')
      .set('Authorization', `Bearer ${d.accessToken}`);
    expect(res.status).toBe(200);
    const dump = JSON.parse(res.text);
    // User section has no license/selfie paths.
    const userKeys = Object.keys(dump.user);
    expect(userKeys).not.toContain('licensePhotoPath');
    expect(userKeys).not.toContain('selfiePath');
    // Trips don't carry driver doc paths either.
    for (const t of dump.trips) {
      expect(Object.keys(t)).not.toContain('selfiePath');
      expect(Object.keys(t)).not.toContain('licensePhotoPath');
    }
  });
});
