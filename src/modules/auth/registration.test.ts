import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcryptjs';
import type { Express } from 'express';
import { testPrisma } from '../../../tests/setup.js';
import { createApp } from '@/server.js';
import { NoopNotifier } from '@/lib/notifier.js';
import { createUser } from '../../../tests/factories.js';

// POST /v1/auth/register — phone + WhatsApp code + name/surname committed in one
// step (no account exists before the code is verified). Mobile sends no
// password; web sends one (its login method).

let app: Express;

beforeEach(() => {
  app = createApp(testPrisma, new NoopNotifier());
});

const PHONE = '+996700123456';
const VALID = { name: 'Мурат', surname: 'Осмонов' };

async function seedOtp(phone: string, code: string): Promise<void> {
  await testPrisma.otpCode.create({
    data: { phone, codeHash: await bcrypt.hash(code, 4), expiresAt: new Date(Date.now() + 10 * 60_000) },
  });
}

function register(body: Record<string, unknown>) {
  return request(app).post('/v1/auth/register').send(body);
}

describe('POST /v1/auth/register', () => {
  it('registers a new passenger and returns a full session', async () => {
    await seedOtp(PHONE, '123456');
    const res = await register({ phone: PHONE, code: '123456', ...VALID });
    expect(res.status).toBe(201);
    expect(res.body.kind).toBe('full');
    expect(res.body.accessToken).toBeTypeOf('string');
    expect(res.body.refreshToken).toBeTypeOf('string');
    expect(res.body.user).toMatchObject({
      phone: PHONE,
      name: 'Мурат',
      roles: ['passenger'],
      phoneVerified: true,
      telegramLinked: false,
    });
    const user = await testPrisma.user.findFirst({ where: { phone: PHONE } });
    expect(user!.surname).toBe('Осмонов');
    expect(user!.termsAcceptedAt).not.toBeNull();
  });

  it('web registration stores a bcrypt password that then logs in', async () => {
    await seedOtp(PHONE, '123456');
    const res = await register({ phone: PHONE, code: '123456', ...VALID, password: 'secret123', channel: 'web' });
    expect(res.status).toBe(201);
    const user = await testPrisma.user.findFirst({ where: { phone: PHONE } });
    expect(user!.passwordHash).toMatch(/^\$2[aby]\$/);
    expect(res.body.user.passwordHash).toBeUndefined();
    const login = await request(app)
      .post('/v1/auth/phone/login')
      .send({ phone: PHONE, password: 'secret123', channel: 'web' });
    expect(login.status).toBe(200);
  });

  it('rejects a weak password (400)', async () => {
    await seedOtp(PHONE, '123456');
    expect((await register({ phone: PHONE, code: '123456', ...VALID, password: 'nodigits' })).status).toBe(400);
  });

  it('consumes the code — the same code cannot register twice', async () => {
    await seedOtp(PHONE, '123456');
    expect((await register({ phone: PHONE, code: '123456', ...VALID })).status).toBe(201);
    const again = await register({ phone: PHONE, code: '123456', ...VALID });
    expect(again.status).toBe(400);
    expect(again.body.error.code).toBe('OTP_WRONG');
  });

  it('rejects a wrong code with 400 OTP_WRONG', async () => {
    await seedOtp(PHONE, '123456');
    const res = await register({ phone: PHONE, code: '654321', ...VALID });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('OTP_WRONG');
    expect(await testPrisma.user.count()).toBe(0);
  });

  it('rejects when no code was ever requested', async () => {
    const res = await register({ phone: PHONE, code: '123456', ...VALID });
    expect(res.status).toBe(400);
  });

  it('rejects a malformed phone / missing name with 400 VALIDATION_ERROR', async () => {
    expect((await register({ phone: '0700', code: '123456', ...VALID })).status).toBe(400);
    expect((await register({ phone: PHONE, code: '123456', surname: 'X' })).status).toBe(400);
  });

  it('an existing number (e.g. created in the Telegram bot) completes its profile instead of duplicating', async () => {
    const existing = await createUser(testPrisma, { phone: PHONE, name: 'Telegram name' });
    await seedOtp(PHONE, '123456');
    const res = await register({ phone: PHONE, code: '123456', ...VALID });
    expect(res.status).toBe(201);
    expect(res.body.user.id).toBe(existing.id);
    expect(res.body.user.name).toBe('Мурат');
    expect(await testPrisma.user.count()).toBe(1);
  });
});
