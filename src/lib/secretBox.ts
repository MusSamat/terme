import crypto from 'node:crypto';
import { env } from '@/config/env.js';
import { Errors } from '@/lib/errors.js';

// AES-256-GCM for small secrets at rest (admin TOTP seeds). Format:
// "v1.<iv>.<tag>.<ciphertext>" (base64url). Key: TOTP_ENC_KEY (32 bytes,
// base64) — required in production; dev/test derive one from the refresh secret.

let cachedKey: Buffer | null = null;

function key(): Buffer {
  if (!cachedKey) {
    cachedKey = env.TOTP_ENC_KEY
      ? Buffer.from(env.TOTP_ENC_KEY, 'base64')
      : crypto.createHash('sha256').update(`totp-dev-key:${env.JWT_REFRESH_SECRET}`).digest();
  }
  return cachedKey;
}

export function encryptSecret(plain: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ['v1', iv, tag, ct].map((p) => (typeof p === 'string' ? p : p.toString('base64url'))).join('.');
}

export function decryptSecret(blob: string): string {
  const [ver, iv, tag, ct] = blob.split('.');
  if (ver !== 'v1' || !iv || !tag || !ct) throw Errors.internal('Malformed encrypted secret');
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(ct, 'base64url')), decipher.final()]).toString('utf8');
  } catch {
    throw Errors.internal('Encrypted secret could not be decrypted (wrong TOTP_ENC_KEY?)');
  }
}
