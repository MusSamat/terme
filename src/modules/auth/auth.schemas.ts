import { z } from 'zod';

// Phone is E.164. Kyrgyz numbers (+996) must be exactly 9 national digits;
// any other country code follows general E.164 (7–15 digits total). Name kept
// as KgPhoneSchema so existing imports don't change.
export const KgPhoneSchema = z
  .string()
  .regex(/^(?:\+996\d{9}|\+(?!996)[1-9]\d{6,14})$/, 'phone must be E.164 (e.g. +996XXXXXXXXX)');

const PasswordSchema = z.string().min(8).max(200).regex(/\d/, 'password must contain a digit');

// Web sign-in.
export const PhoneLoginBody = z.object({
  phone: KgPhoneSchema,
  password: z.string().min(1).max(200),
});

// «Forgot password» / first password: WhatsApp code to the account's number.
export const ResetPasswordBody = z.object({
  phone: KgPhoneSchema,
  code: z.string().regex(/^\d{6}$/, 'code must be 6 digits'),
  newPassword: PasswordSchema,
});

export const ChangePasswordBody = z.object({
  currentPassword: z.string().min(1).max(200),
  newPassword: PasswordSchema,
  // web → the new refresh token goes into the HttpOnly cookie (M2).
  channel: z.enum(['mobile', 'web']).default('mobile'),
});

export const SendOtpBody = z.object({
  phone: KgPhoneSchema,
});

// Registration: phone + WhatsApp code + profile in one step. The code is
// validated here (not via /phone/verify) so no account exists before the user
// commits a name. Web also sends a password (its login method); mobile doesn't.
export const RegisterBody = z.object({
  phone: KgPhoneSchema,
  code: z.string().regex(/^\d{6}$/, 'code must be 6 digits'),
  name: z.string().trim().min(1).max(100),
  surname: z.string().trim().min(1).max(100),
  password: PasswordSchema.optional(),
  channel: z.enum(['mobile', 'web']).default('mobile'),
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

// Phone change: the session authenticates the caller, a WhatsApp code to the
// NEW number (sent here, confirmed by ConfirmPhoneChangeBody) proves possession.
export const StartPhoneChangeBody = z.object({
  newPhone: KgPhoneSchema,
});

export const ConfirmPhoneChangeBody = z.object({
  newPhone: KgPhoneSchema,
  code: z.string().regex(/^\d{6}$/),
});

export type SendOtpInput = z.infer<typeof SendOtpBody>;
export type RegisterInput = z.infer<typeof RegisterBody>;
export type VerifyOtpInput = z.infer<typeof VerifyOtpBody>;
export type RefreshInput = z.infer<typeof RefreshBody>;
export type LogoutInput = z.infer<typeof LogoutBody>;
export const AdminChangePasswordBody = z.object({
  currentPassword: z.string().min(8).max(200),
  newPassword: z.string().min(12).max(200),
});

export const AdminTotpConfirmBody = z.object({
  code: z.string().regex(/^\d{6}$/),
  channel: z.enum(['mobile', 'web']).default('mobile'),
});

// Self-disable needs a current code; a superadmin passes adminId (no code).
export const AdminTotpDisableBody = z
  .object({
    adminId: z.string().uuid().optional(),
    code: z.string().regex(/^\d{6}$/).optional(),
  })
  .refine((b) => b.adminId || b.code, { message: 'adminId or code required' });

export const AdminLogoutBody = z.object({
  refreshToken: z.string().min(1).optional(),
  channel: z.enum(['mobile', 'web']).default('mobile'),
});

export type AdminLoginInput = z.infer<typeof AdminLoginBody>;
export type AdminRefreshInput = z.infer<typeof AdminRefreshBody>;
export type StartPhoneChangeInput = z.infer<typeof StartPhoneChangeBody>;
export type ConfirmPhoneChangeInput = z.infer<typeof ConfirmPhoneChangeBody>;
