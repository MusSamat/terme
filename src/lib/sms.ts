import { logger } from '@/lib/logger.js';

export interface SmsProvider {
  send(phone: string, text: string): Promise<void>;
}

// Captured messages are accessible to tests via getSentMessages(). This buffer
// is a DEV/TEST debug tool only — it holds plaintext OTP text, so it must never
// grow (memory leak) or run in production (log/heap leak of live codes).
const sent: { phone: string; text: string; at: Date }[] = [];
// N14: cap the buffer so it can't grow unbounded even in long dev sessions.
const MAX_CAPTURED = 50;

// Record a delivery in the local capture buffer. Used by the mock OTP fallback
// when no real channel is configured, so dev/test flows can read the code via
// getSentMessages(). No-op in production — the OTP plaintext must never be
// captured or logged there (prod requires WhatsApp; see env.ts N14 guard).
export function recordSent(phone: string, text: string): void {
  if (process.env.NODE_ENV === 'production') return;
  sent.push({ phone, text, at: new Date() });
  if (sent.length > MAX_CAPTURED) sent.splice(0, sent.length - MAX_CAPTURED);
  logger.info({ phone, text }, '[OTP CAPTURE]');
}

// ───────────────────────────────────────────────────────────────────────────
// SMS delivery is DISABLED for the Telegram-only testing period. OTP now goes
// through Telegram Gateway (see lib/telegramGateway.ts). The real providers
// (Mega.kg, Nikita) are commented out; re-enable by restoring getSmsProvider()
// and the SMS delivery call in auth.otp.ts.
// ───────────────────────────────────────────────────────────────────────────
//
// const MockProvider: SmsProvider = {
//   async send(phone, text) {
//     recordSent(phone, text);
//   },
// };
//
// export function getSmsProvider(): SmsProvider {
//   if (env.SMS_PROVIDER === 'mock') return MockProvider;
//   throw new Error(`SMS provider "${env.SMS_PROVIDER}" is not implemented yet`);
// }

export function getSentMessages(): ReadonlyArray<{ phone: string; text: string; at: Date }> {
  return sent;
}

export function clearSentMessages(): void {
  sent.length = 0;
}
