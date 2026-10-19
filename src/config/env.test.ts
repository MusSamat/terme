import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Production boot guards (H2 TOTP_ENC_KEY, H3 superadmin temp password, M10
// OTP_DEBUG / RATE_LIMIT_DISABLED) and TRUST_PROXY parsing (M3). env.ts parses
// at import time, so each case boots it in a child process (outside the repo,
// so no .env is picked up).

const here = path.dirname(fileURLToPath(import.meta.url));
const envModule = pathToFileURL(path.join(here, 'env.ts')).href;
const tsxLoader = pathToFileURL(path.join(here, '../../node_modules/tsx/dist/loader.mjs')).href;
const cwd = mkdtempSync(path.join(tmpdir(), 'terme-env-'));

const PROD_OK: Record<string, string> = {
  NODE_ENV: 'production',
  DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
  JWT_ACCESS_SECRET: 'a'.repeat(64),
  JWT_REFRESH_SECRET: 'b'.repeat(64),
  WHATSAPP_ACCESS_TOKEN: 'x',
  WHATSAPP_PHONE_NUMBER_ID: '1',
  TOTP_ENC_KEY: Buffer.alloc(32, 7).toString('base64'),
  SUPERADMIN_TEMP_PASSWORD: 'a-long-random-temp-pass-9f2',
};

function boot(vars: Record<string, string | undefined>): { status: number | null; out: string } {
  const env: Record<string, string> = { PATH: process.env.PATH ?? '' };
  for (const [k, v] of Object.entries(vars)) if (v !== undefined) env[k] = v;
  const r = spawnSync(
    process.execPath,
    ['--import', tsxLoader, '-e', `const m = await import(${JSON.stringify(envModule)}); console.log(JSON.stringify(m.env.TRUST_PROXY));`],
    { cwd, env, encoding: 'utf8', timeout: 20_000 },
  );
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

describe('production env guards', () => {
  it('boots with a safe production config', () => {
    const r = boot(PROD_OK);
    expect(r.status).toBe(0);
    expect(r.out.trim()).toBe('1');
  });

  it.each([
    ['OTP_DEBUG=true', { OTP_DEBUG: 'true' }, 'OTP_DEBUG'],
    ['RATE_LIMIT_DISABLED=true', { RATE_LIMIT_DISABLED: 'true' }, 'RATE_LIMIT_DISABLED'],
    ['missing TOTP_ENC_KEY', { TOTP_ENC_KEY: undefined }, 'TOTP_ENC_KEY'],
    ['unset superadmin temp password', { SUPERADMIN_TEMP_PASSWORD: undefined }, 'SUPERADMIN_TEMP_PASSWORD'],
    ['default superadmin temp password', { SUPERADMIN_TEMP_PASSWORD: 'change-on-first-login-please' }, 'SUPERADMIN_TEMP_PASSWORD'],
  ])('refuses to boot with %s', (_label, override, needle) => {
    const r = boot({ ...PROD_OK, ...override });
    expect(r.status).toBe(1);
    expect(r.out).toContain(needle);
  });

  it('parses TRUST_PROXY as a hop count or a proxy list', () => {
    expect(boot({ ...PROD_OK, TRUST_PROXY: '2' }).out.trim()).toBe('2');
    expect(boot({ ...PROD_OK, TRUST_PROXY: '127.0.0.1, 10.0.0.0/8' }).out.trim()).toBe(
      '["127.0.0.1","10.0.0.0/8"]',
    );
  });
});
