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
  app = createApp(testPrisma, notifier);
});

async function submitVerification(accessToken: string, plate: string) {
  return request(app)
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

describe('admin action → notifier', () => {
  it('verify_driver emits verification_approved to the driver', async () => {
    const admin = await createAdmin(testPrisma);
    const user = await createUser(testPrisma);
    await submitVerification(user.accessToken, 'NOT1');
    const dp = await testPrisma.driverProfile.findUniqueOrThrow({ where: { userId: user.id } });
    await request(app)
      .patch(`/v1/admin/verifications/${dp.id}/approve`)
      .set('Authorization', `Bearer ${admin.accessToken}`);
    expect(notifier.findForUser(user.id, 'verification_approved')).toHaveLength(1);
  });

  it('reject_driver emits verification_rejected with reason', async () => {
    const admin = await createAdmin(testPrisma);
    const user = await createUser(testPrisma);
    await submitVerification(user.accessToken, 'NOT2');
    const dp = await testPrisma.driverProfile.findUniqueOrThrow({ where: { userId: user.id } });
    await request(app)
      .patch(`/v1/admin/verifications/${dp.id}/reject`)
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .send({ reason: 'photo unclear' });
    const events = notifier.findForUser(user.id, 'verification_rejected');
    expect(events).toHaveLength(1);
    expect((events[0]!.payload as { reason: string }).reason).toBe('photo unclear');
  });

  it('request_driver_docs emits verification_need_docs with the list', async () => {
    const admin = await createAdmin(testPrisma);
    const user = await createUser(testPrisma);
    await submitVerification(user.accessToken, 'NOT3');
    const dp = await testPrisma.driverProfile.findUniqueOrThrow({ where: { userId: user.id } });
    await request(app)
      .patch(`/v1/admin/verifications/${dp.id}/request-docs`)
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .send({ docs: ['selfie'], note: 'Retake' });
    const events = notifier.findForUser(user.id, 'verification_need_docs');
    expect((events[0]!.payload as { docs: string[] }).docs).toEqual(['selfie']);
  });

  it('block_user emits account_blocked to the user', async () => {
    const admin = await createAdmin(testPrisma);
    const user = await createUser(testPrisma);
    await request(app)
      .patch(`/v1/admin/users/${user.id}/block`)
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .send({ reason: 'safety' });
    const events = notifier.findForUser(user.id, 'account_blocked');
    expect((events[0]!.payload as { reason: string }).reason).toBe('safety');
  });
});

describe('trip cancel → notifier', () => {
  it('emits trip_cancelled to each affected passenger', async () => {
    const d = await createVerifiedDriver(testPrisma, { plate: 'TC1' });
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
    await request(app)
      .delete(`/v1/trips/${trip.id}`)
      .set('Authorization', `Bearer ${d.accessToken}`);
    expect(notifier.findForUser(p1.id, 'trip:cancelled')).toHaveLength(1);
    expect(notifier.findForUser(p2.id, 'trip:cancelled')).toHaveLength(1);
  });
});
