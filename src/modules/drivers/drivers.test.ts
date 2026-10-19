import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { testPrisma } from '../../../tests/setup.js';
import { createApp } from '@/server.js';
import { createUser, jpegBuffer, smallJpegBuffer } from '../../../tests/factories.js';

let app: Express;
beforeEach(() => {
  app = createApp(testPrisma);
});

async function submit(
  accessToken: string,
  overrides: Partial<{
    carPlate: string;
    carYear: string;
    seatsCount: string;
  }> = {},
) {
  return request(app)
    .post('/v1/drivers/verification')
    .set('Authorization', `Bearer ${accessToken}`)
    .field('carMake', 'Toyota')
    .field('carModel', 'Camry')
    .field('carYear', overrides.carYear ?? '2015')
    .field('carColor', 'Белый')
    .field('carPlate', overrides.carPlate ?? '01KG123ABC')
    .field('seatsCount', overrides.seatsCount ?? '4')
    .attach('license', jpegBuffer(), { filename: 'l.jpg', contentType: 'image/jpeg' })
    .attach('license_back', jpegBuffer(), { filename: 'lb.jpg', contentType: 'image/jpeg' })
    .attach('car_passport', jpegBuffer(), { filename: 'p.jpg', contentType: 'image/jpeg' })
    .attach('car_passport_back', jpegBuffer(), { filename: 'pb.jpg', contentType: 'image/jpeg' })
    .attach('car_photo', jpegBuffer(), { filename: 'c.jpg', contentType: 'image/jpeg' })
    .attach('selfie', jpegBuffer(), { filename: 's.jpg', contentType: 'image/jpeg' });
}

describe('POST /v1/drivers/verification', () => {
  it('creates a pending driver_profile with all 4 photo paths', async () => {
    const u = await createUser(testPrisma);
    const res = await submit(u.accessToken);
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('pending');

    const dp = await testPrisma.driverProfile.findUnique({ where: { userId: u.id } });
    expect(dp).not.toBeNull();
    expect(dp!.verificationStatus).toBe('pending');
    expect(dp!.licensePhotoPath).toMatch(/^driver_license\//);
    expect(dp!.selfiePath).toMatch(/^selfie\//);
  });

  it('rejects a document photo below 800×600 — TZ §9.1', async () => {
    const u = await createUser(testPrisma);
    const res = await request(app)
      .post('/v1/drivers/verification')
      .set('Authorization', `Bearer ${u.accessToken}`)
      .field('carMake', 'Toyota')
      .field('carModel', 'Camry')
      .field('carYear', '2015')
      .field('carColor', 'Белый')
      .field('carPlate', '02KG222BBB')
      .field('seatsCount', '4')
      .attach('license', smallJpegBuffer(), { filename: 'l.jpg', contentType: 'image/jpeg' })
      .attach('license_back', jpegBuffer(), { filename: 'lb.jpg', contentType: 'image/jpeg' })
      .attach('car_passport', jpegBuffer(), { filename: 'p.jpg', contentType: 'image/jpeg' })
      .attach('car_passport_back', jpegBuffer(), { filename: 'pb.jpg', contentType: 'image/jpeg' })
      .attach('car_photo', jpegBuffer(), { filename: 'c.jpg', contentType: 'image/jpeg' })
      .attach('selfie', jpegBuffer(), { filename: 's.jpg', contentType: 'image/jpeg' });
    expect(res.status).toBe(400);
    expect(res.body.error.details.reason).toBe('image_too_small');
    // No profile row should have been created.
    expect(await testPrisma.driverProfile.findUnique({ where: { userId: u.id } })).toBeNull();
  });

  it('accepts legacy plates, rejects garbage, normalizes lowercase new-format', async () => {
    // legacy plate = manual-entry escape hatch, still valid
    const a = await createUser(testPrisma);
    const legacy = await submit(a.accessToken, { carPlate: 'B1234AB' });
    expect(legacy.status).toBe(201);
    const c = await createUser(testPrisma);
    const bad = await submit(c.accessToken, { carPlate: 'A!1' });
    expect(bad.status).toBe(400);
    const b = await createUser(testPrisma);
    const ok = await submit(b.accessToken, { carPlate: '08kg 123 abc' });
    expect(ok.status).toBe(201);
    const dp = await testPrisma.driverProfile.findFirst({ where: { userId: b.id } });
    expect(dp?.carPlate).toBe('08KG123ABC');
  });

  it('rejects duplicate plate from another user', async () => {
    const a = await createUser(testPrisma);
    const b = await createUser(testPrisma);
    const first = await submit(a.accessToken, { carPlate: '03KG333CCC' });
    expect(first.status).toBe(201);
    const second = await submit(b.accessToken, { carPlate: '03KG333CCC' });
    expect(second.status).toBe(409);
    expect(second.body.error.details.reason).toBe('plate_taken');
  });

  it('rejects car year outside 1980..current+1', async () => {
    const u = await createUser(testPrisma);
    const res = await submit(u.accessToken, { carYear: '1950' });
    expect(res.status).toBe(400);
  });

  it('rejects seats count > 7', async () => {
    const u = await createUser(testPrisma);
    const res = await submit(u.accessToken, { seatsCount: '12' });
    expect(res.status).toBe(400);
  });

  it('rejects when car_photo is missing', async () => {
    const u = await createUser(testPrisma);
    const res = await request(app)
      .post('/v1/drivers/verification')
      .set('Authorization', `Bearer ${u.accessToken}`)
      .field('carMake', 'Honda')
      .field('carModel', 'Civic')
      .field('carYear', '2018')
      .field('carColor', 'Чёрный')
      .field('carPlate', '04KG444DDD')
      .field('seatsCount', '4')
      .attach('license', jpegBuffer(), { filename: 'l.jpg', contentType: 'image/jpeg' })
      .attach('license_back', jpegBuffer(), { filename: 'lb.jpg', contentType: 'image/jpeg' })
      .attach('car_passport', jpegBuffer(), { filename: 'p.jpg', contentType: 'image/jpeg' })
      .attach('car_passport_back', jpegBuffer(), { filename: 'pb.jpg', contentType: 'image/jpeg' })
      .attach('selfie', jpegBuffer(), { filename: 's.jpg', contentType: 'image/jpeg' });
    expect(res.status).toBe(400);
    expect(res.body.error.details.field).toBe('car_photo');
  });

  it.each(['suspended', 'blocked'])(
    'a %s driver cannot resubmit (403 VERIFICATION_LOCKED, status unchanged)',
    async (status) => {
      const u = await createUser(testPrisma);
      expect((await submit(u.accessToken, { carPlate: `07KG${status.length}11AAA` })).status).toBe(201);
      await testPrisma.driverProfile.update({ where: { userId: u.id }, data: { verificationStatus: status } });
      const res = await submit(u.accessToken, { carPlate: `07KG${status.length}11AAA` });
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('VERIFICATION_LOCKED');
      expect(res.body.error.message_kg).toBeTruthy();
      const dp = await testPrisma.driverProfile.findUniqueOrThrow({ where: { userId: u.id } });
      expect(dp.verificationStatus).toBe(status);
    },
  );
});

describe('GET /v1/drivers/verification/status', () => {
  it('returns "none" when no profile exists', async () => {
    const u = await createUser(testPrisma);
    const res = await request(app)
      .get('/v1/drivers/verification/status')
      .set('Authorization', `Bearer ${u.accessToken}`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('none');
    expect(res.body.car).toBeNull();
  });

  it('returns full profile after submission', async () => {
    const u = await createUser(testPrisma);
    await submit(u.accessToken, { carPlate: '05KG555EEE' });
    const res = await request(app)
      .get('/v1/drivers/verification/status')
      .set('Authorization', `Bearer ${u.accessToken}`);
    expect(res.body.status).toBe('pending');
    expect(res.body.car.plate).toBe('05KG555EEE');
  });
});

describe('POST /v1/drivers/verification/upload (after docs_requested)', () => {
  it('allows re-upload only for requested categories; flips status when list empties', async () => {
    const u = await createUser(testPrisma);
    await submit(u.accessToken, { carPlate: '06KG666FFF' });

    // Simulate admin flipping to docs_requested
    await testPrisma.driverProfile.update({
      where: { userId: u.id },
      data: {
        verificationStatus: 'docs_requested',
        requestedDocs: { set: ['license'] },
      },
    });

    // Wrong category — 400
    const wrong = await request(app)
      .post('/v1/drivers/verification/upload?category=selfie')
      .set('Authorization', `Bearer ${u.accessToken}`)
      .attach('file', jpegBuffer(), { filename: 's.jpg', contentType: 'image/jpeg' });
    expect(wrong.status).toBe(400);

    // Right category — 200, status flips back to pending because list became empty
    const ok = await request(app)
      .post('/v1/drivers/verification/upload?category=license')
      .set('Authorization', `Bearer ${u.accessToken}`)
      .attach('file', jpegBuffer(), { filename: 'l.jpg', contentType: 'image/jpeg' });
    expect(ok.status).toBe(200);
    expect(ok.body.status).toBe('pending');

    const dp = await testPrisma.driverProfile.findUnique({ where: { userId: u.id } });
    expect(dp!.verificationStatus).toBe('pending');
    expect(dp!.requestedDocs).toEqual([]);
  });

  it('rejects re-upload when not in docs_requested state', async () => {
    const u = await createUser(testPrisma);
    await submit(u.accessToken);
    const res = await request(app)
      .post('/v1/drivers/verification/upload?category=license')
      .set('Authorization', `Bearer ${u.accessToken}`)
      .attach('file', jpegBuffer(), { filename: 'l.jpg', contentType: 'image/jpeg' });
    expect(res.status).toBe(409);
  });
});

describe('GET /v1/drivers/me/stats', () => {
  it('403 for users without the driver role', async () => {
    const u = await createUser(testPrisma);
    const res = await request(app)
      .get('/v1/drivers/me/stats')
      .set('Authorization', `Bearer ${u.accessToken}`);
    expect(res.status).toBe(403);
  });

  it('returns totals for verified driver', async () => {
    const u = await createUser(testPrisma, { roles: ['passenger', 'driver'] });
    await submit(u.accessToken, { carPlate: '07KG777GGG' });
    await testPrisma.driverProfile.update({
      where: { userId: u.id },
      data: { verificationStatus: 'verified', totalTrips: 12, cancellations30d: 1 },
    });

    const res = await request(app)
      .get('/v1/drivers/me/stats')
      .set('Authorization', `Bearer ${u.accessToken}`);
    expect(res.status).toBe(200);
    expect(res.body.totalTrips).toBe(12);
    expect(res.body.cancellations30d).toBe(1);
  });
});

describe('POST /v1/drivers/verification — image type validation (§9.1/§9.3)', () => {
  // Only image/jpeg and image/png are accepted; MIME + magic bytes are both
  // checked (a client can lie about Content-Type).
  const validPhotos = (req: request.Test) =>
    req
      .field('carMake', 'Toyota')
      .field('carModel', 'Camry')
      .field('carYear', '2015')
      .field('carColor', 'Белый')
      .field('carPlate', '01KG777ZZZ')
      .field('seatsCount', '4')
      .attach('license_back', jpegBuffer(), { filename: 'lb.jpg', contentType: 'image/jpeg' })
      .attach('car_passport', jpegBuffer(), { filename: 'p.jpg', contentType: 'image/jpeg' })
      .attach('car_passport_back', jpegBuffer(), { filename: 'pb.jpg', contentType: 'image/jpeg' })
      .attach('car_photo', jpegBuffer(), { filename: 'c.jpg', contentType: 'image/jpeg' })
      .attach('selfie', jpegBuffer(), { filename: 's.jpg', contentType: 'image/jpeg' });

  it('rejects an unsupported content-type (application/pdf → 400 unsupported_mime)', async () => {
    const u = await createUser(testPrisma);
    const res = await validPhotos(
      request(app).post('/v1/drivers/verification').set('Authorization', `Bearer ${u.accessToken}`),
    ).attach('license', Buffer.from('%PDF-1.4 not an image'), { filename: 'l.pdf', contentType: 'application/pdf' });

    expect(res.status).toBe(400);
    expect(res.body.error.details.reason).toBe('unsupported_mime');
    expect(await testPrisma.driverProfile.findUnique({ where: { userId: u.id } })).toBeNull();
  });

  it('rejects a file that lies about being a JPEG (magic-byte check)', async () => {
    const u = await createUser(testPrisma);
    const res = await validPhotos(
      request(app).post('/v1/drivers/verification').set('Authorization', `Bearer ${u.accessToken}`),
    ).attach('license', Buffer.from('this is plain text pretending to be a jpeg'), {
      filename: 'l.jpg',
      contentType: 'image/jpeg',
    });

    expect(res.status).toBe(400);
    // Passes the MIME filter but fails on the bytes — either check is a valid reject.
    expect(['bad_magic_bytes', 'unreadable_image_dimensions']).toContain(res.body.error.details.reason);
    expect(await testPrisma.driverProfile.findUnique({ where: { userId: u.id } })).toBeNull();
  });
});
