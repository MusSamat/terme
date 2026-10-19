import { z } from 'zod';
import {
  DEFAULT_SUPERADMIN_EMAIL,
  DEFAULT_SUPERADMIN_TEMP_PASSWORD,
  superadminTempPasswordProblem,
} from './superadmin.js';

// Load `.env` into process.env before Zod parses (Node ≥20.12 built-in).
// In production a process manager (Docker / systemd) passes env directly, so
// we only load if the file exists and the key isn't already set by the runner.
try {
  process.loadEnvFile?.('.env');
} catch {
  // Missing .env is fine — CI and prod pass env directly.
}

// Validate all environment variables up-front. A missing required var fails fast
// at startup rather than surfacing as a runtime 500 deep inside a handler.

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent']).default('info'),
  BASE_URL: z.string().url().default('http://localhost:3000'),
  // Public web site (terme_ft). Allowed by CORS and used for links the Telegram
  // bot sends (trip pages, chats). Empty string is treated as unset.
  WEB_URL: z.preprocess(
    (v) => (v === '' ? undefined : v),
    z.string().url().optional(),
  ),

  // M3: Express 'trust proxy' — a hop count ("1" = one Nginx in front) or a
  // comma list of trusted proxy IPs/CIDRs/names ("127.0.0.1,10.0.0.0/8",
  // "loopback"). Wrong values let clients spoof X-Forwarded-For (rate limits).
  TRUST_PROXY: z
    .string()
    .default('1')
    .transform((v) => (/^\d+$/.test(v.trim()) ? Number(v.trim()) : v.split(',').map((p) => p.trim()).filter(Boolean))),

  DATABASE_URL: z.string().url(),
  TEST_DATABASE_URL: z.string().url().optional(),

  JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must be ≥32 chars'),
  JWT_REFRESH_SECRET: z.string().min(32, 'JWT_REFRESH_SECRET must be ≥32 chars'),
  JWT_ACCESS_TTL_MIN: z.coerce.number().int().positive().default(15),
  // TZ v2.1: no fixed refresh TTL — extends on activity. 30 days of inactivity
  // = forced logout. Cleanup cron enforces the deadline via expires_at.
  JWT_REFRESH_INACTIVITY_DAYS: z.coerce.number().int().positive().default(30),
  // H4: refresh reuse handling. 'log' only logs what 'enforce' would do (no
  // family revoke, no alert); 'enforce' revokes the family + security alert.
  REFRESH_REUSE_MODE: z.enum(['log', 'enforce']).default('log'),

  TELEGRAM_BOT_TOKEN: z.string().default(''),
  TELEGRAM_BOT_USERNAME: z.string().default('terme_kg_bot'),

  // WhatsApp Cloud API (Meta). All optional/defaulted so a fresh checkout boots
  // without them; the webhook GET rejects verification until VERIFY_TOKEN is set,
  // and the reply endpoint 503s until ACCESS_TOKEN + PHONE_NUMBER_ID are set.
  WHATSAPP_PHONE_NUMBER_ID: z.string().default(''),
  WHATSAPP_ACCESS_TOKEN: z.string().default(''),
  WHATSAPP_APP_SECRET: z.string().default(''),
  WHATSAPP_VERIFY_TOKEN: z.string().default(''),
  WHATSAPP_API_VERSION: z.string().default('v21.0'),
  // OTP delivery via WhatsApp authentication template. The template must be
  // approved in Meta in this language with a body param + copy-code URL button.
  WHATSAPP_OTP_TEMPLATE: z.string().default('terme_otp'),
  WHATSAPP_OTP_LANG: z.string().default('ru'),

  // L3: only expose debug_code / local OTP capture when explicitly enabled.
  // NEVER set to true in production — it returns the OTP in the API response.
  OTP_DEBUG: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),

  // H1: OTP cost protection (no CAPTCHA, every country allowed). Per-IP send
  // caps sit in front of the DB-backed per-phone throttle; the daily budgets
  // count every code issued platform-wide in the last 24h (503 when spent).
  OTP_IP_HOURLY_CAP: z.coerce.number().int().positive().default(5),
  OTP_IP_DAILY_CAP: z.coerce.number().int().positive().default(20),
  OTP_GLOBAL_DAILY_CAP: z.coerce.number().int().positive().default(2000),
  OTP_FOREIGN_DAILY_CAP: z.coerce.number().int().positive().default(100),
  // M5: per-phone absolute ceiling across all IPs (the per (phone, ip) daily cap
  // is OTP_DAILY_CAP) — an attacker can't burn a victim's whole daily quota.
  OTP_PHONE_DAILY_CEILING: z.coerce.number().int().positive().default(15),

  // H2: AES-256-GCM key for admin TOTP secrets at rest — 32 bytes, base64.
  // Required in production; dev/test derive a key from JWT_REFRESH_SECRET.
  TOTP_ENC_KEY: z.preprocess(
    (v) => (v === '' ? undefined : v),
    z
      .string()
      .refine((v) => Buffer.from(v, 'base64').length === 32, 'TOTP_ENC_KEY must be 32 bytes, base64')
      .optional(),
  ),
  // H2: admins must enrol TOTP before using the panel. Unset → on in production.
  ADMIN_TOTP_REQUIRED: z.preprocess(
    (v) => (v === '' ? undefined : v),
    z.enum(['true', 'false']).optional(),
  ),
  // M6: admin refresh token lifetime (stateless JWT + admins.token_epoch).
  ADMIN_REFRESH_TTL_HOURS: z.coerce.number().int().positive().default(12),

  // M4: phone reveals («Позвонить») — DISTINCT people per rolling 24h. New
  // accounts (younger than CONTACT_NEW_ACCOUNT_DAYS or without any completed
  // trip) get the lower cap.
  CONTACT_DAILY_CAP: z.coerce.number().int().positive().default(30),
  CONTACT_NEW_ACCOUNT_DAILY_CAP: z.coerce.number().int().positive().default(10),
  CONTACT_NEW_ACCOUNT_DAYS: z.coerce.number().int().nonnegative().default(3),

  // Public read endpoints (search / lists / profiles / map / city search):
  // per authenticated user, or per IP when anonymous (CGNAT → higher).
  PUBLIC_READ_USER_PER_MIN: z.coerce.number().int().positive().default(120),
  PUBLIC_READ_IP_PER_MIN: z.coerce.number().int().positive().default(240),
  // M9: POST /auth/check-phone per IP per day (enumeration brake).
  CHECK_PHONE_IP_DAILY_CAP: z.coerce.number().int().positive().default(200),

  SUPERADMIN_EMAIL: z.string().email().default(DEFAULT_SUPERADMIN_EMAIL),
  // H3: production refuses to boot with it unset, default or <16 chars.
  SUPERADMIN_TEMP_PASSWORD: z.string().min(8).default(DEFAULT_SUPERADMIN_TEMP_PASSWORD),

  // HMAC key for signed private-file URLs. Unset → falls back to
  // JWT_ACCESS_SECRET (with a startup warning); set a separate value.
  FILES_SIGNING_SECRET: z.preprocess(
    (v) => (v === '' ? undefined : v),
    z.string().min(32, 'FILES_SIGNING_SECRET must be ≥32 chars').optional(),
  ),

  FILES_DIR: z.string().default('./var/files'),
  MAX_UPLOAD_MB: z.coerce.number().int().positive().default(5),

  // Backups (TZ §4.5 + §21). When BACKUP_DIR is empty the db_backup /
  // files_backup cron jobs no-op — keeps dev/CI from shelling out to
  // pg_dump/rsync. Set it on staging/prod to enable daily dumps.
  BACKUP_DIR: z.string().default(''),
  BACKUP_RETENTION_DAYS: z.coerce.number().int().positive().default(30),

  RATE_LIMIT_DISABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),

  ENABLE_SWAGGER: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),

  // Comma-separated list of allowed CORS origins in production.
  // Dev always allows localhost:3000 and localhost:3001 automatically.
  ALLOWED_ORIGINS: z.string().default(''),

  // Sentry error tracking. Empty (default) = fully disabled: Sentry.init() is
  // never called and captureException() is inert. Set on staging/prod to enable.
  SENTRY_DSN: z.string().default(''),

  // M1: drop a socket when its access token expires (client must refresh the
  // token and reconnect; it receives `auth:expired` first). Kill-switch.
  WS_DISCONNECT_ON_TOKEN_EXPIRY: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  WS_MAX_CONNECTIONS_PER_USER: z.coerce.number().int().positive().default(10),

  // Presence tunables (see modules/presence/presence.service.ts). Defaults match
  // the service's historical values so behaviour is unchanged when unset.
  PRESENCE_WINDOW_SEC: z.coerce.number().int().positive().default(60),
  PRESENCE_THROTTLE_SEC: z.coerce.number().int().positive().default(20),
  PRESENCE_CACHE_MS: z.coerce.number().int().positive().default(10_000),
});

export type Env = Omit<z.infer<typeof EnvSchema>, 'ADMIN_TOTP_REQUIRED'> & {
  ADMIN_TOTP_REQUIRED: boolean;
};

function parseEnv(): Env {
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    // Don't leak secrets — show only which keys failed.
    const issues = parsed.error.issues
      .map((i) => `  • ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    // Use stderr directly — logger isn't initialised yet.
    process.stderr.write(`\n✗ Invalid environment variables:\n${issues}\n\n`);
    process.exit(1);
  }
  // N14: in production OTP MUST go out over WhatsApp. Without it deliverOtp()
  // would fall back to capturing the code in logs (a plaintext-OTP leak).
  const whatsappConfigured =
    !!parsed.data.WHATSAPP_ACCESS_TOKEN && !!parsed.data.WHATSAPP_PHONE_NUMBER_ID;
  if (parsed.data.NODE_ENV === 'production' && !whatsappConfigured) {
    process.stderr.write(
      '\n✗ Production requires WhatsApp OTP delivery ' +
        '(WHATSAPP_ACCESS_TOKEN + WHATSAPP_PHONE_NUMBER_ID).\n\n',
    );
    process.exit(1);
  }
  const data = parsed.data;
  if (data.NODE_ENV === 'production') {
    const problems = [
      !data.TOTP_ENC_KEY && 'TOTP_ENC_KEY (32 bytes, base64) is required',
      superadminTempPasswordProblem(process.env.SUPERADMIN_TEMP_PASSWORD),
      // M10: debug switches that leak OTPs / drop every limit.
      data.OTP_DEBUG && 'OTP_DEBUG=true is forbidden in production',
      data.RATE_LIMIT_DISABLED && 'RATE_LIMIT_DISABLED=true is forbidden in production',
    ].filter(Boolean);
    if (problems.length) {
      process.stderr.write(`\n✗ Unsafe production config:\n  • ${problems.join('\n  • ')}\n\n`);
      process.exit(1);
    }
  }
  return {
    ...data,
    ADMIN_TOTP_REQUIRED:
      data.ADMIN_TOTP_REQUIRED === undefined
        ? data.NODE_ENV === 'production'
        : data.ADMIN_TOTP_REQUIRED === 'true',
  };
}

export const env: Env = parseEnv();

export const isProd = env.NODE_ENV === 'production';
export const isTest = env.NODE_ENV === 'test';
export const isDev = env.NODE_ENV === 'development';
