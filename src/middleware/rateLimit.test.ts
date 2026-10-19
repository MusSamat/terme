import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { randomUUID } from 'node:crypto';
import { testPrisma } from '../../tests/setup.js';
import { createApp } from '@/server.js';
import { env } from '@/config/env.js';
import { logger } from '@/lib/logger.js';
import { createUser } from '../../tests/factories.js';

// Route limiters (M7 chat/uploads, M9 check-phone, public reads, view counter,
// export/delete) + the abuse.limit_hit log. Limits are switched on per test;
// each test uses its own client IP / user so the in-memory stores don't mix.

let app: Express;
const saved = { ...env };

beforeEach(() => {
  app = createApp(testPrisma);
  env.RATE_LIMIT_DISABLED = false;
});
afterEach(() => {
  env.RATE_LIMIT_DISABLED = saved.RATE_LIMIT_DISABLED;
  env.PUBLIC_READ_IP_PER_MIN = saved.PUBLIC_READ_IP_PER_MIN;
  env.PUBLIC_READ_USER_PER_MIN = saved.PUBLIC_READ_USER_PER_MIN;
  env.CHECK_PHONE_IP_DAILY_CAP = saved.CHECK_PHONE_IP_DAILY_CAP;
  vi.restoreAllMocks();
});

async function hitUntilLimited(
  send: () => request.Test,
  max: number,
): Promise<{ status: number; body: { error?: { details?: { bucket?: string } } } }> {
  let last = await send();
  for (let i = 1; i < max && last.status !== 429; i += 1) last = await send();
  return last;
}

describe('public read limiter', () => {
  it('anonymous: per IP; logs abuse.limit_hit on the 429', async () => {
    env.PUBLIC_READ_IP_PER_MIN = 3;
    const warn = vi.spyOn(logger, 'warn');
    const get = () => request(app).get('/v1/trips').set('X-Forwarded-For', '10.50.0.1');
    for (let i = 0; i < 3; i += 1) expect((await get()).status).toBe(200);
    const blocked = await get();
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.details.bucket).toBe('public_read');
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'abuse.limit_hit', limiter: 'public_read', ip: '10.50.0.1' }),
      'abuse.limit_hit',
    );
    // Another IP is unaffected.
    expect((await request(app).get('/v1/trips').set('X-Forwarded-For', '10.50.0.2')).status).toBe(200);
  });

  it('authenticated: keyed on the user, not the shared IP', async () => {
    env.PUBLIC_READ_USER_PER_MIN = 2;
    const a = await createUser(testPrisma);
    const b = await createUser(testPrisma);
    const get = (token: string) =>
      request(app).get('/v1/passenger-requests').set('X-Forwarded-For', '10.51.0.1').set('Authorization', `Bearer ${token}`);
    await get(a.accessToken);
    await get(a.accessToken);
    expect((await get(a.accessToken)).status).toBe(429);
    expect((await get(b.accessToken)).status).toBe(200);
  });
});

describe('write-path limiters', () => {
  it('REST chat send: 20/min per user', async () => {
    const u = await createUser(testPrisma);
    const res = await hitUntilLimited(
      () =>
        request(app)
          .post(`/v1/chats/${randomUUID()}/messages`)
          .set('Authorization', `Bearer ${u.accessToken}`)
          .send({ text: 'hi' }),
      21,
    );
    expect(res.status).toBe(429);
    expect(res.body.error?.details?.bucket).toBe('chat_send');
  });

  it('uploads: 30/h per user across upload routes', async () => {
    const u = await createUser(testPrisma);
    const res = await hitUntilLimited(
      () => request(app).post('/v1/users/avatar').set('Authorization', `Bearer ${u.accessToken}`),
      31,
    );
    expect(res.status).toBe(429);
    expect(res.body.error?.details?.bucket).toBe('upload');
  });

  it('data export: 5/h per user', async () => {
    const u = await createUser(testPrisma);
    const res = await hitUntilLimited(
      () => request(app).get('/v1/users/me/export').set('Authorization', `Bearer ${u.accessToken}`),
      6,
    );
    expect(res.status).toBe(429);
    expect(res.body.error?.details?.bucket).toBe('account_data');
  });

  it('anonymous view counter: 60/min per IP', async () => {
    const res = await hitUntilLimited(
      () => request(app).post(`/v1/trips/${randomUUID()}/view`).set('X-Forwarded-For', '10.52.0.1').send({}),
      61,
    );
    expect(res.status).toBe(429);
    expect(res.body.error?.details?.bucket).toBe('view_ip');
  });
});

describe('check-phone daily cap (M9)', () => {
  it('caps lookups per IP per day; response shape unchanged', async () => {
    env.CHECK_PHONE_IP_DAILY_CAP = 2;
    const check = () =>
      request(app).post('/v1/auth/check-phone').set('X-Forwarded-For', '10.53.0.1').send({ phone: '+996700555111' });
    const first = await check();
    expect(first.body).toEqual({ exists: false, hasPassword: false });
    await check();
    const blocked = await check();
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.details.bucket).toBe('check_phone_day');
  });
});
