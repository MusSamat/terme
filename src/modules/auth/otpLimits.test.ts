import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { testPrisma } from '../../../tests/setup.js';
import { createApp } from '@/server.js';
import { env } from '@/config/env.js';
import { clearSentMessages } from '@/lib/otpCapture.js';

// H1 (OTP cost: per-IP caps, global + foreign daily budgets) and M5 (daily cap
// per (phone, ip) with a per-phone ceiling, verify limiter per (phone, ip)).

let app: Express;
const saved = { ...env };

beforeEach(() => {
  app = createApp(testPrisma);
  clearSentMessages();
});

afterEach(() => {
  env.RATE_LIMIT_DISABLED = saved.RATE_LIMIT_DISABLED;
  env.OTP_GLOBAL_DAILY_CAP = saved.OTP_GLOBAL_DAILY_CAP;
  env.OTP_FOREIGN_DAILY_CAP = saved.OTP_FOREIGN_DAILY_CAP;
});

async function seedOtps(phone: string, n: number, ip: (i: number) => string | null): Promise<void> {
  await testPrisma.otpCode.createMany({
    data: Array.from({ length: n }, (_, i) => ({
      phone,
      codeHash: 'seed',
      expiresAt: new Date(Date.now() + 60_000),
      createdAt: new Date(Date.now() - 120_000 - i * 1000),
      requestIp: ip(i),
    })),
  });
}

function send(phone: string, ip: string) {
  return request(app).post('/v1/auth/phone/send-otp').set('X-Forwarded-For', ip).send({ phone });
}

describe('OTP send — per (phone, ip) daily cap + per-phone ceiling (M5)', () => {
  it("a stranger burning 5 codes from another IP doesn't lock the owner out", async () => {
    const phone = '+996700100001';
    await seedOtps(phone, 5, () => '10.2.0.1');
    const res = await send(phone, '10.2.0.2');
    expect(res.status).toBe(200);
  });

  it('stops at the absolute per-phone ceiling across IPs', async () => {
    const phone = '+996700100002';
    await seedOtps(phone, env.OTP_PHONE_DAILY_CEILING, (i) => `10.3.0.${i}`);
    const res = await send(phone, '10.3.1.1');
    expect(res.status).toBe(429);
    expect(res.body.error.details.bucket).toBe('otp_send_day_phone');
  });
});

describe('OTP send — daily budgets (H1)', () => {
  it('503 OTP_BUDGET_EXCEEDED once the global daily budget is spent', async () => {
    env.OTP_GLOBAL_DAILY_CAP = 3;
    await seedOtps('+996700100003', 3, () => '10.4.0.1');
    const res = await send('+996700100004', '10.4.0.2');
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('OTP_BUDGET_EXCEEDED');
    expect(res.body.error.details.scope).toBe('global');
    expect(await testPrisma.otpCode.count({ where: { phone: '+996700100004' } })).toBe(0);
  });

  it('foreign numbers have their own lower budget; +996 is unaffected', async () => {
    env.OTP_FOREIGN_DAILY_CAP = 2;
    await seedOtps('+77011234567', 2, () => '10.5.0.1');
    const foreign = await send('+77019999999', '10.5.0.2');
    expect(foreign.status).toBe(503);
    expect(foreign.body.error.details.scope).toBe('foreign');
    const local = await send('+996700100005', '10.5.0.3');
    expect(local.status).toBe(200);
  });
});

describe('OTP route limiters (H1/M5)', () => {
  it('caps OTP sends per IP per hour regardless of phone', async () => {
    env.RATE_LIMIT_DISABLED = false;
    const ip = '10.6.0.1';
    for (let i = 0; i < env.OTP_IP_HOURLY_CAP; i += 1) {
      const ok = await send(`+99670020000${i}`, ip);
      expect(ok.status).toBe(200);
    }
    const blocked = await send('+996700209999', ip);
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.details.bucket).toBe('otp_send_ip_hour');
    // Another IP is unaffected.
    expect((await send('+996700209998', '10.6.0.2')).status).toBe(200);
  });

  it('verify limiter is keyed on (phone, ip): one IP spamming does not block another', async () => {
    env.RATE_LIMIT_DISABLED = false;
    const phone = '+996700300001';
    const verify = (ip: string) =>
      request(app)
        .post('/v1/auth/phone/verify')
        .set('X-Forwarded-For', ip)
        .send({ phone, code: '000000' });
    for (let i = 0; i < 5; i += 1) await verify('10.7.0.1');
    const blocked = await verify('10.7.0.1');
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.details.bucket).toBe('otp_verify');
    const other = await verify('10.7.0.2');
    expect(other.body.error.details?.bucket).not.toBe('otp_verify');
  });
});
