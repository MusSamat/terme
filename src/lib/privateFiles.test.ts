import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import request from 'supertest';
import { testPrisma } from '../../tests/setup.js';
import { createApp } from '@/server.js';
import { env } from '@/config/env.js';
import { toFileUrl } from './uploads.js';

// KYC documents and complaint evidence are served only by signed, expiring URL.
const DOC = 'selfie/2026/10/test-private.jpg';
const AVATAR = 'avatars/2026/10/test-public.jpg';
const app = () => createApp(testPrisma);

beforeAll(async () => {
  for (const rel of [DOC, AVATAR]) {
    await fs.mkdir(path.join(env.FILES_DIR, path.dirname(rel)), { recursive: true });
    await fs.writeFile(path.join(env.FILES_DIR, rel), Buffer.from([0xff, 0xd8, 0xff, 0xe0]));
  }
});
afterAll(async () => {
  for (const rel of [DOC, AVATAR]) await fs.rm(path.join(env.FILES_DIR, rel), { force: true });
});

const pathOf = (url: string) => url.slice(env.BASE_URL.length);

describe('private uploads', () => {
  it('a document without a signature is 404; its signed URL works', async () => {
    expect((await request(app()).get(`/${DOC}`)).status).toBe(404);
    const signed = toFileUrl(DOC)!;
    expect(signed).toMatch(/\?exp=\d+&sig=/);
    const ok = await request(app()).get(pathOf(signed));
    expect(ok.status).toBe(200);
    expect(ok.headers['cache-control']).toContain('no-store');
  });

  it('rejects a tampered or expired signature', async () => {
    const signed = toFileUrl(DOC)!;
    expect((await request(app()).get(pathOf(signed).replace(/sig=./, 'sig=x'))).status).toBe(404);
    expect((await request(app()).get(`/${DOC}?exp=1&sig=abc`)).status).toBe(404);
  });

  it('avatars stay public', async () => {
    expect(toFileUrl(AVATAR)).toBe(`${env.BASE_URL}/${AVATAR}`);
    expect((await request(app()).get(`/${AVATAR}`)).status).toBe(200);
  });
});
