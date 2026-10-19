import { describe, expect, it } from 'vitest';
import pino from 'pino';
import { redactOptions } from './logger.js';

function capture(obj: Record<string, unknown>): Record<string, unknown> {
  const lines: string[] = [];
  const log = pino({ redact: redactOptions }, { write: (l: string) => lines.push(l) });
  log.info(obj, 'x');
  return JSON.parse(lines[0]!) as Record<string, unknown>;
}

describe('logger redaction', () => {
  it('keeps error codes visible (Prisma P2002, AppError codes)', () => {
    const out = capture({ err: { code: 'P2002', message: 'unique' }, error: { code: 'CONFLICT' } });
    expect(out.err).toMatchObject({ code: 'P2002' });
    expect(out.error).toMatchObject({ code: 'CONFLICT' });
  });

  it('redacts OTP codes in request bodies and secrets', () => {
    const out = capture({
      req: { body: { code: '123456', phone: '+996700000000' }, headers: { authorization: 'Bearer x' } },
      body: { code: '654321' },
      otp: { code: '111111' },
      input: { otp: '222222', password: 'p' },
    });
    expect(out.req).toMatchObject({ body: { code: '[REDACTED]' }, headers: { authorization: '[REDACTED]' } });
    expect(out.body).toEqual({ code: '[REDACTED]' });
    expect(out.otp).toEqual({ code: '[REDACTED]' });
    expect(out.input).toEqual({ otp: '[REDACTED]', password: '[REDACTED]' });
  });
});
