import { afterEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { testPrisma } from '../../../tests/setup.js';
import { createApp } from '@/server.js';
import { env } from '@/config/env.js';

// Webhook verification handshake: constant-time token compare, the echoed
// challenge is served as text/plain (never HTML).

const saved = env.WHATSAPP_VERIFY_TOKEN;
afterEach(() => {
  env.WHATSAPP_VERIFY_TOKEN = saved;
});

describe('GET /v1/whatsapp/webhook', () => {
  it('echoes the challenge as text/plain when the token matches', async () => {
    env.WHATSAPP_VERIFY_TOKEN = 'verify-me-123';
    const res = await request(createApp(testPrisma))
      .get('/v1/whatsapp/webhook')
      .query({ 'hub.mode': 'subscribe', 'hub.verify_token': 'verify-me-123', 'hub.challenge': '<b>42</b>' });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/plain/);
    expect(res.text).toBe('<b>42</b>');
  });

  it('403 on a wrong token (including a different length)', async () => {
    env.WHATSAPP_VERIFY_TOKEN = 'verify-me-123';
    const app = createApp(testPrisma);
    for (const t of ['verify-me-124', 'x']) {
      const res = await request(app)
        .get('/v1/whatsapp/webhook')
        .query({ 'hub.mode': 'subscribe', 'hub.verify_token': t, 'hub.challenge': '1' });
      expect(res.status).toBe(403);
    }
  });
});
