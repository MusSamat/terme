import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { authenticator } from 'otplib';
import { testPrisma } from '../../../tests/setup.js';
import { createApp } from '@/server.js';
import { env } from '@/config/env.js';
import { encryptSecret, decryptSecret } from '@/lib/secretBox.js';
import { signAdminRefreshToken } from '@/lib/jwt.js';
import { superadminTempPasswordProblem } from '@/config/superadmin.js';
import { createAdmin } from '../../../tests/factories.js';

// H2 (admin TOTP enrolment, encrypted secret, replay guard, enrolment gating),
// M6 (email+IP lockout, token epoch on logout / password change), H3 guard.

let app: Express;
const PASSWORD = 'TestPass1234!';
const savedRequired = env.ADMIN_TOTP_REQUIRED;

beforeEach(() => {
  app = createApp(testPrisma);
});
afterEach(() => {
  env.ADMIN_TOTP_REQUIRED = savedRequired;
});

function codeAt(secret: string, offsetSec = 0): string {
  return authenticator.clone({ epoch: Date.now() + offsetSec * 1000 }).generate(secret);
}

function login(email: string, totp?: string, ip = '10.20.0.1') {
  return request(app)
    .post('/v1/auth/admin/login')
    .set('X-Forwarded-For', ip)
    .send({ email, password: PASSWORD, ...(totp ? { totp } : {}) });
}

async function enrolledAdmin(role: 'admin' | 'superadmin' = 'admin') {
  const a = await createAdmin(testPrisma, { role });
  const secret = authenticator.generateSecret();
  await testPrisma.admin.update({
    where: { id: a.id },
    data: { totpEnabled: true, totpSecretEnc: encryptSecret(secret) },
  });
  return { ...a, secret };
}

describe('secretBox', () => {
  it('round-trips and never stores the plaintext', () => {
    const blob = encryptSecret('JBSWY3DPEHPK3PXP');
    expect(blob).not.toContain('JBSWY3DPEHPK3PXP');
    expect(decryptSecret(blob)).toBe('JBSWY3DPEHPK3PXP');
  });

  it('rejects a tampered ciphertext', () => {
    const blob = encryptSecret('JBSWY3DPEHPK3PXP');
    const parts = blob.split('.');
    parts[3] = Buffer.from('tampered').toString('base64url');
    expect(() => decryptSecret(parts.join('.'))).toThrow();
  });
});

describe('admin TOTP enrolment', () => {
  it('setup → confirm enables TOTP, stores the secret encrypted, returns fresh tokens', async () => {
    const a = await createAdmin(testPrisma);
    const setup = await request(app)
      .post('/v1/auth/admin/totp/setup')
      .set('Authorization', `Bearer ${a.accessToken}`);
    expect(setup.status).toBe(200);
    expect(setup.body.otpauthUri).toMatch(/^otpauth:\/\/totp\//);
    const { secret } = setup.body as { secret: string };

    const bad = await request(app)
      .post('/v1/auth/admin/totp/confirm')
      .set('Authorization', `Bearer ${a.accessToken}`)
      .send({ code: codeAt(secret, 600) });
    expect(bad.status).toBe(400);
    expect(bad.body.error.details.reason).toBe('totp_invalid');

    const ok = await request(app)
      .post('/v1/auth/admin/totp/confirm')
      .set('Authorization', `Bearer ${a.accessToken}`)
      .send({ code: codeAt(secret) });
    expect(ok.status).toBe(200);
    expect(ok.body.accessToken).toBeTruthy();
    expect(ok.body.admin.totpEnabled).toBe(true);

    const row = await testPrisma.admin.findUniqueOrThrow({ where: { id: a.id } });
    expect(row.totpEnabled).toBe(true);
    expect(row.totpPendingEnc).toBeNull();
    expect(row.totpSecret).toBeNull();
    expect(row.totpSecretEnc).not.toContain(secret);
    expect(decryptSecret(row.totpSecretEnc!)).toBe(secret);
    expect(row.tokenEpoch).toBe(1);
  });

  it('setup on an enrolled admin is a 409', async () => {
    const a = await enrolledAdmin();
    const res = await request(app)
      .post('/v1/auth/admin/totp/setup')
      .set('Authorization', `Bearer ${a.accessToken}`);
    expect(res.status).toBe(409);
  });
});

describe('admin login with TOTP', () => {
  it('missing or wrong code → the same generic 401 as a wrong password', async () => {
    const a = await enrolledAdmin();
    const missing = await login(a.email);
    expect(missing.status).toBe(401);
    expect(missing.body.error.details.reason).toBe('admin_credentials');
    const wrong = await login(a.email, codeAt(a.secret, 600));
    expect(wrong.status).toBe(401);
    expect(wrong.body.error.details.reason).toBe('admin_credentials');
  });

  it('accepts a valid code once — a replay of the same code is rejected', async () => {
    const a = await enrolledAdmin();
    const code = codeAt(a.secret);
    const ok = await login(a.email, code);
    expect(ok.status).toBe(200);
    const replay = await login(a.email, code);
    expect(replay.status).toBe(401);
  });

  it('migrates a legacy plaintext secret into the encrypted column on login', async () => {
    const a = await createAdmin(testPrisma);
    const secret = authenticator.generateSecret();
    await testPrisma.admin.update({
      where: { id: a.id },
      data: { totpEnabled: true, totpSecret: secret },
    });
    expect((await login(a.email, codeAt(secret))).status).toBe(200);
    const row = await testPrisma.admin.findUniqueOrThrow({ where: { id: a.id } });
    expect(row.totpSecret).toBeNull();
    expect(decryptSecret(row.totpSecretEnc!)).toBe(secret);
  });

  it('lockout is per email+IP: a locked IP does not lock the admin out elsewhere', async () => {
    const a = await createAdmin(testPrisma);
    for (let i = 0; i < 5; i += 1) {
      await request(app)
        .post('/v1/auth/admin/login')
        .set('X-Forwarded-For', '10.30.0.1')
        .send({ email: a.email, password: 'wrong-password' });
    }
    const locked = await login(a.email, undefined, '10.30.0.1');
    expect(locked.status).toBe(429);
    const elsewhere = await login(a.email, undefined, '10.30.0.2');
    expect(elsewhere.status).toBe(200);
  });
});

describe('ADMIN_TOTP_REQUIRED gating', () => {
  it('blocks admin routes until enrolled, but allows setup', async () => {
    env.ADMIN_TOTP_REQUIRED = true;
    const a = await createAdmin(testPrisma);
    const blocked = await request(app)
      .get('/v1/admin/users')
      .set('Authorization', `Bearer ${a.accessToken}`);
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.details.reason).toBe('totp_enrollment_required');
    const setup = await request(app)
      .post('/v1/auth/admin/totp/setup')
      .set('Authorization', `Bearer ${a.accessToken}`);
    expect(setup.status).toBe(200);

    const loginRes = await login(a.email);
    expect(loginRes.body.admin.totpEnrollmentRequired).toBe(true);
  });

  it('lets an enrolled admin through', async () => {
    env.ADMIN_TOTP_REQUIRED = true;
    const a = await enrolledAdmin();
    const res = await request(app)
      .get('/v1/admin/users')
      .set('Authorization', `Bearer ${a.accessToken}`);
    expect(res.status).toBe(200);
  });
});

describe('admin TOTP disable', () => {
  it('self-disable requires a current code', async () => {
    const a = await enrolledAdmin();
    const noCode = await request(app)
      .post('/v1/auth/admin/totp/disable')
      .set('Authorization', `Bearer ${a.accessToken}`)
      .send({ code: codeAt(a.secret, 600) });
    expect(noCode.status).toBe(400);
    const ok = await request(app)
      .post('/v1/auth/admin/totp/disable')
      .set('Authorization', `Bearer ${a.accessToken}`)
      .send({ code: codeAt(a.secret) });
    expect(ok.status).toBe(204);
    const row = await testPrisma.admin.findUniqueOrThrow({ where: { id: a.id } });
    expect(row.totpEnabled).toBe(false);
    expect(row.totpSecretEnc).toBeNull();
  });

  it('only a superadmin can disable another admin', async () => {
    const target = await enrolledAdmin();
    const peer = await enrolledAdmin('admin');
    const denied = await request(app)
      .post('/v1/auth/admin/totp/disable')
      .set('Authorization', `Bearer ${peer.accessToken}`)
      .send({ adminId: target.id });
    expect(denied.status).toBe(403);

    const sa = await enrolledAdmin('superadmin');
    const ok = await request(app)
      .post('/v1/auth/admin/totp/disable')
      .set('Authorization', `Bearer ${sa.accessToken}`)
      .send({ adminId: target.id });
    expect(ok.status).toBe(204);
    const row = await testPrisma.admin.findUniqueOrThrow({ where: { id: target.id } });
    expect(row.totpEnabled).toBe(false);
    const audit = await testPrisma.adminAction.count({ where: { action: 'disable_admin_totp' } });
    expect(audit).toBe(1);
  });
});

describe('admin token epoch (M6)', () => {
  async function loginTokens(email: string) {
    const res = await login(email);
    expect(res.status).toBe(200);
    return res.body as { refreshToken: string };
  }
  const refresh = (refreshToken: string) =>
    request(app).post('/v1/auth/admin/refresh').send({ refreshToken });

  it('logout with a valid refresh token revokes every admin refresh token', async () => {
    const a = await createAdmin(testPrisma);
    const s1 = await loginTokens(a.email);
    const s2 = await loginTokens(a.email);
    expect((await refresh(s2.refreshToken)).status).toBe(200);
    const out = await request(app).post('/v1/auth/admin/logout').send({ refreshToken: s1.refreshToken });
    expect(out.status).toBe(204);
    const after = await refresh(s2.refreshToken);
    expect(after.status).toBe(401);
    expect(after.body.error.details.reason).toBe('admin_refresh_revoked');
  });

  it('password change revokes refresh tokens; lastLoginAt bumps no longer do', async () => {
    const a = await createAdmin(testPrisma);
    const s1 = await loginTokens(a.email);
    await loginTokens(a.email); // second login must NOT revoke s1 (old updatedAt epoch did)
    expect((await refresh(s1.refreshToken)).status).toBe(200);
    const changed = await request(app)
      .post('/v1/auth/admin/change-password')
      .set('Authorization', `Bearer ${a.accessToken}`)
      .send({ currentPassword: PASSWORD, newPassword: 'AnotherPass12345' });
    expect(changed.status).toBe(204);
    expect((await refresh(s1.refreshToken)).status).toBe(401);
  });

  it('rejects a stale-epoch refresh token', async () => {
    const a = await createAdmin(testPrisma);
    const stale = signAdminRefreshToken({ sub: a.id, email: a.email, role: 'admin', ep: 7 }, 3600);
    expect((await refresh(stale)).status).toBe(401);
  });
});

describe('superadmin temp password guard (H3)', () => {
  it('rejects unset, default and short temp passwords', () => {
    expect(superadminTempPasswordProblem(undefined)).toBeTruthy();
    expect(superadminTempPasswordProblem('change-on-first-login-please')).toBeTruthy();
    expect(superadminTempPasswordProblem('short-pass-123')).toBeTruthy();
    expect(superadminTempPasswordProblem('a-long-random-temp-pass-9f2')).toBeNull();
  });
});
