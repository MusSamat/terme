import type { Role } from '@/lib/jwt.js';

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresIn: number;
  refreshTokenExpiresIn: number;
}

export interface AuthResult extends TokenPair {
  user: {
    id: string;
    phone: string;
    name: string;
    avatarUrl: string | null;
    roles: Role[];
    language: string;
    phoneVerified: boolean;
    telegramLinked: boolean;
    termsAcceptedAt: Date | null;
  };
  kind: 'full';
}

export interface AdminAuthResult {
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresIn: number;
  refreshTokenExpiresIn: number;
  admin: {
    id: string;
    email: string;
    name: string;
    role: 'admin' | 'superadmin';
    mustChangePassword: boolean;
    totpEnabled: boolean;
    /** ADMIN_TOTP_REQUIRED and not enrolled yet → UI must run TOTP setup. */
    totpEnrollmentRequired: boolean;
  };
}

export interface AdminRefreshResult {
  accessToken: string;
  accessTokenExpiresIn: number;
}

export interface AuthService {
  checkPhone(phone: string): Promise<{ exists: boolean; hasPassword: boolean }>;
  sendOtp(phone: string, ip?: string | null): Promise<{ expiresInSec: number; debug_code?: string }>;
  consumeOtp(phone: string, code: string): Promise<void>;
  verifyOtp(phone: string, code: string, deviceInfo?: string): Promise<AuthResult>;
  registerWithPhone(
    phone: string,
    code: string,
    name: string,
    surname: string,
    plainPassword: string | undefined,
    deviceInfo?: string,
  ): Promise<AuthResult>;
  loginWithPassword(phone: string, plainPassword: string, deviceInfo?: string): Promise<AuthResult>;
  changePassword(
    userId: string,
    currentPassword: string,
    newPassword: string,
    deviceInfo?: string,
  ): Promise<AuthResult>;
  resetPassword(phone: string, code: string, newPassword: string): Promise<void>;
  startPhoneChange(
    userId: string,
    newPhone: string,
    ip?: string | null,
  ): Promise<{ expiresInSec: number }>;
  confirmPhoneChange(
    userId: string,
    newPhone: string,
    code: string,
    deviceInfo?: string,
  ): Promise<AuthResult>;
  refresh(token: string, deviceInfo: string | undefined, ip: string | null): Promise<TokenPair>;
  logout(token: string): Promise<void>;
  logoutAll(userId: string): Promise<void>;
  adminLogin(
    email: string,
    plainPassword: string,
    totp: string | undefined,
    ip: string,
  ): Promise<AdminAuthResult>;
  adminRefresh(token: string): Promise<AdminRefreshResult>;
  adminChangePassword(adminId: string, currentPassword: string, newPassword: string): Promise<void>;
  adminLogout(token: string): Promise<void>;
  adminTotpSetup(adminId: string): Promise<{ secret: string; otpauthUri: string }>;
  adminTotpConfirm(adminId: string, code: string): Promise<AdminAuthResult>;
  adminTotpDisable(
    actor: { id: string; role: 'admin' | 'superadmin' },
    input: { adminId?: string; code?: string },
    ip: string | null,
  ): Promise<void>;
}
