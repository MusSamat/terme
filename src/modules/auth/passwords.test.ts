import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcryptjs';
import type { Express } from 'express';
import { testPrisma } from '../../../tests/setup.js';
import { createApp } from '@/server.js';
import { createUser } from '../../../tests/factories.js';

// Web sign-in is phone + password; «forgot password» (and a first password for
// accounts created on mobile / in the bot) goes through a WhatsApp code.

let app: Express;
beforeEach(() => {
  app = createApp(testPrisma);
});

async function userWithPassword(phone: string, pw: string) {
  const u = await createUser(testPrisma, { phone });
  await testPrisma.user.update({ where: { id: u.id }, data: { passwordHash: await bcrypt.hash(pw, 4) } });
  return u;
}

async function seedOtp(phone: string, code: string): Promise<void> {
  await testPrisma.otpCode.create({
    data: { phone, codeHash: await bcrypt.hash(code, 4), expiresAt: new Date(Date.now() + 10 * 60_000) },
  });
}

const login = (phone: string, password: string) =>
  request(app).post('/v1/auth/phone/login').send({ phone, password, channel: 'web' });

describe('POST /v1/auth/phone/login (web)', () => {
  it('logs in with the right password, no WhatsApp code needed', async () => {
    await userWithPassword('+996700100100', 'secret123');
    const res = await login('+996700100100', 'secret123');
    expect(res.status).toBe(200);
    expect(res.body.accessToken).toBeTypeOf('string');
    expect(await testPrisma.otpCode.count()).toBe(0);
  });

  it('rejects a wrong password, an unknown phone and a passwordless account alike (401)', async () => {
    await userWithPassword('+996700100101', 'secret123');
    await createUser(testPrisma, { phone: '+996700100102' });
    for (const [phone, pw] of [
      ['+996700100101', 'wrong-pass1'],
      ['+996700100199', 'secret123'],
      ['+996700100102', 'secret123'],
    ] as const) {
      const res = await login(phone, pw);
      expect(res.status).toBe(401);
    }
  });

  it('check-phone tells the web client whether a password exists', async () => {
    await userWithPassword('+996700100103', 'secret123');
    await createUser(testPrisma, { phone: '+996700100104' });
    const a = await request(app).post('/v1/auth/check-phone').send({ phone: '+996700100103' });
    const b = await request(app).post('/v1/auth/check-phone').send({ phone: '+996700100104' });
    expect(a.body).toEqual({ exists: true, hasPassword: true });
    expect(b.body).toEqual({ exists: true, hasPassword: false });
  });
});

describe('POST /v1/auth/phone/reset-password (WhatsApp code)', () => {
  it('sets a new password and revokes every session', async () => {
    const u = await userWithPassword('+996700200200', 'oldpass12');
    await seedOtp('+996700200200', '123456');
    const res = await request(app)
      .post('/v1/auth/phone/reset-password')
      .send({ phone: '+996700200200', code: '123456', newPassword: 'newpass12' });
    expect(res.status).toBe(204);
    expect((await login('+996700200200', 'newpass12')).status).toBe(200);
    expect((await login('+996700200200', 'oldpass12')).status).toBe(401);
    const old = await testPrisma.refreshToken.findFirst({ where: { userId: u.id }, orderBy: { createdAt: 'asc' } });
    expect(old?.revokedAt).not.toBeNull();
  });

  it('gives a mobile-created (passwordless) account its first password', async () => {
    await createUser(testPrisma, { phone: '+996700200201' });
    await seedOtp('+996700200201', '123456');
    const res = await request(app)
      .post('/v1/auth/phone/reset-password')
      .send({ phone: '+996700200201', code: '123456', newPassword: 'first123' });
    expect(res.status).toBe(204);
    expect((await login('+996700200201', 'first123')).status).toBe(200);
  });

  it('rejects a wrong code and an unknown phone the same way (400 OTP_WRONG)', async () => {
    await userWithPassword('+996700200202', 'oldpass12');
    await seedOtp('+996700200202', '123456');
    const wrong = await request(app)
      .post('/v1/auth/phone/reset-password')
      .send({ phone: '+996700200202', code: '000000', newPassword: 'newpass12' });
    const unknown = await request(app)
      .post('/v1/auth/phone/reset-password')
      .send({ phone: '+996700200299', code: '123456', newPassword: 'newpass12' });
    expect(wrong.status).toBe(400);
    expect(unknown.status).toBe(400);
    expect(wrong.body.error.code).toBe('OTP_WRONG');
    expect(unknown.body.error.code).toBe('OTP_WRONG');
  });

  it('rejects a weak password (400 VALIDATION_ERROR)', async () => {
    const res = await request(app)
      .post('/v1/auth/phone/reset-password')
      .send({ phone: '+996700200203', code: '123456', newPassword: 'short' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });
});

describe('PATCH /v1/users/me/password', () => {
  it('changes the password with the correct current one', async () => {
    const u = await userWithPassword('+996700300300', 'oldpass12');
    const res = await request(app)
      .patch('/v1/users/me/password')
      .set('Authorization', `Bearer ${u.accessToken}`)
      .send({ currentPassword: 'oldpass12', newPassword: 'newpass12' });
    expect(res.status).toBe(200);
    expect(res.body.accessToken).toBeTruthy();
    expect((await login('+996700300300', 'newpass12')).status).toBe(200);
  });

  it('revokes every other session and returns a working fresh pair (M2)', async () => {
    const u = await userWithPassword('+996700300302', 'oldpass12');
    const res = await request(app)
      .patch('/v1/users/me/password')
      .set('Authorization', `Bearer ${u.accessToken}`)
      .send({ currentPassword: 'oldpass12', newPassword: 'newpass12' });
    expect(res.status).toBe(200);
    const old = await request(app).post('/v1/auth/refresh').send({ refreshToken: u.refreshToken });
    expect(old.status).toBe(401);
    const fresh = await request(app).post('/v1/auth/refresh').send({ refreshToken: res.body.refreshToken });
    expect(fresh.status).toBe(200);
  });

  it('web channel gets the new refresh token as an HttpOnly cookie, not in the body', async () => {
    const u = await userWithPassword('+996700300303', 'oldpass12');
    const res = await request(app)
      .patch('/v1/users/me/password')
      .set('Authorization', `Bearer ${u.accessToken}`)
      .send({ currentPassword: 'oldpass12', newPassword: 'newpass12', channel: 'web' });
    expect(res.status).toBe(200);
    expect(res.body.refreshToken).toBeUndefined();
    const cookies = ([] as string[]).concat(res.headers['set-cookie'] ?? []);
    expect(cookies.some((c) => c.startsWith('terme_rt=') && /HttpOnly/i.test(c))).toBe(true);
  });

  it('rejects a wrong current password (401) and requires auth (401)', async () => {
    const u = await userWithPassword('+996700300301', 'oldpass12');
    const wrong = await request(app)
      .patch('/v1/users/me/password')
      .set('Authorization', `Bearer ${u.accessToken}`)
      .send({ currentPassword: 'nope12345', newPassword: 'newpass12' });
    expect(wrong.status).toBe(401);
    const anon = await request(app)
      .patch('/v1/users/me/password')
      .send({ currentPassword: 'oldpass12', newPassword: 'newpass12' });
    expect(anon.status).toBe(401);
  });

  it('a passwordless account is told to use the WhatsApp reset (409 password_not_set)', async () => {
    const u = await createUser(testPrisma);
    const res = await request(app)
      .patch('/v1/users/me/password')
      .set('Authorization', `Bearer ${u.accessToken}`)
      .send({ currentPassword: 'whatever1', newPassword: 'newpass12' });
    expect(res.status).toBe(409);
  });
});
