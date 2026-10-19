import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import crypto from 'node:crypto';
import type { Express } from 'express';
import { testPrisma } from '../../../tests/setup.js';
import { CITY } from '../../../tests/cities.js';
import { createApp } from '@/server.js';
import { createUser, createVerifiedDriver } from '../../../tests/factories.js';

// Airport transfers v2: two active airports, any place as the other end,
// pickup suggestion, target_time ranking, request extras.

let app: Express;
let manas: number;
let oshAirport: number;
let issykKul: number;
let leninsky: number;

beforeEach(async () => {
  app = createApp(testPrisma);
  const id = async (soateCode: string) => (await testPrisma.city.findUniqueOrThrow({ where: { soateCode } })).id;
  manas = await id('airport:FRU');
  oshAirport = await id('airport:OSS');
  issykKul = await id('airport:IKU');
  leninsky = await id('41711201000000');
});

// HH:MM on the Asia/Bishkek day two days from now.
const DAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bishkek' }).format(new Date(Date.now() + 2 * 86_400_000));
const at = (hm: string, day = DAY) => new Date(`${day}T${hm}:00+06:00`).toISOString();
const NEXT_DAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bishkek' }).format(new Date(Date.now() + 3 * 86_400_000));

function publish(token: string, body: Record<string, unknown>) {
  return request(app)
    .post('/v1/trips')
    .set('Authorization', `Bearer ${token}`)
    .set('Idempotency-Key', crypto.randomUUID())
    .send({ seatsTotal: 3, pricePerSeat: 400, luggage: 'yes', ...body });
}

function ask(token: string, body: Record<string, unknown>) {
  return request(app)
    .post('/v1/passenger-requests')
    .set('Authorization', `Bearer ${token}`)
    .send({ seatsNeeded: 1, ...body });
}

describe('Airport transfers v2', () => {
  it('GET /cities/airports: only Манас and Ош, with titles, flight type, buffers and popular chips', async () => {
    const res = await request(app).get('/v1/cities/airports');
    expect(res.status).toBe(200);
    expect(res.body.data.map((a: { id: number }) => a.id).sort()).toEqual([manas, oshAirport].sort());
    const m = res.body.data.find((a: { id: number }) => a.id === manas);
    expect(m).toMatchObject({
      titleRu: 'Манас · Бишкек',
      flightType: 'international',
      departureBufferMin: { international: 150, domestic: 90 },
      serves: { nameRu: 'Бишкек' },
    });
    expect(m.popularDestinations.map((p: { nameRu: string }) => p.nameRu)).toEqual([
      'Бишкек', 'Кант', 'Токмок', 'Кара-Балта', 'Чолпон-Ата', 'Балыкчы',
    ]);
    const o = res.body.data.find((a: { id: number }) => a.id === oshAirport);
    expect(o).toMatchObject({ titleRu: 'Ош', flightType: 'domestic' });
    expect(o.popularDestinations[0].nameRu).toBe('Ош');
    expect(o.popularDestinations).toHaveLength(5);
  });

  it('an inactive airport refuses new rides but its old rides still read and list', async () => {
    const d = await createVerifiedDriver(testPrisma, { plate: 'AV1' });
    const refused = await publish(d.accessToken, { originCityId: CITY['Бишкек'], destinationCityId: issykKul, departureAt: at('10:00') });
    expect(refused.status).toBe(400);

    const car = await testPrisma.car.findFirstOrThrow({ where: { userId: d.id } });
    const old = await testPrisma.trip.create({
      data: {
        driverId: d.id, carId: car.id, kind: 'airport',
        originCityId: issykKul, destinationCityId: CITY['Бишкек'],
        originCity: 'Аэропорт', destinationCity: 'Бишкек',
        departureAt: new Date(at('10:00')), estimatedDurationMin: 180,
        seatsTotal: 3, seatsAvailable: 3, pricePerSeat: 500, status: 'active',
      },
    });
    expect((await request(app).get(`/v1/trips/${old.id}`)).status).toBe(200);
    const list = await request(app).get(`/v1/trips?from_id=${issykKul}`);
    expect(list.body.data.map((t: { id: string }) => t.id)).toEqual([old.id]);
  });

  it('meeting spots at Манас (approximate, at the terminals)', async () => {
    const res = await request(app).get(`/v1/cities/${manas}/spots`);
    expect(res.body.data).toHaveLength(3);
    expect(res.body.data[0]).toMatchObject({ kind: 'spot', approx: true });
    expect((await request(app).get(`/v1/cities/${oshAirport}/spots`)).body.data).toHaveLength(2);
  });

  it('scope=any finds city districts; they may be the end of a transfer only', async () => {
    const q = encodeURIComponent('Ленинский');
    const plain = await request(app).get(`/v1/cities?q=${q}`);
    expect(plain.body.data.map((p: { id: number }) => p.id)).not.toContain(leninsky);
    const any = await request(app).get(`/v1/cities?q=${q}&scope=any`);
    expect(any.body.data.map((p: { id: number }) => p.id)).toContain(leninsky);

    const d = await createVerifiedDriver(testPrisma, { plate: 'AV2' });
    const ok = await publish(d.accessToken, { originCityId: leninsky, destinationCityId: manas, departureAt: at('08:00') });
    expect(ok.status).toBe(201);
    expect(ok.body.kind).toBe('airport');
    const bad = await publish(d.accessToken, { originCityId: leninsky, destinationCityId: CITY['Кант'], departureAt: at('09:00') });
    expect(bad.status).toBe(400);
    expect(bad.body.error.details.reason).toBe('unknown_city');

    const p = await createUser(testPrisma);
    expect((await ask(p.accessToken, { originCityId: oshAirport, destinationCityId: leninsky, departureDate: at('12:00') })).status).toBe(201);
  });

  it('GET /cities/airports/:id/pickup-suggestion', async () => {
    const flight = at('06:10');
    const res = await request(app).get(
      `/v1/cities/airports/${manas}/pickup-suggestion?from_id=${CITY['Бишкек']}&flight_time=${encodeURIComponent(flight)}`,
    );
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ flightType: 'international', bufferMin: 150, travelMin: 30 });
    expect(res.body.data.pickupAt).toBe(new Date(Date.parse(flight) - 180 * 60_000).toISOString());

    const dom = await request(app).get(
      `/v1/cities/airports/${manas}/pickup-suggestion?from_id=${CITY['Бишкек']}&flight_time=${encodeURIComponent(flight)}&flight_type=domestic`,
    );
    expect(dom.body.data.bufferMin).toBe(90);
    const osh = await request(app).get(
      `/v1/cities/airports/${oshAirport}/pickup-suggestion?from_id=${CITY['Ош']}&flight_time=${encodeURIComponent(flight)}`,
    );
    expect(osh.body.data).toMatchObject({ flightType: 'domestic', bufferMin: 90, travelMin: 15 });

    const inactive = await request(app).get(
      `/v1/cities/airports/${issykKul}/pickup-suggestion?from_id=${CITY['Бишкек']}&flight_time=${encodeURIComponent(flight)}`,
    );
    expect(inactive.status).toBe(404);
    expect((await request(app).get(`/v1/cities/airports/${manas}/pickup-suggestion?flight_time=${encodeURIComponent(flight)}`)).status).toBe(400);
  });

  it('target_time ranks trips of that day by closeness, offset cursor pages through', async () => {
    const d = await createVerifiedDriver(testPrisma, { plate: 'AV3' });
    for (const hm of ['04:00', '09:00', '10:30', '13:00', '23:00']) {
      expect((await publish(d.accessToken, { originCityId: CITY['Бишкек'], destinationCityId: manas, departureAt: at(hm) })).status).toBe(201);
    }
    await publish(d.accessToken, { originCityId: CITY['Бишкек'], destinationCityId: manas, departureAt: at('10:00', NEXT_DAY) });

    const base = `/v1/trips?from_id=${CITY['Бишкек']}&to_id=${manas}&target_time=${encodeURIComponent(at('10:00'))}&limit=2`;
    const times: string[] = [];
    const near: boolean[] = [];
    let cursor: string | null = null;
    const cursors: Array<string | null> = [];
    do {
      const res = await request(app).get(`${base}${cursor ? `&cursor=${cursor}` : ''}`);
      expect(res.status).toBe(200);
      for (const t of res.body.data) {
        times.push(t.departureAt);
        near.push(t.nearTarget);
      }
      cursor = res.body.nextCursor;
      cursors.push(cursor);
    } while (cursor);
    expect(times).toEqual(['10:30', '09:00', '13:00', '04:00', '23:00'].map((hm) => at(hm)));
    expect(near).toEqual([true, true, false, false, false]);
    expect(cursors).toEqual(['t_2', 't_4', null]);

    expect((await request(app).get(`/v1/trips?cursor=t_2`)).status).toBe(400);
  });

  it('target_time on passenger requests and on the map route', async () => {
    for (const hm of ['05:00', '11:00', '09:30']) {
      const p = await createUser(testPrisma);
      expect((await ask(p.accessToken, { originCityId: manas, destinationCityId: CITY['Бишкек'], departureDate: at(hm) })).status).toBe(201);
    }
    const target = encodeURIComponent(at('10:00'));
    const res = await request(app).get(`/v1/passenger-requests?from_id=${manas}&to_id=${CITY['Бишкек']}&target_time=${target}&limit=2`);
    expect(res.body.data.map((r: { departureDate: string }) => r.departureDate)).toEqual([at('09:30'), at('11:00')]);
    expect(res.body.nextCursor).toBe('t_2');
    const page2 = await request(app).get(
      `/v1/passenger-requests?from_id=${manas}&to_id=${CITY['Бишкек']}&target_time=${target}&limit=2&cursor=t_2`,
    );
    expect(page2.body.data.map((r: { departureDate: string }) => r.departureDate)).toEqual([at('05:00')]);
    expect(page2.body.data[0].nearTarget).toBe(false);

    const map = await request(app).get(`/v1/map/route?kind=requests&from_id=${manas}&to_id=${CITY['Бишкек']}&target_time=${target}`);
    expect(map.body.items.map((i: { departureAt: string }) => i.departureAt)).toEqual([at('09:30'), at('11:00'), at('05:00')]);
    expect(map.body.items.map((i: { nearTarget: boolean }) => i.nearTarget)).toEqual([true, true, false]);
  });

  it('airport requests carry «встретить с табличкой» and luggage; intercity ones ignore them', async () => {
    const p = await createUser(testPrisma);
    const res = await ask(p.accessToken, {
      originCityId: manas, destinationCityId: CITY['Бишкек'], departureDate: at('07:00'),
      meetWithSign: true, luggageCount: 2,
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ kind: 'airport', meetWithSign: true, luggageCount: 2 });

    const patched = await request(app)
      .patch(`/v1/passenger-requests/${res.body.id}`)
      .set('Authorization', `Bearer ${p.accessToken}`)
      .send({ meetWithSign: false, luggageCount: null });
    expect(patched.status).toBe(200);
    expect(patched.body).toMatchObject({ meetWithSign: false, luggageCount: null });

    expect((await ask(p.accessToken, { originCityId: manas, destinationCityId: CITY['Кант'], departureDate: at('08:00'), luggageCount: 6 })).status).toBe(400);

    const intercity = await ask(p.accessToken, {
      originCityId: CITY['Бишкек'], destinationCityId: CITY['Каракол'], departureDate: at('09:00'),
      meetWithSign: true, luggageCount: 3,
    });
    expect(intercity.status).toBe(201);
    expect(intercity.body).toMatchObject({ kind: 'intercity', meetWithSign: false, luggageCount: null });
  });
});
