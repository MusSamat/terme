import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcryptjs';
import type { Express } from 'express';
import { testPrisma } from '../../../tests/setup.js';
import { createApp } from '@/server.js';
import { createUser } from '../../../tests/factories.js';
import { NoopNotifier } from '@/lib/notifier.js';

// Change-password (POST /v1/users/me/password) and forgot/reset-password
// (POST /v1/auth/phone/reset-password). Both flows end with a real login
// round-trip so the test proves the new password actually works and the old
// one stops working — the invariant that matters to users.

let app: Express;

beforeEach(() => {
  app = createApp(testPrisma, new NoopNotifier());
});

async function seedOtp(phone: string, code: string): Promise<void> {
  await testPrisma.otpCode.create({
    data: { phone, codeHash: await bcrypt.hash(code, 4), expiresAt: new Date(Date.now() + 10 * 60_000) },
  });
}

/** Register a phone+password account and return its token + credentials. */
async function registerUser(phone: string, password: string) {
  await seedOtp(phone, '123456');
  const res = await request(app)
    .post('/v1/auth/register')
    .send({ phone, code: '123456', name: 'Тест', surname: 'Юзер', password });
  expect(res.status).toBe(201);
  return { token: res.body.accessToken as string, userId: res.body.user.id as string };
}

const login = (phone: string, password: string) =>
  request(app).post('/v1/auth/phone/login').send({ phone, password });

describe('POST /v1/users/me/password — change password', () => {
  const PHONE = '+996700200001';

  it('changes the password with the correct current one; new works, old fails', async () => {
    const { token } = await registerUser(PHONE, 'oldpass123');

    const res = await request(app)
      .patch('/v1/users/me/password')
      .set('Authorization', `Bearer ${token}`)
      .send({ currentPassword: 'oldpass123', newPassword: 'newpass456' });
    expect(res.status).toBe(204);

    expect((await login(PHONE, 'newpass456')).status).toBe(200);
    expect((await login(PHONE, 'oldpass123')).status).toBeGreaterThanOrEqual(400);
  });

  it('rejects a wrong current password (401 current_password_mismatch)', async () => {
    const { token } = await registerUser(PHONE, 'oldpass123');
    const res = await request(app)
      .patch('/v1/users/me/password')
      .set('Authorization', `Bearer ${token}`)
      .send({ currentPassword: 'WRONG', newPassword: 'newpass456' });
    expect(res.status).toBe(401);
    expect(res.body.error.details.reason).toBe('current_password_mismatch');
    // Password unchanged — the original still logs in.
    expect((await login(PHONE, 'oldpass123')).status).toBe(200);
  });

  it('requires the current password when one is already set (401)', async () => {
    const { token } = await registerUser(PHONE, 'oldpass123');
    const res = await request(app)
      .patch('/v1/users/me/password')
      .set('Authorization', `Bearer ${token}`)
      .send({ newPassword: 'newpass456' });
    expect(res.status).toBe(401);
    expect(res.body.error.details.reason).toBe('current_password_required');
  });

  it('first-time set: a passwordless (Telegram) user sets one without a current password', async () => {
    const u = await createUser(testPrisma, { phone: PHONE }); // no passwordHash
    const res = await request(app)
      .patch('/v1/users/me/password')
      .set('Authorization', `Bearer ${u.accessToken}`)
      .send({ newPassword: 'brandnew123' });
    expect(res.status).toBe(204);

    const row = await testPrisma.user.findUnique({ where: { id: u.id } });
    expect(await bcrypt.compare('brandnew123', row!.passwordHash!)).toBe(true);
  });

  it('rejects a too-short new password (400 VALIDATION_ERROR)', async () => {
    const { token } = await registerUser(PHONE, 'oldpass123');
    const res = await request(app)
      .patch('/v1/users/me/password')
      .set('Authorization', `Bearer ${token}`)
      .send({ currentPassword: 'oldpass123', newPassword: 'short' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('requires authentication (401 without a token)', async () => {
    const res = await request(app).patch('/v1/users/me/password').send({ newPassword: 'whatever12' });
    expect(res.status).toBe(401);
  });
});

describe('POST /v1/auth/phone/reset-password — forgot password (post-OTP)', () => {
  const PHONE = '+996700200002';

  it('sets a new password after a fresh OTP proof; the new one logs in', async () => {
    // M2: reset now requires a FRESH OTP proof (phone + code) for the caller's
    // own number, on top of the session token. Seed a valid OTP and pass it.
    const { token } = await registerUser(PHONE, 'forgotten1');
    await seedOtp(PHONE, '654321');

    const res = await request(app)
      .post('/v1/auth/phone/reset-password')
      .set('Authorization', `Bearer ${token}`)
      .send({ phone: PHONE, code: '654321', newPassword: 'recovered1' });
    expect(res.status).toBe(204);

    expect((await login(PHONE, 'recovered1')).status).toBe(200);
    expect((await login(PHONE, 'forgotten1')).status).toBeGreaterThanOrEqual(400);
  });

  it('rejects a too-short password (400 VALIDATION_ERROR)', async () => {
    const { token } = await registerUser(PHONE, 'forgotten1');
    const res = await request(app)
      .post('/v1/auth/phone/reset-password')
      .set('Authorization', `Bearer ${token}`)
      .send({ newPassword: 'abc' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('requires authentication (401 without a token)', async () => {
    const res = await request(app).post('/v1/auth/phone/reset-password').send({ newPassword: 'recovered1' });
    expect(res.status).toBe(401);
  });
});
