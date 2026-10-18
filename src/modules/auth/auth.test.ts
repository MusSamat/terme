import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcryptjs';
import type { Express } from 'express';
import { testPrisma } from '../../../tests/setup.js';
import { createApp } from '@/server.js';
import { linkTelegramContact } from '@/modules/auth/auth.otp.js';
import { clearSentMessages, getSentMessages } from '@/lib/otpCapture.js';
import { createUser } from '../../../tests/factories.js';

let app: Express;

beforeEach(() => {
  app = createApp(testPrisma);
  clearSentMessages();
});

describe('POST /v1/auth/check-phone', () => {
  it('reports whether an account exists for the phone', async () => {
    await createUser(testPrisma, { phone: '+996700111222' });
    const known = await request(app).post('/v1/auth/check-phone').send({ phone: '+996700111222' });
    expect(known.status).toBe(200);
    expect(known.body).toEqual({ exists: true, hasPassword: false });
    const unknown = await request(app).post('/v1/auth/check-phone').send({ phone: '+996700999888' });
    expect(unknown.body).toEqual({ exists: false, hasPassword: false });
  });

  it('rejects a malformed phone with 400', async () => {
    const res = await request(app).post('/v1/auth/check-phone').send({ phone: '0700' });
    expect(res.status).toBe(400);
  });
});

describe('POST /v1/auth/phone/send-otp', () => {
  it('creates an otp_codes row and captures a mock SMS', async () => {
    const res = await request(app)
      .post('/v1/auth/phone/send-otp')
      .send({ phone: '+996700111222' });

    expect(res.status).toBe(200);
    // v2.1 §7.6: OTP TTL is now 10 minutes.
    expect(res.body.expiresInSec).toBe(600);

    const otps = await testPrisma.otpCode.findMany({ where: { phone: '+996700111222' } });
    expect(otps).toHaveLength(1);
    expect(otps[0]!.attempts).toBe(0);
    expect(getSentMessages()).toHaveLength(1);
    expect(getSentMessages()[0]!.phone).toBe('+996700111222');
  });

  it('rejects a malformed phone with 400', async () => {
    const res = await request(app).post('/v1/auth/phone/send-otp').send({ phone: '996700111222' });
    expect(res.status).toBe(400);
  });

  it('enforces 1-minute gap per phone (service-level)', async () => {
    await request(app).post('/v1/auth/phone/send-otp').send({ phone: '+996700111222' });
    const second = await request(app)
      .post('/v1/auth/phone/send-otp')
      .send({ phone: '+996700111222' });
    expect(second.status).toBe(429);
  });

  it('blocks after 5 SMS in 24 hours (daily cap)', async () => {
    const phone = '+996700999888';
    // Seed 5 existing OTP rows so the cap is already reached before this test.
    for (let i = 0; i < 5; i += 1) {
      await testPrisma.otpCode.create({
        data: {
          phone,
          codeHash: 'seed',
          expiresAt: new Date(Date.now() + 60_000),
          createdAt: new Date(Date.now() - 60_001 - i * 1000), // >1 min apart
        },
      });
    }
    const res = await request(app).post('/v1/auth/phone/send-otp').send({ phone });
    expect(res.status).toBe(429);
    expect(res.body.error.details.bucket).toBe('otp_send_day');
  });
});

describe('POST /v1/auth/phone/verify', () => {
  async function seedOtp(phone: string, code: string): Promise<void> {
    const codeHash = await bcrypt.hash(code, 4);
    await testPrisma.otpCode.create({
      data: { phone, codeHash, expiresAt: new Date(Date.now() + 5 * 60_000) },
    });
  }

  it('verifies the code and returns tokens + user', async () => {
    const phone = '+996700123456';
    await createUser(testPrisma, { phone });
    await seedOtp(phone, '123456');

    const res = await request(app)
      .post('/v1/auth/phone/verify')
      .send({ phone, code: '123456', channel: 'mobile' });

    expect(res.status).toBe(200);
    expect(res.body.accessToken).toBeTypeOf('string');
    expect(res.body.user.phone).toBe(phone);
    expect(res.body.user.phoneVerified).toBe(true);

    const dbUser = await testPrisma.user.findFirst({ where: { phone } });
    expect(dbUser).not.toBeNull();
    expect(dbUser!.phoneVerifiedAt).not.toBeNull();
  });

  it('does not create nameless accounts: unknown phone → 404 (use /register)', async () => {
    const phone = '+996700123457';
    await seedOtp(phone, '123456');
    const res = await request(app).post('/v1/auth/phone/verify').send({ phone, code: '123456' });
    expect(res.status).toBe(404);
    expect(await testPrisma.user.count({ where: { phone } })).toBe(0);
  });

  it('rejects an expired OTP with OTP_EXPIRED (410)', async () => {
    const phone = '+996700000001';
    const codeHash = await bcrypt.hash('111111', 4);
    await testPrisma.otpCode.create({
      data: { phone, codeHash, expiresAt: new Date(Date.now() - 1000) },
    });

    const res = await request(app)
      .post('/v1/auth/phone/verify')
      .send({ phone, code: '111111' });

    expect(res.status).toBe(410);
    expect(res.body.error.code).toBe('OTP_EXPIRED');
  });

  it('counts attempts and blocks after 5 wrong codes (brute-force)', async () => {
    const phone = '+996700555666';
    await seedOtp(phone, '999999');

    for (let i = 0; i < 5; i += 1) {
      const r = await request(app)
        .post('/v1/auth/phone/verify')
        .send({ phone, code: '000000' });
      expect(r.status).toBe(400); // OTP_WRONG
    }
    const sixth = await request(app)
      .post('/v1/auth/phone/verify')
      .send({ phone, code: '999999' });
    expect(sixth.status).toBe(429);
    expect(sixth.body.error.code).toBe('OTP_TOO_MANY_ATTEMPTS');
  });

  it('does not allow the same OTP to be reused after success', async () => {
    const phone = '+996700444444';
    await createUser(testPrisma, { phone });
    await seedOtp(phone, '424242');

    const first = await request(app)
      .post('/v1/auth/phone/verify')
      .send({ phone, code: '424242' });
    expect(first.status).toBe(200);

    // Second attempt with the same code should fail — OTP is marked used.
    const second = await request(app)
      .post('/v1/auth/phone/verify')
      .send({ phone, code: '424242' });
    expect(second.status).toBe(400);
    expect(second.body.error.code).toBe('OTP_WRONG');
  });
});

describe('POST /v1/auth/refresh (rotation)', () => {
  async function registerViaOtp(phone: string): Promise<{
    access: string;
    refresh: string;
  }> {
    await createUser(testPrisma, { phone });
    const code = '654321';
    const codeHash = await bcrypt.hash(code, 4);
    await testPrisma.otpCode.create({
      data: { phone, codeHash, expiresAt: new Date(Date.now() + 5 * 60_000) },
    });
    const res = await request(app).post('/v1/auth/phone/verify').send({ phone, code });
    return { access: res.body.accessToken, refresh: res.body.refreshToken };
  }

  it('rotates: new pair; grace-retry returns the same pair; later reuse is rejected', async () => {
    const tokens = await registerViaOtp('+996700777000');
    const refreshRes = await request(app)
      .post('/v1/auth/refresh')
      .send({ refreshToken: tokens.refresh, channel: 'mobile' });

    expect(refreshRes.status).toBe(200);
    expect(refreshRes.body.accessToken).toBeTypeOf('string');
    expect(refreshRes.body.refreshToken).not.toBe(tokens.refresh);

    // Within the 60s grace window a replay is a legit client retry → same pair,
    // no logout (this is what prevents false logouts on app restart/retry).
    const grace = await request(app)
      .post('/v1/auth/refresh')
      .send({ refreshToken: tokens.refresh, channel: 'mobile' });
    expect(grace.status).toBe(200);
    expect(grace.body.refreshToken).toBe(refreshRes.body.refreshToken);

    // Age the rotated token past the grace window → a replay is real reuse → 401.
    await testPrisma.refreshToken.updateMany({
      where: { usedAt: { not: null } },
      data: { usedAt: new Date(Date.now() - 2 * 60_000) },
    });
    const replay = await request(app)
      .post('/v1/auth/refresh')
      .send({ refreshToken: tokens.refresh, channel: 'mobile' });
    expect(replay.status).toBe(401);
  });

  it('rejects a refresh token whose stored row was revoked', async () => {
    const tokens = await registerViaOtp('+996700777111');
    // Revoke all refresh tokens for this user.
    await testPrisma.refreshToken.updateMany({
      where: { revokedAt: null },
      data: { revokedAt: new Date() },
    });
    const res = await request(app)
      .post('/v1/auth/refresh')
      .send({ refreshToken: tokens.refresh });
    expect(res.status).toBe(401);
  });
});

describe('POST /v1/auth/logout', () => {
  it('revokes the refresh token (idempotent)', async () => {
    const code = '111111';
    const phone = '+996700222111';
    await createUser(testPrisma, { phone });
    const codeHash = await bcrypt.hash(code, 4);
    await testPrisma.otpCode.create({
      data: { phone, codeHash, expiresAt: new Date(Date.now() + 5 * 60_000) },
    });
    const loginRes = await request(app).post('/v1/auth/phone/verify').send({ phone, code });
    const refreshToken = loginRes.body.refreshToken;

    const out = await request(app).post('/v1/auth/logout').send({ refreshToken });
    expect(out.status).toBe(204);

    const row = await testPrisma.refreshToken.findFirst({ where: { userId: loginRes.body.user.id }, orderBy: { createdAt: 'desc' } });
    expect(row!.revokedAt).not.toBeNull();
  });
});

describe('POST /v1/auth/admin/login', () => {
  it('accepts valid email + password, rejects wrong password', async () => {
    const passwordHash = await bcrypt.hash('S3cretPass!', 4);
    await testPrisma.admin.create({
      data: { email: 'ops@terme.kg', passwordHash, name: 'Ops', role: 'admin' },
    });

    const ok = await request(app)
      .post('/v1/auth/admin/login')
      .send({ email: 'ops@terme.kg', password: 'S3cretPass!' });
    expect(ok.status).toBe(200);
    expect(ok.body.admin.role).toBe('admin');

    const bad = await request(app)
      .post('/v1/auth/admin/login')
      .send({ email: 'ops@terme.kg', password: 'wrong-one' });
    expect(bad.status).toBe(401);
  });

  it('does not leak whether email exists (timing-safe-ish)', async () => {
    const res = await request(app)
      .post('/v1/auth/admin/login')
      .send({ email: 'ghost@nowhere.kg', password: 'whatever123' });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });
});

describe('GET /health', () => {
  it('returns 200 when DB is reachable', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.checks.db).toBe('ok');
  });
});

describe('POST /v1/auth/logout/all', () => {
  it('revokes every refresh token of the user', async () => {
    const u = await createUser(testPrisma);
    await createUser(testPrisma);
    const res = await request(app)
      .post('/v1/auth/logout/all')
      .set('Authorization', `Bearer ${u.accessToken}`);
    expect(res.status).toBe(204);
    const live = await testPrisma.refreshToken.count({ where: { userId: u.id, revokedAt: null } });
    expect(live).toBe(0);
  });
});

describe('Phone change (session + WhatsApp code to the new number)', () => {
  it('start → code to new number → confirm swaps the phone and revokes other sessions', async () => {
    const u = await createUser(testPrisma, { phone: '+996700300300' });
    const start = await request(app)
      .patch('/v1/users/me/phone')
      .set('Authorization', `Bearer ${u.accessToken}`)
      .send({ newPhone: '+996700400400' });
    expect(start.status).toBe(200);
    const msg = getSentMessages().find((m) => m.phone === '+996700400400');
    const code = /(\d{6})/.exec(msg!.text)![1]!;

    const confirm = await request(app)
      .patch('/v1/users/me/phone/confirm')
      .set('Authorization', `Bearer ${u.accessToken}`)
      .send({ newPhone: '+996700400400', code });
    expect(confirm.status).toBe(200);
    expect(confirm.body.user.phone).toBe('+996700400400');
    expect(await testPrisma.refreshToken.count({ where: { userId: u.id, revokedAt: null } })).toBe(1);
  });

  it('refuses a number that already belongs to another account (409)', async () => {
    await createUser(testPrisma, { phone: '+996700500500' });
    const u = await createUser(testPrisma);
    const res = await request(app)
      .patch('/v1/users/me/phone')
      .set('Authorization', `Bearer ${u.accessToken}`)
      .send({ newPhone: '+996700500500' });
    expect(res.status).toBe(409);
  });

  it('requires a session (401)', async () => {
    const res = await request(app).patch('/v1/users/me/phone').send({ newPhone: '+996700600600' });
    expect(res.status).toBe(401);
  });
});

describe('Telegram bot sign-in via shared contact (linkTelegramContact)', () => {
  it('creates a verified account for a new number', async () => {
    const res = await linkTelegramContact(testPrisma, 555001, '996700123123', 'Айбек', 'ky');
    expect(res.status).toBe('ok');
    const u = await testPrisma.user.findFirst({ where: { telegramId: 555001n } });
    expect(u?.phone).toBe('+996700123123');
    expect(u?.phoneVerifiedAt).not.toBeNull();
    expect(u?.language).toBe('kg');
    expect(u?.name).toBe('Айбек');
  });

  it('links Telegram to the EXISTING web/mobile account of that number', async () => {
    const existing = await createUser(testPrisma, { phone: '+996700222333' });
    const res = await linkTelegramContact(testPrisma, 666002, '+996700222333', 'Y', 'ru');
    expect(res).toEqual({ status: 'ok', userId: existing.id, created: false });
    expect(await testPrisma.user.count()).toBe(1);
  });

  it('moves the Telegram id from a stale account to the phone owner', async () => {
    const stale = await createUser(testPrisma, { phone: '+996700777001', telegramId: 777n });
    const owner = await createUser(testPrisma, { phone: '+996700777002' });
    await linkTelegramContact(testPrisma, 777, '996700777002', 'Z', 'ru');
    expect((await testPrisma.user.findUnique({ where: { id: stale.id } }))?.telegramId).toBeNull();
    expect((await testPrisma.user.findUnique({ where: { id: owner.id } }))?.telegramId).toBe(777n);
  });

  it('refuses a blocked account', async () => {
    const u = await createUser(testPrisma, { phone: '+996700888001' });
    await testPrisma.user.update({ where: { id: u.id }, data: { isBlocked: true } });
    expect(await linkTelegramContact(testPrisma, 888, '996700888001', 'B', 'ru')).toEqual({ status: 'blocked' });
  });
});
