import type { Provider, Role } from '@/lib/jwt.js';

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
    providers: Provider[];
  };
  kind: 'full';
}

// TZ v2.1 §8.2 step 5 — after OAuth but before phone verification.
export interface ProvisionalAuthResult {
  provisionalToken: string;
  provisionalTokenExpiresIn: number;
  requiresPhoneVerification: true;
  hintPhone: string | null;
  hintName: string | null;
  user: { id: string; provider: Provider };
  kind: 'provisional';
}

export type AnyAuthResult = AuthResult | ProvisionalAuthResult;

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
  };
}

export interface AdminRefreshResult {
  accessToken: string;
  accessTokenExpiresIn: number;
}

export interface AuthService {
  loginWithTelegram(initData: string, deviceInfo?: string): Promise<AnyAuthResult>;
  loginWithGoogle(body: import('./auth.schemas.js').GoogleLoginInput, deviceInfo?: string): Promise<AnyAuthResult>;
  loginWithApple(body: import('./auth.schemas.js').AppleLoginInput, deviceInfo?: string): Promise<AnyAuthResult>;
  loginWithPhonePassword(body: import('./auth.schemas.js').PhoneLoginInput, deviceInfo?: string): Promise<AuthResult>;
  sendOtp(phone: string, userIdBinding?: string): Promise<{ expiresInSec: number }>;
  sendTelegramOtp(phone: string): Promise<{ expiresInSec: number }>;
  sendPhoneAddOtp(userId: string, phone: string): Promise<{ expiresInSec: number }>;
  bindVerifiedPhone(userId: string, phone: string): Promise<{ id: string }>;
  confirmPhoneFromTelegramContact(userId: string, response: string, deviceInfo?: string): Promise<AuthResult>;
  initTelegramLink(phone: string): Promise<{ token: string; deepLink: string; expiresInSec: number }>;
  getTelegramLinkStatus(token: string): Promise<{ status: 'waiting' | 'sent' | 'expired' }>;
  checkPhone(phone: string): Promise<{ exists: boolean; hasPassword: boolean; hasTelegram: boolean }>;
  verifyOtp(
    phone: string,
    code: string,
    provisionalUserId: string | null,
    provider: Provider,
    deviceInfo?: string,
  ): Promise<AuthResult>;
  registerWithPhone(
    phone: string,
    code: string,
    name: string,
    surname: string,
    plainPassword: string | undefined,
    deviceInfo?: string,
  ): Promise<AuthResult>;
  refresh(token: string, deviceInfo: string | undefined, ip: string | null): Promise<TokenPair>;
  logout(token: string): Promise<void>;
  logoutAll(userId: string): Promise<void>;
  adminLogin(email: string, plainPassword: string, totp?: string): Promise<AdminAuthResult>;
  adminRefresh(token: string): Promise<AdminRefreshResult>;
  adminChangePassword(adminId: string, currentPassword: string, newPassword: string): Promise<void>;
  setPassword(userId: string, newPassword: string, currentPassword?: string): Promise<void>;
  resetPassword(userId: string, newPassword: string): Promise<void>;
  startPhoneChange(
    userId: string,
    body: import('./auth.schemas.js').StartPhoneChangeInput,
  ): Promise<{ expiresInSec: number }>;
  confirmPhoneChange(
    userId: string,
    newPhone: string,
    code: string,
    deviceInfo?: string,
  ): Promise<AuthResult>;
  addProvider(userId: string, body: import('./auth.schemas.js').AddProviderInput): Promise<{ provider: Provider }>;
  removeProvider(userId: string, provider: Provider): Promise<void>;
  initBotLogin(): Promise<{ token: string; deepLink: string; expiresInSec: number }>;
  getBotLoginStatus(token: string): Promise<{ status: 'waiting' | 'done' | 'expired' | 'not_found' }>;
  claimBotLogin(token: string, deviceInfo?: string): Promise<AuthResult>;
}
