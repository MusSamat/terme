import type { PrismaClient } from '@prisma/client';
import type { Notifier } from '@/lib/notifier.js';
import type { AuthService } from './auth.types.js';
import { createOtpMethods } from './auth.otp.js';
import { createSessionMethods } from './auth.session.js';
import { createAdminAuthMethods } from './auth.admin.js';
import { createPasswordMethods } from './auth.password.js';

export function createAuthService(prisma: PrismaClient, notifier: Notifier): AuthService {
  // Tells the client which step comes next: register (new number), password
  // (web, password set) or «set a password via WhatsApp» (web, none yet).
  async function checkPhone(phone: string): Promise<{ exists: boolean; hasPassword: boolean }> {
    const user = await prisma.user.findFirst({
      where: { phone, deletedAt: null },
      select: { passwordHash: true },
    });
    return { exists: !!user, hasPassword: !!user?.passwordHash };
  }

  const otp = createOtpMethods(prisma);
  return {
    ...otp,
    ...createPasswordMethods(prisma, otp),
    ...createSessionMethods(prisma, notifier),
    ...createAdminAuthMethods(prisma),
    checkPhone,
  };
}

export type { AuthService, AuthResult, TokenPair, AdminAuthResult } from './auth.types.js';
