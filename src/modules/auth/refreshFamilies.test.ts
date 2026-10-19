import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { testPrisma } from '../../../tests/setup.js';
import { createApp } from '@/server.js';
import { env } from '@/config/env.js';
import { NoopNotifier } from '@/lib/notifier.js';
import { generateUuid, sha256Hex } from '@/lib/random.js';
import { refreshTtlSeconds, signRefreshToken } from '@/lib/jwt.js';
import { createUser } from '../../../tests/factories.js';

// H4: refresh-token families — rotation inherits the family, replays outside
// the grace window are classified (revoked / benign / real reuse), and
// REFRESH_REUSE_MODE=log only logs what enforce would do.

let app: Express;
let notifier: NoopNotifier;
const savedMode = env.REFRESH_REUSE_MODE;

beforeEach(() => {
  notifier = new NoopNotifier();
  app = createApp(testPrisma, notifier);
});
afterEach(() => {
  env.REFRESH_REUSE_MODE = savedMode;
});

const refresh = (refreshToken: string) => request(app).post('/v1/auth/refresh').send({ refreshToken });
const row = (token: string) =>
  testPrisma.refreshToken.findUniqueOrThrow({ where: { tokenHash: sha256Hex(token) } });

/** Pretend `token` was rotated long ago (outside the 60s grace window). */
async function ageRotation(token: string): Promise<void> {
  await testPrisma.refreshToken.update({
    where: { tokenHash: sha256Hex(token) },
    data: { usedAt: new Date(Date.now() - 5 * 60_000) },
  });
}

async function rotate(token: string): Promise<string> {
  const res = await refresh(token);
  expect(res.status).toBe(200);
  return res.body.refreshToken as string;
}

describe('refresh token families', () => {
  it('rotation inherits the family and links the successor', async () => {
    const u = await createUser(testPrisma);
    const r1 = await rotate(u.refreshToken);
    const [old, next] = await Promise.all([row(u.refreshToken), row(r1)]);
    expect(next.familyId).toBe(old.familyId);
    expect(old.replacedById).toBe(next.id);
    expect(old.usedAt).not.toBeNull();
  });

  it('a replay inside the grace window returns the same pair', async () => {
    const u = await createUser(testPrisma);
    const first = await refresh(u.refreshToken);
    const again = await refresh(u.refreshToken);
    expect(again.status).toBe(200);
    expect(again.body.refreshToken).toBe(first.body.refreshToken);
  });

  it('a revoked-but-unused token (logout) → 401 refresh_revoked, no alarm', async () => {
    env.REFRESH_REUSE_MODE = 'enforce';
    const u = await createUser(testPrisma);
    await request(app).post('/v1/auth/logout').send({ refreshToken: u.refreshToken });
    const res = await refresh(u.refreshToken);
    expect(res.status).toBe(401);
    expect(res.body.error.details.reason).toBe('refresh_revoked');
    expect(notifier.findForUser(u.id, 'security_alert_reuse')).toHaveLength(0);
  });

  it('enforce: stale replay with an unused successor is benign — successor revoked, no alarm', async () => {
    env.REFRESH_REUSE_MODE = 'enforce';
    const u = await createUser(testPrisma);
    const r1 = await rotate(u.refreshToken);
    await ageRotation(u.refreshToken);
    const res = await refresh(u.refreshToken);
    expect(res.status).toBe(401);
    expect(res.body.error.details.reason).toBe('refresh_rotated');
    expect((await row(r1)).revokedAt).not.toBeNull();
    expect(notifier.findForUser(u.id, 'security_alert_reuse')).toHaveLength(0);
  });

  it('enforce: replay after the successor was used revokes the family only + alert', async () => {
    env.REFRESH_REUSE_MODE = 'enforce';
    const u = await createUser(testPrisma);
    // A second device = a separate family that must survive.
    const other = await refresh(await createSecondSession(u.id));
    expect(other.status).toBe(200);

    const r1 = await rotate(u.refreshToken);
    const r2 = await rotate(r1);
    await ageRotation(u.refreshToken);
    const res = await refresh(u.refreshToken);
    expect(res.status).toBe(401);
    expect(res.body.error.details.code).toBe('TOKEN_REUSE_DETECTED');
    expect((await row(r2)).revokedAt).not.toBeNull();
    expect((await row(other.body.refreshToken)).revokedAt).toBeNull();
    expect(notifier.findForUser(u.id, 'security_alert_reuse')).toHaveLength(1);
  });

  it('log mode: the same reuse only rejects this token — nothing revoked, no alert', async () => {
    env.REFRESH_REUSE_MODE = 'log';
    const u = await createUser(testPrisma);
    const r1 = await rotate(u.refreshToken);
    const r2 = await rotate(r1);
    await ageRotation(u.refreshToken);
    const res = await refresh(u.refreshToken);
    expect(res.status).toBe(401);
    expect(res.body.error.details.reason).toBe('refresh_rotated');
    expect((await row(r2)).revokedAt).toBeNull();
    expect(notifier.findForUser(u.id, 'security_alert_reuse')).toHaveLength(0);
  });

  it('log mode: benign replay leaves the successor alive', async () => {
    env.REFRESH_REUSE_MODE = 'log';
    const u = await createUser(testPrisma);
    const r1 = await rotate(u.refreshToken);
    await ageRotation(u.refreshToken);
    expect((await refresh(u.refreshToken)).status).toBe(401);
    expect((await row(r1)).revokedAt).toBeNull();
  });
});

/** A second login of the same user (its own family). */
async function createSecondSession(userId: string): Promise<string> {
  const id = generateUuid();
  const token = signRefreshToken({ sub: userId, tokenId: id }, refreshTtlSeconds());
  await testPrisma.refreshToken.create({
    data: { id, userId, tokenHash: sha256Hex(token), expiresAt: new Date(Date.now() + 3600_000) },
  });
  return token;
}
