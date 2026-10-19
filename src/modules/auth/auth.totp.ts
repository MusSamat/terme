import type { Admin, PrismaClient } from '@prisma/client';
import { authenticator } from 'otplib';
import { decryptSecret } from '@/lib/secretBox.js';

// ±1 step of clock drift (30s each side).
const totp = authenticator.clone({ window: 1 });
const STEP_SEC = 30;

export const TOTP_ISSUER = 'Terme Admin';

export function generateTotpSecret(): string {
  return totp.generateSecret();
}

export function totpKeyUri(email: string, secret: string): string {
  return totp.keyuri(email, TOTP_ISSUER, secret);
}

/** Time-step the code matches (within the drift window), or null. */
export function matchTotpStep(secret: string, code: string): number | null {
  const delta = totp.checkDelta(code, secret);
  if (delta === null) return null;
  return Math.floor(Date.now() / 1000 / STEP_SEC) + delta;
}

/** Active secret: the encrypted column, or a legacy plaintext one (migrated on login). */
export function activeTotpSecret(admin: Pick<Admin, 'totpSecretEnc' | 'totpSecret'>): string | null {
  if (admin.totpSecretEnc) return decryptSecret(admin.totpSecretEnc);
  return admin.totpSecret ?? null;
}

/**
 * Verify `code` and consume its time-step atomically: a step is accepted only
 * if it is newer than admins.totp_last_step, so a sniffed code can't be
 * replayed inside its 90s validity window.
 */
export async function consumeTotp(
  prisma: PrismaClient,
  adminId: string,
  secret: string,
  code: string,
): Promise<boolean> {
  const step = matchTotpStep(secret, code);
  if (step === null) return false;
  const { count } = await prisma.admin.updateMany({
    where: { id: adminId, OR: [{ totpLastStep: null }, { totpLastStep: { lt: step } }] },
    data: { totpLastStep: step },
  });
  return count === 1;
}
