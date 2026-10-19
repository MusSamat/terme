import { beforeEach, describe, expect, it } from 'vitest';
import { CITY } from '../../../tests/cities.js';
import request from 'supertest';
import type { Express } from 'express';
import { testPrisma } from '../../../tests/setup.js';
import { createApp } from '@/server.js';
import { createUser, createVerifiedDriver, seedLaunchCities } from '../../../tests/factories.js';
import { NoopNotifier } from '@/lib/notifier.js';

let app: Express;
let notifier: NoopNotifier;

beforeEach(async () => {
  notifier = new NoopNotifier();
  app = createApp(testPrisma, notifier);
  await seedLaunchCities(testPrisma);
});

async function setupAcceptedBooking(): Promise<{
  driver: Awaited<ReturnType<typeof createVerifiedDriver>>;
  passenger: Awaited<ReturnType<typeof createUser>>;
  bookingId: string;
  tripId: string;
}> {
  const driver = await createVerifiedDriver(testPrisma, {
    plate: `CH${Math.floor(Math.random() * 1e5)}`,
  });
  const trip = await testPrisma.trip.create({
    data: {
      driverId: driver.id,
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
  const passenger = await createUser(testPrisma);
  const bookingRes = await request(app)
    .post('/v1/bookings')
    .set('Authorization', `Bearer ${passenger.accessToken}`)
    .send({ tripId: trip.id, seatsCount: 1 });
  await request(app)
    .patch(`/v1/bookings/${bookingRes.body.id}/accept`)
    .set('Authorization', `Bearer ${driver.accessToken}`);
  return {
    driver,
    passenger,
    bookingId: bookingRes.body.id,
    tripId: trip.id,
  };
}

describe('POST /v1/chats/:booking_id/messages (REST fallback)', () => {
  it('allows writing when booking is accepted', async () => {
    const ctx = await setupAcceptedBooking();
    const res = await request(app)
      .post(`/v1/chats/${ctx.bookingId}/messages`)
      .set('Authorization', `Bearer ${ctx.passenger.accessToken}`)
      .send({ text: 'Во сколько встречаемся?' });
    expect(res.status).toBe(201);
    expect(res.body.message.text).toBe('Во сколько встречаемся?');

    // Notifier saw the new-message emit to the driver
    expect(notifier.findForUser(ctx.driver.id, 'chat:message')).toHaveLength(1);
  });

  it('redacts phone numbers in outgoing messages', async () => {
    const ctx = await setupAcceptedBooking();
    const res = await request(app)
      .post(`/v1/chats/${ctx.bookingId}/messages`)
      .set('Authorization', `Bearer ${ctx.passenger.accessToken}`)
      .send({ text: 'позвони мне +996 700 123 456' });
    expect(res.status).toBe(201);
    expect(res.body.message.text).toContain('[скрыто]');
  });

  it('allows writing in pre-booking phase (pending) — TZ §13', async () => {
    const driver = await createVerifiedDriver(testPrisma, { plate: 'PEN1' });
    const trip = await testPrisma.trip.create({
      data: {
        driverId: driver.id,
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
    const p = await createUser(testPrisma);
    const b = await request(app)
      .post('/v1/bookings')
      .set('Authorization', `Bearer ${p.accessToken}`)
      .send({ tripId: trip.id, seatsCount: 1 });
    const res = await request(app)
      .post(`/v1/chats/${b.body.id}/messages`)
      .set('Authorization', `Bearer ${p.accessToken}`)
      .send({ text: 'Привет, место актуально?' });
    expect(res.status).toBe(201);
    expect(res.body.message.chatPhase).toBe('pre_booking');
  });

  it('forbids the driver from writing in pre-booking phase — TZ §13.1', async () => {
    const driver = await createVerifiedDriver(testPrisma, { plate: 'PEN2' });
    const trip = await testPrisma.trip.create({
      data: {
        driverId: driver.id,
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
    const p = await createUser(testPrisma);
    const b = await request(app)
      .post('/v1/bookings')
      .set('Authorization', `Bearer ${p.accessToken}`)
      .send({ tripId: trip.id, seatsCount: 1 });
    // Driver tries to message before accepting — must be rejected.
    const res = await request(app)
      .post(`/v1/chats/${b.body.id}/messages`)
      .set('Authorization', `Bearer ${driver.accessToken}`)
      .send({ text: 'Привет' });
    expect(res.status).toBe(403);
    expect(res.body.error.details.reason).toBe('driver_cannot_write_pre_booking');
  });

  it('forbids writing from a non-participant', async () => {
    const ctx = await setupAcceptedBooking();
    const stranger = await createUser(testPrisma);
    const res = await request(app)
      .post(`/v1/chats/${ctx.bookingId}/messages`)
      .set('Authorization', `Bearer ${stranger.accessToken}`)
      .send({ text: 'hi' });
    expect(res.status).toBe(403);
  });
});

describe('GET /v1/chats/:booking_id/messages', () => {
  it('returns history newest-first with cursor', async () => {
    const ctx = await setupAcceptedBooking();
    for (let i = 0; i < 5; i += 1) {
      await request(app)
        .post(`/v1/chats/${ctx.bookingId}/messages`)
        .set('Authorization', `Bearer ${ctx.passenger.accessToken}`)
        .send({ text: `msg ${i}` });
    }
    const page1 = await request(app)
      .get(`/v1/chats/${ctx.bookingId}/messages?limit=3`)
      .set('Authorization', `Bearer ${ctx.driver.accessToken}`);
    expect(page1.status).toBe(200);
    expect(page1.body.data).toHaveLength(3);
    expect(page1.body.data[0].text).toBe('msg 4');
    expect(page1.body.nextCursor).not.toBeNull();

    const page2 = await request(app)
      .get(`/v1/chats/${ctx.bookingId}/messages?limit=3&cursor=${page1.body.nextCursor}`)
      .set('Authorization', `Bearer ${ctx.driver.accessToken}`);
    expect(page2.body.data).toHaveLength(2);
  });
});

describe('PATCH /v1/messages/:id/read', () => {
  it('recipient marks message read and sender gets notified', async () => {
    const ctx = await setupAcceptedBooking();
    const sent = await request(app)
      .post(`/v1/chats/${ctx.bookingId}/messages`)
      .set('Authorization', `Bearer ${ctx.passenger.accessToken}`)
      .send({ text: 'hi' });

    const res = await request(app)
      .patch(`/v1/messages/${sent.body.message.id}/read`)
      .set('Authorization', `Bearer ${ctx.driver.accessToken}`);
    expect(res.status).toBe(200);
    expect(res.body.isRead).toBe(true);
    expect(notifier.findForUser(ctx.passenger.id, 'chat:read')).toHaveLength(1);
  });

  it('marking own message is a no-op (not an error)', async () => {
    const ctx = await setupAcceptedBooking();
    const sent = await request(app)
      .post(`/v1/chats/${ctx.bookingId}/messages`)
      .set('Authorization', `Bearer ${ctx.passenger.accessToken}`)
      .send({ text: 'hi' });
    const res = await request(app)
      .patch(`/v1/messages/${sent.body.message.id}/read`)
      .set('Authorization', `Bearer ${ctx.passenger.accessToken}`);
    expect(res.status).toBe(200);
    expect(res.body.isRead).toBe(false);
  });
});

describe('PATCH /v1/chats/:booking_id/read-all', () => {
  it('marks every unread incoming message and emits chat:read per message to the sender', async () => {
    const ctx = await setupAcceptedBooking();
    for (const text of ['one', 'two']) {
      await request(app)
        .post(`/v1/chats/${ctx.bookingId}/messages`)
        .set('Authorization', `Bearer ${ctx.passenger.accessToken}`)
        .send({ text });
    }
    const res = await request(app)
      .patch(`/v1/chats/${ctx.bookingId}/read-all`)
      .set('Authorization', `Bearer ${ctx.driver.accessToken}`);
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(2);
    expect(notifier.findForUser(ctx.passenger.id, 'chat:read')).toHaveLength(2);
  });
});
