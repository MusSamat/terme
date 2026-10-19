import http from 'node:http';
import { CITY } from '../../tests/cities.js';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { io as ioClient, type Socket as ClientSocket } from 'socket.io-client';
import request from 'supertest';
import type { Server as IoServer } from 'socket.io';
import { testPrisma } from '../../tests/setup.js';
import {
  createUser,
  createVerifiedDriver,
  seedLaunchCities,
} from '../../tests/factories.js';
import { createApp } from '@/server.js';
import { createIoServer, attachChatNamespace } from './socketServer.js';
import { createInProcessNotifier, NoopNotifier } from '@/lib/notifier.js';
import { randomUUID } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { env } from '@/config/env.js';
import { createChatService } from '@/modules/chat/chat.service.js';

const ACCESS_CLAIMS = {};

let server: http.Server;
let io: IoServer;
let port: number;
let app: ReturnType<typeof createApp>;

beforeAll(async () => {
  server = http.createServer();
  io = createIoServer(server);
  const notifier = createInProcessNotifier(testPrisma, io);
  attachChatNamespace(io, testPrisma, notifier);
  app = createApp(testPrisma, notifier);
  server.on('request', app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await io.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(async () => {
  await seedLaunchCities(testPrisma);
});

function connectSocket(token: string): ClientSocket {
  return ioClient(`http://localhost:${port}`, {
    transports: ['websocket'],
    reconnection: false,
    auth: { token },
  });
}

async function waitForEvent<T = unknown>(
  socket: ClientSocket,
  event: string,
  timeoutMs = 2000,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event);
      reject(new Error(`timeout waiting for ${event}`));
    }, timeoutMs);
    socket.once(event, (payload: T) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });
}

async function setupAcceptedBooking() {
  const driver = await createVerifiedDriver(testPrisma, {
    plate: `WS${Math.floor(Math.random() * 1e5)}`,
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
  // Use REST to create + accept the booking — mirrors real client flow.
  const app = createApp(testPrisma);
  const brespRes = await request(app)
    .post('/v1/bookings')
    .set('Authorization', `Bearer ${passenger.accessToken}`)
    .send({ tripId: trip.id, seatsCount: 1 });
  await request(app)
    .patch(`/v1/bookings/${brespRes.body.id}/accept`)
    .set('Authorization', `Bearer ${driver.accessToken}`);
  return { driver, passenger, bookingId: brespRes.body.id as string };
}

describe('Socket.IO handshake', () => {
  it('rejects connection without a token', async () => {
    const socket = ioClient(`http://localhost:${port}`, {
      transports: ['websocket'],
      reconnection: false,
    });
    const err = await new Promise<Error>((resolve) => {
      socket.on('connect_error', (e) => resolve(e as Error));
    });
    expect(err).toBeDefined();
    socket.close();
  });

  it('rejects a garbage token', async () => {
    const socket = connectSocket('not-a-token');
    const err = await new Promise<Error>((resolve) => {
      socket.on('connect_error', (e) => resolve(e as Error));
    });
    expect(err).toBeDefined();
    socket.close();
  });

  it('accepts a valid access token', async () => {
    const u = await createUser(testPrisma);
    const socket = connectSocket(u.accessToken);
    await new Promise<void>((resolve, reject) => {
      socket.on('connect', resolve);
      socket.on('connect_error', reject);
    });
    expect(socket.connected).toBe(true);
    socket.close();
  });
});

describe('chat namespace', () => {
  it('chat:join delivers history to participant; chat:send fans out', async () => {
    const ctx = await setupAcceptedBooking();
    const ps = connectSocket(ctx.passenger.accessToken);
    const ds = connectSocket(ctx.driver.accessToken);
    await Promise.all([
      new Promise<void>((r) => ps.on('connect', r)),
      new Promise<void>((r) => ds.on('connect', r)),
    ]);

    ps.emit('chat:join', { booking_id: ctx.bookingId });
    ds.emit('chat:join', { booking_id: ctx.bookingId });
    await Promise.all([
      waitForEvent(ps, 'chat:joined'),
      waitForEvent(ds, 'chat:joined'),
    ]);

    const messagePromise = waitForEvent<{ message: { text: string } }>(ds, 'chat:message');
    const ackPromise = waitForEvent<{ client_msg_id: string; server_id: string }>(
      ps,
      'chat:message_sent',
    );

    ps.emit('chat:send', {
      booking_id: ctx.bookingId,
      text: 'привет',
      client_msg_id: 'cid-1',
    });

    const [message, ack] = await Promise.all([messagePromise, ackPromise]);
    expect(message.message.text).toBe('привет');
    expect(ack.client_msg_id).toBe('cid-1');
    expect(ack.server_id).toBeDefined();

    ps.close();
    ds.close();
  });

  it('chat:join from a non-participant errors with FORBIDDEN', async () => {
    const ctx = await setupAcceptedBooking();
    const stranger = await createUser(testPrisma);
    const s = connectSocket(stranger.accessToken);
    await new Promise<void>((r) => s.on('connect', r));

    s.emit('chat:join', { booking_id: ctx.bookingId });
    const err = await waitForEvent<{ code: string }>(s, 'chat:error');
    expect(err.code).toBe('FORBIDDEN');
    s.close();
  });
});

describe('WS real-time notifications (#11)', () => {
  it('delivers booking:new_request to the driver in real time when a passenger books', async () => {
    const driver = await createVerifiedDriver(testPrisma, { plate: `WSN${Math.floor(Math.random() * 1e5)}` });
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
        pricePerSeat: 900,
        status: 'active',
      },
    });
    const passenger = await createUser(testPrisma);

    const ds = connectSocket(driver.accessToken);
    await waitForEvent(ds, 'connect');

    // Arm the listener BEFORE booking, then book over HTTP → the driver's socket
    // must receive the push within the timeout (real-time, not polling).
    const pushed = waitForEvent<{ booking: { id: string } }>(ds, 'booking:new_request', 2000);
    const res = await request(app)
      .post('/v1/bookings')
      .set('Authorization', `Bearer ${passenger.accessToken}`)
      .send({ tripId: trip.id, seatsCount: 1 });
    expect(res.status).toBe(201);

    const evt = await pushed;
    expect(evt.booking.id).toBe(res.body.id);
    ds.close();
  });

  it('delivers booking:accepted to the passenger in real time when the driver accepts', async () => {
    const driver = await createVerifiedDriver(testPrisma, { plate: `WSA${Math.floor(Math.random() * 1e5)}` });
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
        pricePerSeat: 900,
        status: 'active',
      },
    });
    const passenger = await createUser(testPrisma);
    const booking = await request(app)
      .post('/v1/bookings')
      .set('Authorization', `Bearer ${passenger.accessToken}`)
      .send({ tripId: trip.id, seatsCount: 1 });

    const ps = connectSocket(passenger.accessToken);
    await waitForEvent(ps, 'connect');

    const pushed = waitForEvent<{ booking: { id: string } }>(ps, 'booking:accepted', 2000);
    await request(app)
      .patch(`/v1/bookings/${booking.body.id}/accept`)
      .set('Authorization', `Bearer ${driver.accessToken}`)
      .expect(200);

    const evt = await pushed;
    expect(evt.booking.id).toBe(booking.body.id);
    ps.close();
  });
});

describe('socket lifecycle hardening (M1)', () => {
  const waitConnect = (s: ClientSocket) => waitForEvent(s, 'connect');

  it('logout/all drops the user\'s live sockets', async () => {
    const u = await createUser(testPrisma);
    const s = connectSocket(u.accessToken);
    await waitConnect(s);
    const dropped = waitForEvent<string>(s, 'disconnect');
    const res = await request(app)
      .post('/v1/auth/logout/all')
      .set('Authorization', `Bearer ${u.accessToken}`);
    expect(res.status).toBe(204);
    expect(await dropped).toBe('io server disconnect');
  });

  it('emits auth:expired and disconnects when the access token expires', async () => {
    const u = await createUser(testPrisma);
    const shortLived = jwt.sign(
      { sub: u.id, phone: u.phone, roles: ['passenger'], kind: 'access' },
      env.JWT_ACCESS_SECRET,
      { algorithm: 'HS256', expiresIn: 2, ...ACCESS_CLAIMS },
    );
    const s = connectSocket(shortLived);
    await waitConnect(s);
    await waitForEvent(s, 'auth:expired', 4000);
    s.close();
  });

  it('caps concurrent sockets per user', async () => {
    const saved = env.WS_MAX_CONNECTIONS_PER_USER;
    env.WS_MAX_CONNECTIONS_PER_USER = 2;
    const u = await createUser(testPrisma);
    const a = connectSocket(u.accessToken);
    const b = connectSocket(u.accessToken);
    try {
      await Promise.all([waitConnect(a), waitConnect(b)]);
      const c = connectSocket(u.accessToken);
      const err = await waitForEvent<Error>(c, 'connect_error');
      expect(err.message).toBe('too_many_connections');
      c.close();
    } finally {
      env.WS_MAX_CONNECTIONS_PER_USER = saved;
      a.close();
      b.close();
    }
  });

  it('chat.send / markRead re-check that the user is still active', async () => {
    const u = await createUser(testPrisma);
    await testPrisma.user.update({ where: { id: u.id }, data: { isBlocked: true } });
    const chat = createChatService(testPrisma, new NoopNotifier());
    await expect(chat.send(randomUUID(), u.id, 'hi')).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(chat.markRead(randomUUID(), u.id)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});
