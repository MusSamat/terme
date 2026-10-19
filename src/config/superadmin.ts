// H3: the seeded superadmin's temp password. Shared by env.ts (boot guard) and
// prisma/seed.ts — no env parsing here so the seed can import it standalone.

export const DEFAULT_SUPERADMIN_EMAIL = 'superadmin@terme.kg';
export const DEFAULT_SUPERADMIN_TEMP_PASSWORD = 'change-on-first-login-please';
export const SUPERADMIN_TEMP_PASSWORD_MIN_PROD = 16;

/** Why `raw` is unacceptable as a production temp password, or null if fine. */
export function superadminTempPasswordProblem(raw: string | undefined): string | null {
  if (!raw) return 'SUPERADMIN_TEMP_PASSWORD is not set';
  if (raw === DEFAULT_SUPERADMIN_TEMP_PASSWORD) return 'SUPERADMIN_TEMP_PASSWORD is the public default';
  if (raw.length < SUPERADMIN_TEMP_PASSWORD_MIN_PROD) {
    return `SUPERADMIN_TEMP_PASSWORD must be ≥${SUPERADMIN_TEMP_PASSWORD_MIN_PROD} chars`;
  }
  return null;
}
