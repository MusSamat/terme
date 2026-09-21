import { env } from '@/config/env.js';
import { logger } from '@/lib/logger.js';
import { Errors } from '@/lib/errors.js';

// WhatsApp Cloud API send. Docs:
// https://developers.facebook.com/docs/whatsapp/cloud-api/reference/messages
// Free-text sends only work inside Meta's 24-hour customer service window;
// outside it Meta returns error code 131047 (re-engagement / template required).
// Template sends (e.g. OTP) are NOT subject to that window.
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
 * POST a prepared message payload to the Cloud API and return the wamid.
 * Shared by text + template sends. Throws WHATSAPP_WINDOW_EXPIRED (409) on the
 * 24h-window error (text only), SERVICE_UNAVAILABLE (503) otherwise.
 */
async function postMessage(
  payload: Record<string, unknown>,
  logCtx: Record<string, unknown>,
): Promise<{ wamid: string }> {
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
      body: JSON.stringify(payload),
    });
  } catch (err) {
    logger.error({ err, ...logCtx }, 'whatsapp: send request failed');
    throw Errors.serviceUnavailable('WhatsApp unreachable');
  }

  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as WaSendError;
    const code = body.error?.code;
    logger.warn(
      { ...logCtx, status: res.status, waCode: code, waMessage: body.error?.message },
      'whatsapp: send rejected',
    );
    if (code === WA_WINDOW_EXPIRED_CODE) {
      throw Errors.whatsappWindowExpired({ whatsapp_code: code });
    }
    throw Errors.serviceUnavailable(body.error?.message ?? 'WhatsApp send failed');
  }

  const data = (await res.json()) as WaSendSuccess;
  const wamid = data.messages?.[0]?.id;
  if (!wamid) {
    logger.error({ ...logCtx }, 'whatsapp: send ok but no wamid in response');
    throw Errors.serviceUnavailable('WhatsApp send returned no message id');
  }
  return { wamid };
}

/** Cloud API wants the recipient as digits only (E.164 without '+'). */
function toWaRecipient(phone: string): string {
  return phone.replace(/\D/g, '');
}

/**
 * Send a free-text WhatsApp message (24h customer-service window applies).
 * Returns the wamid on success.
 */
export function sendWhatsappText(to: string, body: string): Promise<{ wamid: string }> {
  return postMessage(
    { messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'text', text: { body } },
    { to },
  );
}

/**
 * Deliver an OTP code via the approved authentication template (default
 * `terme_otp`). The code fills both the body placeholder and the copy-code URL
 * button (per the template definition). Template sends bypass the 24h window.
 */
export function sendWhatsappOtp(phoneE164: string, code: string): Promise<{ wamid: string }> {
  const to = toWaRecipient(phoneE164);
  return postMessage(
    {
      messaging_product: 'whatsapp',
      to,
      type: 'template',
      template: {
        name: env.WHATSAPP_OTP_TEMPLATE,
        language: { code: env.WHATSAPP_OTP_LANG },
        components: [
          { type: 'body', parameters: [{ type: 'text', text: code }] },
          {
            type: 'button',
            sub_type: 'url',
            index: '0',
            parameters: [{ type: 'text', text: code }],
          },
        ],
      },
    },
    { to, template: env.WHATSAPP_OTP_TEMPLATE },
  );
}
