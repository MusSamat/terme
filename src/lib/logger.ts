import pino from 'pino';
import { env, isDev, isTest } from '@/config/env.js';

export const redactOptions = {
  paths: [
    'req.headers.authorization',
    'req.headers.cookie',
    '*.password',
    '*.passwordHash',
    '*.tokenHash',
    '*.codeHash',
    '*.totpSecret',
    '*.initData',
    '*.refreshToken',
    '*.accessToken',
    // OTP / TOTP codes in request bodies only — err.code (P2002 …) and
    // AppError codes must stay visible.
    'body.code',
    '*.body.code',
    'otp.code',
    '*.newPassword',
    '*.currentPassword',
    '*.otp',
    '*.totp',
  ],
  censor: '[REDACTED]',
};

export const logger = pino({
  level: isTest ? 'silent' : env.LOG_LEVEL,
  base: {
    service: 'terme-api',
    env: env.NODE_ENV,
  },
  timestamp: pino.stdTimeFunctions.isoTime,
  // Pretty output only in local dev — production emits single-line JSON for log
  // aggregators (TZ §27 "Structured logs · JSON · level, msg, request_id,
  // user_id, duration").
  ...(isDev
    ? {
        transport: {
          target: 'pino-pretty',
          options: { colorize: true, singleLine: false, translateTime: 'HH:MM:ss.l' },
        },
      }
    : {}),
  redact: redactOptions,
});

export type Logger = typeof logger;

/** Phones in logs: keep only the last 4 digits (e.g. "***4567"). */
export function maskPhone(phone: string): string {
  return phone.length > 4 ? `***${phone.slice(-4)}` : '***';
}
