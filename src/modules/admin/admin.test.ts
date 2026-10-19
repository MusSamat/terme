import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { testPrisma } from '../../../tests/setup.js';
import { createApp } from '@/server.js';
import { createAdmin, createUser, jpegBuffer } from '../../../tests/factories.js';

let app: Express;
beforeEach(() => {
  app = createApp(testPrisma);
});

async function submitDriverVerification(accessToken: string, plate: string) {
  await request(app)
    .post('/v1/drivers/verification')
    .set('Authorization', `Bearer ${accessToken}`)
    .field('carMake', 'Toyota')
    .field('carModel', 'Camry')
    .field('carYear', '2015')
    .field('carColor', 'Белый')
    .field('carPlate', plate)
    .field('seatsCount', '4')
    .attach('license', jpegBuffer(), { filename: 'l.jpg', contentType: 'image/jpeg' })
    .attach('license_back', jpegBuffer(), { filename: 'lb.jpg', contentType: 'image/jpeg' })
    .attach('car_passport_back', jpegBuffer(), { filename: 'pb.jpg', contentType: 'image/jpeg' })
    .attach('car_passport', jpegBuffer(), { filename: 'p.jpg', contentType: 'image/jpeg' })
    .attach('car_photo', jpegBuffer(), { filename: 'c.jpg', contentType: 'image/jpeg' })
    .attach('selfie', jpegBuffer(), { filename: 's.jpg', contentType: 'image/jpeg' });
}

describe('GET /v1/admin/verifications', () => {
  it('401 without admin token', async () => {
    const res = await request(app).get('/v1/admin/verifications');
    expect(res.status).toBe(401);
  });

  it('401 when using a regular user token', async () => {
    const u = await createUser(testPrisma);
    const res = await request(app)
      .get('/v1/admin/verifications')
      .set('Authorization', `Bearer ${u.accessToken}`);
    // passenger tokens are kind="access" — admin middleware rejects wrong_token_kind.
    expect(res.status).toBe(401);
  });

  it('returns queue FIFO, oldest first, with SLA breach flag', async () => {
    const admin = await createAdmin(testPrisma);
    const u1 = await createUser(testPrisma);
    const u2 = await createUser(testPrisma);
    await submitDriverVerification(u1.accessToken, 'OLD1111');
    await submitDriverVerification(u2.accessToken, 'NEW2222');

    // Back-date the first submission to breach the 24h SLA.
    await testPrisma.driverProfile.update({
      where: { userId: u1.id },
      data: { submittedAt: new Date(Date.now() - 2 * 24 * 60 * 60_000) },
    });

    const res = await request(app)
      .get('/v1/admin/verifications?status=pending')
      .set('Authorization', `Bearer ${admin.accessToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data[0].carPlate).toBe('OLD1111');
    expect(res.body.data[0].slaBreach).toBe(true);
    expect(res.body.data[1].carPlate).toBe('NEW2222');
    expect(res.body.data[1].slaBreach).toBe(false);
  });
});

describe('PATCH /v1/admin/verifications/:id/approve', () => {
  it('sets status=verified, adds driver role, writes audit row', async () => {
    const admin = await createAdmin(testPrisma);
    const u = await createUser(testPrisma);
    await submitDriverVerification(u.accessToken, 'APV0001');
    const dp = await testPrisma.driverProfile.findUniqueOrThrow({ where: { userId: u.id } });

    const res = await request(app)
      .patch(`/v1/admin/verifications/${dp.id}/approve`)
      .set('Authorization', `Bearer ${admin.accessToken}`);
    expect(res.status).toBe(200);
    expect(res.body.verificationStatus).toBe('verified');
    expect(res.body.verifiedBy).toBe(admin.id);

    const refreshed = await testPrisma.user.findUniqueOrThrow({ where: { id: u.id } });
    expect(refreshed.roles).toContain('driver');

    const audit = await testPrisma.adminAction.findFirst({
      where: { adminId: admin.id, action: 'verify_driver' },
    });
    expect(audit).not.toBeNull();
    expect((audit!.details as { plate: string }).plate).toBe('APV0001');
  });
});

describe('PATCH /v1/admin/verifications/:id/reject', () => {
  it('requires reason', async () => {
    const admin = await createAdmin(testPrisma);
    const u = await createUser(testPrisma);
    await submitDriverVerification(u.accessToken, 'REJ0001');
    const dp = await testPrisma.driverProfile.findUniqueOrThrow({ where: { userId: u.id } });

    const noReason = await request(app)
      .patch(`/v1/admin/verifications/${dp.id}/reject`)
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .send({});
    expect(noReason.status).toBe(400);
  });

  it('stores reason and leaves driver role absent', async () => {
    const admin = await createAdmin(testPrisma);
    const u = await createUser(testPrisma);
    await submitDriverVerification(u.accessToken, 'REJ0002');
    const dp = await testPrisma.driverProfile.findUniqueOrThrow({ where: { userId: u.id } });

    const res = await request(app)
      .patch(`/v1/admin/verifications/${dp.id}/reject`)
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .send({ reason: 'Selfie does not match license photo' });
    expect(res.status).toBe(200);
    expect(res.body.verificationStatus).toBe('rejected');
    expect(res.body.rejectionReason).toContain('Selfie');

    const user = await testPrisma.user.findUniqueOrThrow({ where: { id: u.id } });
    expect(user.roles).not.toContain('driver');
  });
});

describe('PATCH /v1/admin/verifications/:id/request-docs', () => {
  it('moves status to docs_requested with the list', async () => {
    const admin = await createAdmin(testPrisma);
    const u = await createUser(testPrisma);
    await submitDriverVerification(u.accessToken, 'RQD0001');
    const dp = await testPrisma.driverProfile.findUniqueOrThrow({ where: { userId: u.id } });

    const res = await request(app)
      .patch(`/v1/admin/verifications/${dp.id}/request-docs`)
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .send({ docs: ['selfie'], note: 'Plate not visible' });
    expect(res.status).toBe(200);
    expect(res.body.verificationStatus).toBe('docs_requested');
    expect(res.body.requestedDocs).toEqual(['selfie']);
  });

  it('rejects with 409 when not pending', async () => {
    const admin = await createAdmin(testPrisma);
    const u = await createUser(testPrisma);
    await submitDriverVerification(u.accessToken, 'RQD0002');
    const dp = await testPrisma.driverProfile.findUniqueOrThrow({ where: { userId: u.id } });
    // Approve then try to request docs
    await request(app)
      .patch(`/v1/admin/verifications/${dp.id}/approve`)
      .set('Authorization', `Bearer ${admin.accessToken}`);
    const res = await request(app)
      .patch(`/v1/admin/verifications/${dp.id}/request-docs`)
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .send({ docs: ['license'] });
    expect(res.status).toBe(409);
  });
});

describe('Admin users block/unblock', () => {
  it('block sets isBlocked, revokes refresh; unblock clears it', async () => {
    const admin = await createAdmin(testPrisma);
    const u = await createUser(testPrisma);

    const block = await request(app)
      .patch(`/v1/admin/users/${u.id}/block`)
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .send({ reason: 'Verified complaint: rude behavior' });
    expect(block.status).toBe(200);
    expect(block.body.isBlocked).toBe(true);

    // Access tokens aren't checked against DB for blocked flag by auth middleware?
    // They ARE — requireAuth queries is_blocked. The user should now see 403.
    const after = await request(app)
      .get('/v1/users/me')
      .set('Authorization', `Bearer ${u.accessToken}`);
    expect(after.status).toBe(403);

    // Refresh tokens are revoked
    const tokens = await testPrisma.refreshToken.findMany({ where: { userId: u.id } });
    expect(tokens.every((t) => t.revokedAt !== null)).toBe(true);

    const unblock = await request(app)
      .patch(`/v1/admin/users/${u.id}/unblock`)
      .set('Authorization', `Bearer ${admin.accessToken}`);
    expect(unblock.status).toBe(200);
    expect(unblock.body.isBlocked).toBe(false);
  });

  it('lists users with search + role filter', async () => {
    const admin = await createAdmin(testPrisma);
    await createUser(testPrisma, { name: 'Alice', roles: ['passenger'] });
    await createUser(testPrisma, { name: 'Bob', roles: ['passenger', 'driver'] });

    const bobList = await request(app)
      .get('/v1/admin/users?q=Bob')
      .set('Authorization', `Bearer ${admin.accessToken}`);
    expect(bobList.status).toBe(200);
    expect(bobList.body.data).toHaveLength(1);
    expect(bobList.body.data[0].name).toBe('Bob');

    const drivers = await request(app)
      .get('/v1/admin/users?role=driver')
      .set('Authorization', `Bearer ${admin.accessToken}`);
    expect(drivers.body.data.every((u: { roles: string[] }) => u.roles.includes('driver'))).toBe(
      true,
    );
  });
});

describe('Admin cities (SOATE directory corrections)', () => {
  it('searches the directory and filters approximate points', async () => {
    const a = await createAdmin(testPrisma);
    const res = await request(app)
      .get('/v1/admin/cities?q=кара-суу&type=town')
      .set('Authorization', `Bearer ${a.accessToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data[0]).toMatchObject({ nameRu: 'Кара-Суу', type: 'town' });
    const approx = await request(app)
      .get('/v1/admin/cities?approx=true&limit=5')
      .set('Authorization', `Bearer ${a.accessToken}`);
    expect(approx.body.data.every((c: { coordApprox: boolean }) => c.coordApprox)).toBe(true);
  });

  it('superadmin fixes a point (no longer approximate); regular admin is 403', async () => {
    const regular = await createAdmin(testPrisma, { role: 'admin' });
    const sa = await createAdmin(testPrisma, { role: 'superadmin' });
    const target = await testPrisma.city.findFirstOrThrow({ where: { coordApprox: true } });
    const denied = await request(app)
      .patch(`/v1/admin/cities/${target.id}`)
      .set('Authorization', `Bearer ${regular.accessToken}`)
      .send({ lat: 41.5, lng: 74.5 });
    expect(denied.status).toBe(403);
    const ok = await request(app)
      .patch(`/v1/admin/cities/${target.id}`)
      .set('Authorization', `Bearer ${sa.accessToken}`)
      .send({ lat: 41.5, lng: 74.5 });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ lat: 41.5, lng: 74.5, coordApprox: false });
    await testPrisma.city.update({
      where: { id: target.id },
      data: { lat: target.lat, lng: target.lng, coordApprox: true },
    });
  });
});

describe('Admin audit log', () => {
  it('admin sees only their own actions', async () => {
    const a1 = await createAdmin(testPrisma);
    const a2 = await createAdmin(testPrisma);

    // Both perform an action — use block/unblock on a throwaway user
    const target = await createUser(testPrisma);
    await request(app)
      .patch(`/v1/admin/users/${target.id}/block`)
      .set('Authorization', `Bearer ${a1.accessToken}`)
      .send({ reason: 'from a1' });
    await request(app)
      .patch(`/v1/admin/users/${target.id}/unblock`)
      .set('Authorization', `Bearer ${a2.accessToken}`);

    const log1 = await request(app)
      .get('/v1/admin/audit-log')
      .set('Authorization', `Bearer ${a1.accessToken}`);
    expect(log1.status).toBe(200);
    expect(log1.body.data.every((r: { adminId: string }) => r.adminId === a1.id)).toBe(true);
  });

  it('superadmin sees everything', async () => {
    const sa = await createAdmin(testPrisma, { role: 'superadmin' });
    const a = await createAdmin(testPrisma, { role: 'admin' });
    const target = await createUser(testPrisma);
    await request(app)
      .patch(`/v1/admin/users/${target.id}/block`)
      .set('Authorization', `Bearer ${a.accessToken}`)
      .send({ reason: 'from admin' });
    const log = await request(app)
      .get('/v1/admin/audit-log')
      .set('Authorization', `Bearer ${sa.accessToken}`);
    expect(log.body.data.some((r: { adminId: string }) => r.adminId === a.id)).toBe(true);
  });
});

describe('PATCH /v1/admin/trips/:id/cancel', () => {
  it("cancels 'viewed' bookings too (every live request), not just pending/accepted", async () => {
    const admin = await createAdmin(testPrisma);
    const driver = await createUser(testPrisma);
    const passenger = await createUser(testPrisma);
    const city = await testPrisma.city.findFirstOrThrow({ where: { type: 'capital' } });
    const other = await testPrisma.city.findFirstOrThrow({ where: { type: 'capital', NOT: { id: city.id } } });
    const trip = await testPrisma.trip.create({
      data: {
        driverId: driver.id,
        originCityId: city.id, originCity: city.nameRu,
        destinationCityId: other.id, destinationCity: other.nameRu,
        departureAt: new Date(Date.now() + 5 * 60 * 60_000),
        estimatedDurationMin: 300, seatsTotal: 3, seatsAvailable: 3, pricePerSeat: 500,
      },
    });
    const bk = await testPrisma.booking.create({
      data: { tripId: trip.id, passengerId: passenger.id, seatsCount: 1, status: 'viewed' },
    });
    const res = await request(app)
      .patch(`/v1/admin/trips/${trip.id}/cancel`)
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .send({ reason: 'fraud report' });
    expect(res.status).toBe(200);
    expect(res.body.affectedPassengers).toBe(1);
    const row = await testPrisma.booking.findUniqueOrThrow({ where: { id: bk.id } });
    expect(row.status).toBe('cancelled_by_driver');
  });
});
