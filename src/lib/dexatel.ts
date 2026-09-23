import { env } from '@/config/env.js';
import { logger } from '@/lib/logger.js';

// Dexatel Telegram Verify API — Dexatel generates, delivers AND validates the
// OTP over Telegram (Twilio-Verify style). We never store/hash the code
// ourselves; verification is a server-to-server check against Dexatel.
//   Send : POST /v1/verifications  { data: { channel:'TELEGRAM', phone, code_length, ttl_in_seconds } }
//   Check: GET  /v1/verifications?code=..&phone=..   → non-empty data[] ⇒ valid (single-use)
// Docs: https://developers.dexatel.com/docs/telegram-verify-api-overview
const DEXATEL_BASE = 'https://api.dexatel.com/v1/verifications';
// Plain-message endpoint — used for the SMS OTP fallback where WE own the code
// (generated + bcrypt-hashed locally) and just need Dexatel to deliver our text.
const DEXATEL_MESSAGES = 'https://api.dexatel.com/v1/messages';

/** True when Dexatel is configured; otherwise callers use the local dev fallback. */
export function dexatelEnabled(): boolean {
  return !!env.DEXATEL_API_KEY;
}

// Dexatel wants digits only, with country code, no '+' or spaces (E.164 sans '+').
function toDexatelPhone(phoneE164: string): string {
  return phoneE164.replace(/[^\d]/g, '');
}

interface DexatelError {
  errors?: Array<{ title?: string; detail?: string }>;
}

async function dexatelFetch(url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        'X-Dexatel-Key': env.DEXATEL_API_KEY,
        ...(init.headers ?? {}),
      },
    });
  } catch (err) {
    logger.error({ err }, 'Dexatel request failed');
    throw new Error('dexatel_unreachable');
  }
}

async function errorDetail(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as DexatelError;
    return body.errors?.map((e) => e.detail ?? e.title).filter(Boolean).join('; ') ?? '';
  } catch {
    return '';
  }
}

/**
 * Send a plain SMS with our own `text` (which already contains the OTP code we
 * generated + hashed locally). Unlike dexatelSendVerification this does NOT use
 * the verify flow — Dexatel just delivers the message, and consumeOtp() checks
 * the code against our stored bcrypt hash. Used as the WhatsApp OTP fallback.
 */
export async function dexatelSendSms(phoneE164: string, text: string): Promise<void> {
  const res = await dexatelFetch(DEXATEL_MESSAGES, {
    method: 'POST',
    body: JSON.stringify({
      data: {
        channel: 'SMS',
        from: env.DEXATEL_SENDER,
        to: [toDexatelPhone(phoneE164)],
        text,
      },
    }),
  });
  if (!res.ok) {
    const detail = await errorDetail(res);
    logger.error({ phone: phoneE164, status: res.status, detail }, 'Dexatel SMS send failed');
    throw new Error(detail || 'dexatel_sms_failed');
  }
}

/**
 * Ask Dexatel to generate a code and deliver it to `phoneE164` over Telegram.
 * Dexatel owns the code + its TTL + single-use enforcement.
 */
export async function dexatelSendVerification(phoneE164: string, ttlSec = 600): Promise<void> {
  const res = await dexatelFetch(DEXATEL_BASE, {
    method: 'POST',
    body: JSON.stringify({
      data: {
        channel: 'telegram',
        phone: toDexatelPhone(phoneE164),
        code_length: 6,
        ttl_in_seconds: ttlSec,
      },
    }),
  });
  if (!res.ok) {
    const detail = await errorDetail(res);
    logger.error({ phone: phoneE164, status: res.status, detail }, 'Dexatel send failed');
    throw new Error(detail || 'dexatel_send_failed');
  }
}

/**
 * Validate an entered `code` for `phoneE164`. A non-empty match means the code
 * is correct, unexpired and unused; the check consumes it (single-use).
 */
export async function dexatelCheckCode(phoneE164: string, code: string): Promise<boolean> {
  const qs = new URLSearchParams({ code, phone: toDexatelPhone(phoneE164) });
  const res = await dexatelFetch(`${DEXATEL_BASE}?${qs.toString()}`, { method: 'GET' });
  if (!res.ok) {
    // A 4xx here (e.g. no match) is a failed verification, not an outage.
    if (res.status >= 500) {
      const detail = await errorDetail(res);
      logger.error({ phone: phoneE164, status: res.status, detail }, 'Dexatel check errored');
      throw new Error(detail || 'dexatel_check_failed');
    }
    return false;
  }
  const body = (await res.json()) as { data?: Array<{ expire_date?: string }> };
  const rows = body.data ?? [];
  if (rows.length === 0) return false;
  // Guard against a stale match: honour expire_date when present.
  const now = Date.now();
  return rows.some((r) => !r.expire_date || Date.parse(`${r.expire_date}Z`) > now);
}
