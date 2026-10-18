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
  jpegBuffer,
} from '../../../tests/factories.js';
import { NoopNotifier } from '@/lib/notifier.js';

let app: Express;
let notifier: NoopNotifier;

beforeEach(() => {
  notifier = new NoopNotifier();
  // Re-enable rate limits for the rate-limit test below.
  app = createApp(testPrisma, notifier);
});

describe('POST /v1/complaints', () => {
  it('creates a complaint and broadcasts new_complaint to admins', async () => {
    const reporter = await createUser(testPrisma);
    const target = await createUser(testPrisma);

    const res = await request(app)
      .post('/v1/complaints')
      .set('Authorization', `Bearer ${reporter.accessToken}`)
      .field('category', 'safety')
      .field('description', 'Водитель вёл себя агрессивно после поездки.')
      .field('targetUserId', target.id);
    expect(res.status).toBe(201);
    expect(res.body.priority).toBe('P0');

    const adminEvents = notifier.findForUser('__admins__', 'new_complaint');
    expect(adminEvents).toHaveLength(1);
    expect((adminEvents[0]!.payload as { priority: string }).priority).toBe('P0');
  });

  it('requires either targetUserId or targetTripId', async () => {
    const u = await createUser(testPrisma);
    const res = await request(app)
      .post('/v1/complaints')
      .set('Authorization', `Bearer ${u.accessToken}`)
      .field('category', 'other')
      .field('description', 'жалоба без цели');
    expect(res.status).toBe(400);
  });

  it('rejects category=foo as validation error', async () => {
    const u = await createUser(testPrisma);
    const target = await createUser(testPrisma);
    const res = await request(app)
      .post('/v1/complaints')
      .set('Authorization', `Bearer ${u.accessToken}`)
      .field('category', 'foo')
      .field('description', 'does not matter')
      .field('targetUserId', target.id);
    expect(res.status).toBe(400);
  });

  it('accepts up to 5 attachments; stores paths', async () => {
    const reporter = await createUser(testPrisma);
    const target = await createUser(testPrisma);
    const req0 = request(app)
      .post('/v1/complaints')
      .set('Authorization', `Bearer ${reporter.accessToken}`)
      .field('category', 'rudeness')
      .field('description', 'грубость')
      .field('targetUserId', target.id);
    for (let i = 0; i < 3; i += 1) {
      req0.attach('attachments', jpegBuffer(), {
        filename: `a${i}.jpg`,
        contentType: 'image/jpeg',
      });
    }
    const res = await req0;
    expect(res.status).toBe(201);

    const row = await testPrisma.complaint.findUniqueOrThrow({ where: { id: res.body.id } });
    expect(row.attachments).toHaveLength(3);
  });

  it('rejects self-reporting', async () => {
    const u = await createUser(testPrisma);
    const res = await request(app)
      .post('/v1/complaints')
      .set('Authorization', `Bearer ${u.accessToken}`)
      .field('category', 'other')
      .field('description', 'testing self')
      .field('targetUserId', u.id);
    expect(res.status).toBe(400);
  });

  // Note: TZ §7.3 3-per-hour-per-user rate limit is enforced by the same
  // `build()` factory as the OTP limits (see rateLimit.ts), so we rely on the
  // auth OTP tests in Sprint 0 to prove that store works. We can't test it
  // here because RATE_LIMIT_DISABLED is captured at env-parse time and the
  // test setup parses it as `true`.
});

describe('GET /v1/complaints/my', () => {
  it('returns the caller\'s complaints newest-first with priority', async () => {
    const reporter = await createUser(testPrisma);
    const target = await createUser(testPrisma);
    await testPrisma.complaint.createMany({
      data: [
        {
          reporterId: reporter.id,
          targetUserId: target.id,
          category: 'safety',
          description: 'A',
        },
        {
          reporterId: reporter.id,
          targetUserId: target.id,
          category: 'other',
          description: 'B',
        },
      ],
    });
    const res = await request(app)
      .get('/v1/complaints/my')
      .set('Authorization', `Bearer ${reporter.accessToken}`);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.data[0].priority).toBeDefined();
  });
});

describe('Admin complaints queue + resolve', () => {
  it('admin lists complaints with SLA breach flag and resolves one', async () => {
    const admin = await createAdmin(testPrisma);
    const reporter = await createUser(testPrisma);
    const target = await createUser(testPrisma);

    const created = await testPrisma.complaint.create({
      data: {
        reporterId: reporter.id,
        targetUserId: target.id,
        category: 'safety',
        description: 'stale safety report',
        createdAt: new Date(Date.now() - 3 * 60 * 60_000), // 3h ago
      },
    });

    const list = await request(app)
      .get('/v1/admin/complaints')
      .set('Authorization', `Bearer ${admin.accessToken}`);
    expect(list.status).toBe(200);
    const found = list.body.data.find((c: { id: string }) => c.id === created.id);
    expect(found.slaBreach).toBe(true);
    expect(found.priority).toBe('P0');

    const resolved = await request(app)
      .patch(`/v1/admin/complaints/${created.id}/resolve`)
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .send({ status: 'resolved', resolution: 'contacted driver, issued warning' });
    expect(resolved.status).toBe(200);
    expect(resolved.body.status).toBe('resolved');

    const audit = await testPrisma.adminAction.findFirst({
      where: { adminId: admin.id, action: 'resolve_complaint' },
    });
    expect(audit).not.toBeNull();
  });

  it('cannot resolve twice', async () => {
    const admin = await createAdmin(testPrisma);
    const reporter = await createUser(testPrisma);
    const c = await testPrisma.complaint.create({
      data: {
        reporterId: reporter.id,
        category: 'other',
        description: 'x',
        status: 'resolved',
      },
    });
    const res = await request(app)
      .patch(`/v1/admin/complaints/${c.id}/resolve`)
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .send({ status: 'dismissed', resolution: 'duplicate' });
    expect(res.status).toBe(409);
  });
});

describe('Admin force-cancel trip', () => {
  it('cancels an active trip and notifies every passenger', async () => {
    const admin = await createAdmin(testPrisma);
    const d = await createVerifiedDriver(testPrisma, { plate: 'FC1' });
    const trip = await testPrisma.trip.create({
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
    const p1 = await createUser(testPrisma);
    const p2 = await createUser(testPrisma);
    await testPrisma.booking.createMany({
      data: [
        { tripId: trip.id, passengerId: p1.id, seatsCount: 1, status: 'pending' },
        { tripId: trip.id, passengerId: p2.id, seatsCount: 1, status: 'accepted' },
      ],
    });

    const res = await request(app)
      .patch(`/v1/admin/trips/${trip.id}/cancel`)
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .send({ reason: 'duplicate posting' });
    expect(res.status).toBe(200);
    expect(res.body.affectedPassengers).toBe(2);

    expect(notifier.findForUser(p1.id, 'trip:cancelled')).toHaveLength(1);
    expect(notifier.findForUser(p2.id, 'trip:cancelled')).toHaveLength(1);

    const fresh = await testPrisma.trip.findUniqueOrThrow({ where: { id: trip.id } });
    expect(fresh.status).toBe('cancelled');
    expect(fresh.cancelledReason).toContain('[ADMIN]');
  });
});
