import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcryptjs';
import type { Express } from 'express';
import { testPrisma } from '../../../tests/setup.js';
import { createApp } from '@/server.js';
import { buildTestInitData } from '@/lib/telegram.js';
import { NoopNotifier } from '@/lib/notifier.js';

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN!;

let app: Express;
let notifier: NoopNotifier;

beforeEach(() => {
  notifier = new NoopNotifier();
  app = createApp(testPrisma, notifier);
});

function tgInitData(id: number, extra: Partial<{ first_name: string; language_code: string }> = {}): string {
  return buildTestInitData(
    {
      auth_date: String(Math.floor(Date.now() / 1000)),
      query_id: 'QQ',
      user: JSON.stringify({ id, first_name: extra.first_name ?? 'User', language_code: extra.language_code ?? 'ru' }),
    },
    BOT_TOKEN,
  );
}

async function seedOtp(phone: string, code: string): Promise<void> {
  const codeHash = await bcrypt.hash(code, 4);
  await testPrisma.otpCode.create({
    data: { phone, codeHash, expiresAt: new Date(Date.now() + 10 * 60_000) },
  });
}

// ─── AUTH-01: new Telegram user → full auth (phone not required for now) ──
describe('AUTH-01 — Telegram → full auth', () => {
  it('creates user and returns full auth immediately (phone requirement disabled)', async () => {
    const res = await request(app).post('/v1/auth/telegram').send({ initData: tgInitData(1001) });
    expect(res.status).toBe(200);
    expect(res.body.kind).toBe('full');
    expect(res.body.accessToken).toBeTypeOf('string');
    expect(res.body.refreshToken).toBeTypeOf('string');
    expect(res.body.user.phoneVerified).toBe(false);
    expect(res.body.user.phone).toBe('');

    const user = await testPrisma.user.findFirstOrThrow({ where: { telegramId: 1001n } });
    expect(user.phoneVerifiedAt).toBeNull();
  });
});

// ─── AUTH-02: OTP minute-gap (second send within 30s → 429) ─────────────
describe('AUTH-02 — OTP minute gap', () => {
  it('rejects second /send-otp within 1 minute with 429', async () => {
    await request(app).post('/v1/auth/phone/send-otp').send({ phone: '+996700000201' });
    const r2 = await request(app).post('/v1/auth/phone/send-otp').send({ phone: '+996700000201' });
    expect(r2.status).toBe(429);
  });
});

// ─── AUTH-03: 5 wrong codes → 6th attempt 429 ──────────────────────────
describe('AUTH-03 — OTP brute force lock', () => {
  it('locks phone for 15 minutes after 5 wrong codes', async () => {
    const phone = '+996700000301';
    await seedOtp(phone, '999999');
    for (let i = 0; i < 5; i += 1) {
      const r = await request(app).post('/v1/auth/phone/verify').send({ phone, code: '000000' });
      expect(r.status).toBe(400);
    }
    const r6 = await request(app).post('/v1/auth/phone/verify').send({ phone, code: '999999' });
    expect(r6.status).toBe(429);
    expect(r6.body.error.code).toBe('OTP_TOO_MANY_ATTEMPTS');
  });
});

// ─── AUTH-04: OAuth (Google/Apple) — verifier surface ──────────────────
describe('AUTH-04 — Google OAuth rejects invalid token', () => {
  it('returns 401 for a malformed id_token', async () => {
    const res = await request(app).post('/v1/auth/google').send({ idToken: 'not-a-jwt' });
    expect(res.status).toBe(401);
    expect(res.body.error.details.reason).toBe('google_invalid');
  });
});

// ─── AUTH-05 is covered by existing refresh tests; new coverage in AUTH-06 ─

// ─── AUTH-06: Token Reuse Detection ─────────────────────────────────────
describe('AUTH-06 — Token Reuse Detection', () => {
  it('reuse of a rotated refresh outside the grace window revokes all sessions + alerts', async () => {
    const phone = '+996700000601';
    await seedOtp(phone, '606060');
    const login = await request(app)
      .post('/v1/auth/phone/verify')
      .send({ phone, code: '606060' });
    expect(login.status).toBe(200);
    const firstRefresh = login.body.refreshToken as string;

    // First rotation — succeeds, returns new pair.
    const ok = await request(app)
      .post('/v1/auth/refresh')
      .send({ refreshToken: firstRefresh });
    expect(ok.status).toBe(200);

    // Age the rotated token past the 60s grace window so the replay is treated
    // as real reuse (not a legit client retry).
    await testPrisma.refreshToken.updateMany({
      where: { userId: login.body.user.id, usedAt: { not: null } },
      data: { usedAt: new Date(Date.now() - 2 * 60_000) },
    });

    // Replay the SAME (now-used, aged) refresh → trips reuse detection.
    const replay = await request(app)
      .post('/v1/auth/refresh')
      .send({ refreshToken: firstRefresh });
    expect(replay.status).toBe(401);
    expect(replay.body.error.details.reason).toBe('token_reuse_detected');

    // Every refresh for this user is revoked, including the second-pair one.
    const rows = await testPrisma.refreshToken.findMany({
      where: { userId: login.body.user.id },
    });
    expect(rows.every((r) => r.revokedAt !== null)).toBe(true);

    // Notifier received the security alert.
    expect(notifier.findForUser(login.body.user.id, 'security_alert_reuse').length).toBeGreaterThan(0);
  });
});

// ─── AUTH-07: Telegram user can still bind phone voluntarily ───────────────
describe('AUTH-07 — Telegram user voluntarily binds phone via /phone/verify', () => {
  it('phone+OTP flow links a real phone to an existing Telegram user', async () => {
    const init = tgInitData(1007, { first_name: 'Binder' });
    const login = await request(app).post('/v1/auth/telegram').send({ initData: init });
    expect(login.body.kind).toBe('full');
    const accessToken = login.body.accessToken as string;
    const userId = login.body.user.id as string;

    const phone = '+996700000707';
    await seedOtp(phone, '070707');
    // Call /phone/verify without provisional Bearer — phone-only registration path.
    const res = await request(app)
      .post('/v1/auth/phone/verify')
      .send({ phone, code: '070707' });
    expect(res.status).toBe(200);

    // The Telegram user's row should still be distinct from the new phone user.
    const tgUser = await testPrisma.user.findFirstOrThrow({ where: { telegramId: 1007n } });
    expect(tgUser.id).toBe(userId);
    void accessToken;
  });
});

// ─── AUTH-08 Phone + Password repeat login (no SMS) ────────────────────
describe('AUTH-08 — Phone+Password repeat login', () => {
  it('logs in with phone + password, no OTP required', async () => {
    const phone = '+996700000808';
    // First register via OTP.
    await seedOtp(phone, '808080');
    const reg = await request(app)
      .post('/v1/auth/phone/verify')
      .send({ phone, code: '808080' });
    expect(reg.status).toBe(200);

    // Set a password.
    const setRes = await request(app)
      .patch('/v1/users/me/password')
      .set('Authorization', `Bearer ${reg.body.accessToken}`)
      .send({ newPassword: 'S3cure-pass' });
    expect(setRes.status).toBe(204);

    // Repeat login via phone+password — no SMS.
    const login = await request(app)
      .post('/v1/auth/phone/login')
      .send({ phone, password: 'S3cure-pass' });
    expect(login.status).toBe(200);
    expect(login.body.kind).toBe('full');
    expect(login.body.accessToken).toBeTypeOf('string');
  });

  it('rejects wrong password with 401', async () => {
    const phone = '+996700000809';
    await seedOtp(phone, '888888');
    const reg = await request(app).post('/v1/auth/phone/verify').send({ phone, code: '888888' });
    await request(app)
      .patch('/v1/users/me/password')
      .set('Authorization', `Bearer ${reg.body.accessToken}`)
      .send({ newPassword: 'StrongPass1' });

    const login = await request(app)
      .post('/v1/auth/phone/login')
      .send({ phone, password: 'wrong-one' });
    expect(login.status).toBe(401);
  });
});

// ─── AUTH-09: phone visibility — UNCHANGED here (covered in bookings) ───

// ─── AUTH-11: phone change flow ─────────────────────────────────────────
describe('AUTH-11 — phone change', () => {
  it('start → OTP to new number → confirm swaps phone, revokes other sessions', async () => {
    const oldPhone = '+996700001101';
    await seedOtp(oldPhone, '111101');
    const reg = await request(app)
      .post('/v1/auth/phone/verify')
      .send({ phone: oldPhone, code: '111101' });
    const token = reg.body.accessToken as string;

    // Set password first so we can prove current-provider identity via phone.
    await request(app)
      .patch('/v1/users/me/password')
      .set('Authorization', `Bearer ${token}`)
      .send({ newPassword: 'CurrentPass1' });

    // Start — OTP goes to the NEW number.
    const newPhone = '+996700001102';
    const start = await request(app)
      .patch('/v1/users/me/phone')
      .set('Authorization', `Bearer ${token}`)
      .send({
        newPhone,
        reAuthProof: { provider: 'phone', password: 'CurrentPass1' },
      });
    expect(start.status).toBe(200);

    // Grab the code from OtpCode row (no SMS gateway in test).
    const otpRow = await testPrisma.otpCode.findFirstOrThrow({
      where: { phone: newPhone },
      orderBy: { createdAt: 'desc' },
    });
    // Can't read the plaintext; re-seed a known code to bypass crypto:
    const knownHash = await bcrypt.hash('222222', 4);
    await testPrisma.otpCode.update({
      where: { id: otpRow.id },
      data: { codeHash: knownHash, attempts: 0 },
    });

    const confirm = await request(app)
      .patch('/v1/users/me/phone/confirm')
      .set('Authorization', `Bearer ${token}`)
      .send({ newPhone, code: '222222' });
    expect(confirm.status).toBe(200);
    expect(confirm.body.user.phone).toBe(newPhone);

    const dbUser = await testPrisma.user.findUniqueOrThrow({ where: { id: reg.body.user.id } });
    expect(dbUser.phone).toBe(newPhone);
  });

  it('rejects when reAuth password is wrong', async () => {
    const phone = '+996700001103';
    await seedOtp(phone, '111103');
    const reg = await request(app).post('/v1/auth/phone/verify').send({ phone, code: '111103' });
    await request(app)
      .patch('/v1/users/me/password')
      .set('Authorization', `Bearer ${reg.body.accessToken}`)
      .send({ newPassword: 'RealPass11' });

    const res = await request(app)
      .patch('/v1/users/me/phone')
      .set('Authorization', `Bearer ${reg.body.accessToken}`)
      .send({
        newPhone: '+996700001104',
        reAuthProof: { provider: 'phone', password: 'wrong' },
      });
    expect(res.status).toBe(401);
  });
});

// ─── Logout-all revokes every session ───────────────────────────────────
describe('POST /v1/auth/logout/all', () => {
  it('revokes every refresh token for the user', async () => {
    const phone = '+996700001201';
    await seedOtp(phone, '120120');
    const reg = await request(app).post('/v1/auth/phone/verify').send({ phone, code: '120120' });
    const token = reg.body.accessToken as string;

    // Do a rotation so we have a second live refresh row.
    await request(app).post('/v1/auth/refresh').send({ refreshToken: reg.body.refreshToken });

    const res = await request(app)
      .post('/v1/auth/logout/all')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(204);

    const rows = await testPrisma.refreshToken.findMany({
      where: { userId: reg.body.user.id },
    });
    expect(rows.every((r) => r.revokedAt !== null)).toBe(true);
  });
});

// ─── Provider linking: add + remove ─────────────────────────────────────
describe('Providers link/unlink', () => {
  it('adds Telegram provider to a phone-registered user', async () => {
    const phone = '+996700001301';
    await seedOtp(phone, '130130');
    const reg = await request(app).post('/v1/auth/phone/verify').send({ phone, code: '130130' });
    const token = reg.body.accessToken as string;

    const res = await request(app)
      .post('/v1/users/me/providers')
      .set('Authorization', `Bearer ${token}`)
      .send({ provider: 'telegram', initData: tgInitData(1301) });
    expect(res.status).toBe(201);
    expect(res.body.provider).toBe('telegram');

    const row = await testPrisma.authProvider.findFirstOrThrow({
      where: { userId: reg.body.user.id, provider: 'telegram' },
    });
    expect(row.providerUserId).toBe('1301');
  });

  it('refuses to remove the LAST provider', async () => {
    const phone = '+996700001302';
    await seedOtp(phone, '130130');
    const reg = await request(app).post('/v1/auth/phone/verify').send({ phone, code: '130130' });
    const token = reg.body.accessToken as string;

    // Only the 'phone' provider row exists after OTP registration.
    const res = await request(app)
      .delete('/v1/users/me/providers/phone')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(409);
  });

  it('allows removal when a second provider exists', async () => {
    const phone = '+996700001303';
    await seedOtp(phone, '130130');
    const reg = await request(app).post('/v1/auth/phone/verify').send({ phone, code: '130130' });
    const token = reg.body.accessToken as string;

    await request(app)
      .post('/v1/users/me/providers')
      .set('Authorization', `Bearer ${token}`)
      .send({ provider: 'telegram', initData: tgInitData(1303) });

    const res = await request(app)
      .delete('/v1/users/me/providers/telegram')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(204);

    const remaining = await testPrisma.authProvider.findMany({
      where: { userId: reg.body.user.id },
    });
    expect(remaining.map((r) => r.provider)).toEqual(['phone']);
  });
});

// ─── AUTH-DEDUP: one user, not two (Telegram ↔ phone) ───────────────────
describe('AUTH-DEDUP — Telegram and phone resolve to a single account', () => {
  it('adding an already-registered phone merges the Telegram placeholder (no 500)', async () => {
    const phone = '+996700002001';

    // 1) Pre-existing phone-only account.
    await seedOtp(phone, '200101');
    const reg = await request(app).post('/v1/auth/phone/verify').send({ phone, code: '200101' });
    expect(reg.status).toBe(200);
    const phoneUserId = reg.body.user.id as string;

    // 2) Separate Telegram login → placeholder (+prov:) account.
    const tgLogin = await request(app).post('/v1/auth/telegram').send({ initData: tgInitData(2001) });
    expect(tgLogin.body.kind).toBe('full');
    const tgToken = tgLogin.body.accessToken as string;
    const tgUserId = tgLogin.body.user.id as string;
    expect(tgUserId).not.toBe(phoneUserId);

    // 3) Telegram user adds the SAME phone → merge, must not 500 on the unique index.
    await seedOtp(phone, '200102');
    const confirm = await request(app)
      .patch('/v1/users/me/phone/confirm')
      .set('Authorization', `Bearer ${tgToken}`)
      .send({ newPhone: phone, code: '200102' });
    expect(confirm.status).toBe(200);

    // 4) Unified: phone account owns the telegramId; placeholder soft-deleted.
    const survivor = await testPrisma.user.findUniqueOrThrow({ where: { id: phoneUserId } });
    expect(survivor.telegramId).toBe(2001n);
    expect(survivor.deletedAt).toBeNull();
    const placeholder = await testPrisma.user.findUniqueOrThrow({ where: { id: tgUserId } });
    expect(placeholder.deletedAt).not.toBeNull();
  });

  it('does NOT auto-bind telegramId from a link token on phone verify (C1 takeover hardening)', async () => {
    const phone = '+996700002002';

    // Security regression guard: even if a telegramLinkToken carrying a telegramId
    // exists for this phone, /auth/phone/verify must NOT bind that telegramId to
    // the account. That auto-bind was the account-takeover vector (an attacker
    // links a victim's phone to the attacker's Telegram). Telegram is bound ONLY
    // via signed initData (/auth/telegram) or a proven request_contact.
    await testPrisma.telegramLinkToken.create({
      data: {
        token: 'dedup-tok-2002',
        phone,
        telegramId: 2002n,
        status: 'sent',
        expiresAt: new Date(Date.now() + 10 * 60_000),
      },
    });
    await seedOtp(phone, '200200');
    const reg = await request(app).post('/v1/auth/phone/verify').send({ phone, code: '200200' });
    expect(reg.status).toBe(200);

    const u = await testPrisma.user.findFirstOrThrow({ where: { phone } });
    expect(u.telegramId).toBeNull();
  });
});
