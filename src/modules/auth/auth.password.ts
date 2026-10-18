import type { PrismaClient } from '@prisma/client';
import { Errors } from '@/lib/errors.js';
import * as password from '@/lib/bcrypt.js';
import { assertActiveUser } from '@/lib/assertUser.js';
import { issueFullAuthForUser } from './auth.helpers.js';
import type { AuthResult } from './auth.types.js';
import type { createOtpMethods } from './auth.otp.js';
import { DUMMY_BCRYPT_HASH_COST12 } from './auth.constants.js';

// Web sign-in by phone + password. Mobile signs in by WhatsApp code instead;
// accounts created there have no password until the user runs «forgot
// password» (WhatsApp code) once.
export function createPasswordMethods(
  prisma: PrismaClient,
  otp: Pick<ReturnType<typeof createOtpMethods>, 'consumeOtp'>,
) {
  async function loginWithPassword(
    phone: string,
    plainPassword: string,
    deviceInfo?: string,
  ): Promise<AuthResult> {
    const user = await prisma.user.findFirst({ where: { phone, deletedAt: null } });
    const ok = await password.verify(plainPassword, user?.passwordHash ?? DUMMY_BCRYPT_HASH_COST12);
    if (!user || !user.passwordHash || !ok) {
      throw Errors.unauthorized({ reason: 'invalid_credentials' });
    }
    if (user.isBlocked) throw Errors.forbidden({ reason: 'blocked' });
    return issueFullAuthForUser(prisma, user.id, deviceInfo);
  }

  // Change an existing password (logged in, knows the current one).
  async function changePassword(
    userId: string,
    currentPassword: string,
    newPassword: string,
  ): Promise<void> {
    const user = await assertActiveUser(userId, prisma);
    if (!user.passwordHash) throw Errors.conflict('Password not set', { reason: 'password_not_set' });
    if (!(await password.verify(currentPassword, user.passwordHash))) {
      throw Errors.unauthorized({ reason: 'current_password_mismatch' });
    }
    await prisma.user.update({
      where: { id: userId },
      data: { passwordHash: await password.hash(newPassword), lastPasswordChangedAt: new Date() },
    });
  }

  // «Forgot password» and first-time set: a fresh WhatsApp code to the
  // account's own number authorises the new password; every session is revoked.
  // Unknown phone gets the same error as a wrong code (no account enumeration).
  async function resetPassword(phone: string, code: string, newPassword: string): Promise<void> {
    const user = await prisma.user.findFirst({ where: { phone, deletedAt: null } });
    if (!user) throw Errors.otpWrong();
    await otp.consumeOtp(phone, code);
    const now = new Date();
    await prisma.$transaction([
      prisma.user.update({
        where: { id: user.id },
        data: {
          passwordHash: await password.hash(newPassword),
          lastPasswordChangedAt: now,
          phoneVerifiedAt: user.phoneVerifiedAt ?? now,
        },
      }),
      prisma.refreshToken.updateMany({
        where: { userId: user.id, revokedAt: null },
        data: { revokedAt: now },
      }),
    ]);
  }

  return { loginWithPassword, changePassword, resetPassword };
}
