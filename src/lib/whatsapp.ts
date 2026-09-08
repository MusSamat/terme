import { env } from '@/config/env.js';
import { logger } from '@/lib/logger.js';
import { Errors } from '@/lib/errors.js';

// WhatsApp Cloud API send. Docs:
// https://developers.facebook.com/docs/whatsapp/cloud-api/reference/messages
// Free-text sends only work inside Meta's 24-hour customer service window;
// outside it Meta returns error code 131047 (re-engagement / template required).
const WA_WINDOW_EXPIRED_CODE = 131047;

/** True when both send credentials are present. */
export function whatsappEnabled(): boolean {
  return !!env.WHATSAPP_ACCESS_TOKEN && !!env.WHATSAPP_PHONE_NUMBER_ID;
}

interface WaSendSuccess {
  messages?: Array<{ id: string }>;
}
interface WaSendError {
  error?: { message?: string; code?: number; error_subcode?: number };
}

/**
 * Send a free-text WhatsApp message. Returns the wamid on success.
 * Throws WHATSAPP_WINDOW_EXPIRED (409) when the 24h window is closed (131047),
 * and SERVICE_UNAVAILABLE (503) for any other API/transport failure.
 */
export async function sendWhatsappText(to: string, body: string): Promise<{ wamid: string }> {
  if (!whatsappEnabled()) {
    throw Errors.serviceUnavailable('WhatsApp is not configured');
  }

  const url = `https://graph.facebook.com/${env.WHATSAPP_API_VERSION}/${env.WHATSAPP_PHONE_NUMBER_ID}/messages`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.WHATSAPP_ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to,
        type: 'text',
        text: { body },
      }),
    });
  } catch (err) {
    logger.error({ err, to }, 'whatsapp: send request failed');
    throw Errors.serviceUnavailable('WhatsApp unreachable');
  }

  if (!res.ok) {
    const payload = (await res.json().catch(() => ({}))) as WaSendError;
    const code = payload.error?.code;
    logger.warn(
      { to, status: res.status, waCode: code, waMessage: payload.error?.message },
      'whatsapp: send rejected',
    );
    if (code === WA_WINDOW_EXPIRED_CODE) {
      throw Errors.whatsappWindowExpired({ whatsapp_code: code });
    }
    throw Errors.serviceUnavailable(payload.error?.message ?? 'WhatsApp send failed');
  }

  const data = (await res.json()) as WaSendSuccess;
  const wamid = data.messages?.[0]?.id;
  if (!wamid) {
    logger.error({ to }, 'whatsapp: send ok but no wamid in response');
    throw Errors.serviceUnavailable('WhatsApp send returned no message id');
  }
  return { wamid };
}
