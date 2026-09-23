import { env } from '@/config/env.js';
import { logger } from '@/lib/logger.js';
import { recordSent } from '@/lib/sms.js';

// ⚠️ DEAD CODE (kept for reference only). OTP is now delivered EXCLUSIVELY via
// WhatsApp (see lib/whatsapp.ts + deliverOtp in auth.otp.ts). This Telegram
// Gateway delivery path has NO live callers and MUST NOT be re-wired as an OTP
// channel: delivering a code over Telegram to an unproven phone was part of the
// C1 account-takeover vector. If Telegram Gateway is ever revived, gate it and
// re-review ownership proofs first.
//
// Telegram Gateway — delivers a verification code to any phone number that has
// Telegram, without the user starting our bot. https://core.telegram.org/gateway/api
const GATEWAY_URL = 'https://gatewayapi.telegram.org';

interface GatewayResponse {
  ok: boolean;
  error?: string;
  result?: { request_id?: string };
}

/**
 * Deliver OTP `code` to `phoneE164` over Telegram Gateway.
 *
 * Testing period: when TELEGRAM_GATEWAY_TOKEN is empty, the code is captured
 * in the local buffer + logged (exactly like the old mock SMS) instead of being
 * sent — so dev flows and tests keep working with no external dependency.
 */
export async function sendGatewayVerification(
  phoneE164: string,
  code: string,
  text: string,
  ttlSec = 600,
): Promise<void> {
  if (!env.TELEGRAM_GATEWAY_TOKEN) {
    recordSent(phoneE164, text);
    logger.info(
      { phone: phoneE164 },
      '[MOCK TG-GATEWAY] no TELEGRAM_GATEWAY_TOKEN — code captured locally, not delivered',
    );
    return;
  }

  let data: GatewayResponse;
  try {
    const res = await fetch(`${GATEWAY_URL}/sendVerificationMessage`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.TELEGRAM_GATEWAY_TOKEN}`,
      },
      // We generate + hash our own code, so pass it explicitly (Gateway can also
      // generate one via code_length, but then we couldn't verify it ourselves).
      body: JSON.stringify({ phone_number: phoneE164, code, ttl: ttlSec }),
    });
    data = (await res.json()) as GatewayResponse;
  } catch (err) {
    logger.error({ err, phone: phoneE164 }, 'Telegram Gateway request failed');
    throw new Error('telegram_gateway_unreachable');
  }

  if (!data.ok) {
    logger.error({ phone: phoneE164, error: data.error }, 'Telegram Gateway rejected send');
    throw new Error(data.error ?? 'telegram_gateway_failed');
  }
}
