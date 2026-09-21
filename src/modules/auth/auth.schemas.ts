import { z } from 'zod';

// Phone is E.164. Kyrgyz numbers (+996) must be exactly 9 national digits;
// any other country code follows general E.164 (7–15 digits total). Name kept
// as KgPhoneSchema so existing imports don't change.
export const KgPhoneSchema = z
  .string()
  .regex(/^(?:\+996\d{9}|\+(?!996)[1-9]\d{6,14})$/, 'phone must be E.164 (e.g. +996XXXXXXXXX)');

// TZ §8.2.1 — Telegram initData comes as a URL-encoded query string.
export const TelegramLoginBody = z.object({
  initData: z.string().min(1).max(8192),
});

// TZ v2.1 §8.3 — Google & Apple OAuth.
export const GoogleLoginBody = z.object({
  idToken: z.string().min(1).max(8192),
});

export const AppleLoginBody = z.object({
  identityToken: z.string().min(1).max(8192),
});

// TZ v2.1 §8.4 — phone + password repeat login.
export const PhoneLoginBody = z.object({
  phone: KgPhoneSchema,
  password: z.string().min(1).max(200),
});

export const SendOtpBody = z.object({
  phone: KgPhoneSchema,
});

// Classical registration: phone + Telegram OTP + profile + password, all in one
// step. The OTP is validated here (not via /phone/verify) so no account is
// silently created before the user commits name/surname/password.
export const RegisterBody = z.object({
  phone: KgPhoneSchema,
  code: z.string().regex(/^\d{6}$/, 'code must be 6 digits'),
  name: z.string().trim().min(1).max(100),
  surname: z.string().trim().min(1).max(100),
  // Optional: mobile registers passwordless (phone+OTP only); web sends a password.
  password: z.string().min(8).max(200).regex(/\d/, 'password must contain a digit').optional(),
  channel: z.enum(['mobile', 'web']).default('mobile'),
});

export const PhoneFromTelegramBody = z.object({
  // Signed URLSearchParams payload from WebApp.requestContact()
  response: z.string().min(20).max(4096),
});

export const CheckPhoneBody = z.object({
  phone: KgPhoneSchema,
});

export const VerifyOtpBody = z.object({
  phone: KgPhoneSchema,
  code: z.string().regex(/^\d{6}$/, 'code must be 6 digits'),
  // Channel is retained for device-info audit purposes but no longer drives
  // refresh TTL (v2.1 refresh extends on activity regardless of channel).
  channel: z.enum(['mobile', 'web']).default('mobile'),
  deviceInfo: z.string().max(300).optional(),
});

// refreshToken is optional: web clients (channel = 'web') carry it in an
// HttpOnly cookie instead of the body.
export const RefreshBody = z.object({
  refreshToken: z.string().min(1).optional(),
  channel: z.enum(['mobile', 'web']).default('mobile'),
});

export const LogoutBody = z.object({
  refreshToken: z.string().min(1).optional(),
  channel: z.enum(['mobile', 'web']).default('mobile'),
});

export const AdminLoginBody = z.object({
  email: z.string().email().max(200),
  password: z.string().min(8).max(200),
  totp: z
    .string()
    .regex(/^\d{6}$/)
    .optional(),
  channel: z.enum(['mobile', 'web']).default('mobile'),
});

export const AdminRefreshBody = z.object({
  refreshToken: z.string().min(1).optional(),
  channel: z.enum(['mobile', 'web']).default('mobile'),
});

// TZ v2.1 §8.12 — /users/me/password.
// Covers both flows: setting a password for the first time (no current) and
// changing it (current required). We keep a single schema and branch in the
// service — simpler than two near-identical endpoints.
export const SetPasswordBody = z.object({
  currentPassword: z.string().max(200).optional(),
  newPassword: z.string().min(8).max(200).regex(/\d/, 'password must contain a digit'),
});

// TZ v2.1 §8.7 — phone change. Current-provider re-auth token is passed
// separately; the endpoint issues OTP to the NEW number, and a follow-up
// /verify-phone-change call completes it.
export const StartPhoneChangeBody = z.object({
  newPhone: KgPhoneSchema,
  reAuthProof: z.discriminatedUnion('provider', [
    z.object({ provider: z.literal('telegram'), initData: z.string().min(1).max(8192) }),
    z.object({ provider: z.literal('google'), idToken: z.string().min(1).max(8192) }),
    z.object({ provider: z.literal('apple'), identityToken: z.string().min(1).max(8192) }),
    z.object({ provider: z.literal('phone'), password: z.string().min(1).max(200) }),
  ]),
});

export const ConfirmPhoneChangeBody = z.object({
  newPhone: KgPhoneSchema,
  code: z.string().regex(/^\d{6}$/),
});

// TZ v2.1 §8.12 — /users/me/providers (link new OAuth).
export const AddProviderBody = z.discriminatedUnion('provider', [
  z.object({ provider: z.literal('telegram'), initData: z.string().min(1).max(8192) }),
  z.object({ provider: z.literal('google'), idToken: z.string().min(1).max(8192) }),
  z.object({ provider: z.literal('apple'), identityToken: z.string().min(1).max(8192) }),
]);

export const RemoveProviderParam = z.object({
  provider: z.enum(['telegram', 'google', 'apple', 'phone']),
});

export type TelegramLoginInput = z.infer<typeof TelegramLoginBody>;
export type GoogleLoginInput = z.infer<typeof GoogleLoginBody>;
export type AppleLoginInput = z.infer<typeof AppleLoginBody>;
export type PhoneLoginInput = z.infer<typeof PhoneLoginBody>;
export type SendOtpInput = z.infer<typeof SendOtpBody>;
export type RegisterInput = z.infer<typeof RegisterBody>;
export type VerifyOtpInput = z.infer<typeof VerifyOtpBody>;
export type RefreshInput = z.infer<typeof RefreshBody>;
export type LogoutInput = z.infer<typeof LogoutBody>;
export const AdminChangePasswordBody = z.object({
  currentPassword: z.string().min(8).max(200),
  newPassword: z.string().min(12).max(200),
});

export type AdminLoginInput = z.infer<typeof AdminLoginBody>;
export type AdminRefreshInput = z.infer<typeof AdminRefreshBody>;
export type SetPasswordInput = z.infer<typeof SetPasswordBody>;
export type StartPhoneChangeInput = z.infer<typeof StartPhoneChangeBody>;
export type ConfirmPhoneChangeInput = z.infer<typeof ConfirmPhoneChangeBody>;
export type AddProviderInput = z.infer<typeof AddProviderBody>;
