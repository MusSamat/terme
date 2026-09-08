// Full error code catalog from TZ §22.3. One AppError class, one translation
// layer, one global handler — every response in the app funnels through this.

export const ErrorCode = {
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  UNAUTHORIZED: 'UNAUTHORIZED',
  TOKEN_EXPIRED: 'TOKEN_EXPIRED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  SEATS_NOT_AVAILABLE: 'SEATS_NOT_AVAILABLE',
  BOOKING_ALREADY_EXISTS: 'BOOKING_ALREADY_EXISTS',
  TRIP_NOT_ACTIVE: 'TRIP_NOT_ACTIVE',
  RATE_LIMITED: 'RATE_LIMITED',
  OTP_EXPIRED: 'OTP_EXPIRED',
  OTP_WRONG: 'OTP_WRONG',
  OTP_TOO_MANY_ATTEMPTS: 'OTP_TOO_MANY_ATTEMPTS',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
  WHATSAPP_WINDOW_EXPIRED: 'WHATSAPP_WINDOW_EXPIRED',
} as const;

export type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode];

const HTTP_STATUS: Record<ErrorCodeValue, number> = {
  VALIDATION_ERROR: 400,
  UNAUTHORIZED: 401,
  TOKEN_EXPIRED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  SEATS_NOT_AVAILABLE: 409,
  BOOKING_ALREADY_EXISTS: 409,
  TRIP_NOT_ACTIVE: 409,
  RATE_LIMITED: 429,
  OTP_EXPIRED: 410,
  OTP_WRONG: 400,
  OTP_TOO_MANY_ATTEMPTS: 429,
  INTERNAL_ERROR: 500,
  SERVICE_UNAVAILABLE: 503,
  WHATSAPP_WINDOW_EXPIRED: 409,
};

export class AppError extends Error {
  readonly code: ErrorCodeValue;
  readonly httpStatus: number;
  readonly details?: Record<string, unknown>;

  constructor(code: ErrorCodeValue, messageFallback: string, details?: Record<string, unknown>) {
    super(messageFallback);
    this.name = 'AppError';
    this.code = code;
    this.httpStatus = HTTP_STATUS[code];
    this.details = details;
  }
}

export function httpStatusForCode(code: ErrorCodeValue): number {
  return HTTP_STATUS[code];
}

// Narrow helpers — convey intent at call sites.
// ─── Tiny helper not strictly about errors, but about consistently hiding
// phone-column placeholders from API responses. Telegram-only users have
// "+tg:<id>" until they verify a phone; soft-deleted users have "+del:<rand>".
export function publicPhone(stored: string): string {
  return stored.startsWith('+tg:') || stored.startsWith('+del:') || stored.startsWith('+prov:')
    ? ''
    : stored;
}

export const Errors = {
  validation: (details?: Record<string, unknown>) =>
    new AppError('VALIDATION_ERROR', 'Invalid request', details),
  unauthorized: (details?: Record<string, unknown>) =>
    new AppError('UNAUTHORIZED', 'Authentication required', details),
  tokenExpired: () => new AppError('TOKEN_EXPIRED', 'Access token has expired'),
  forbidden: (details?: Record<string, unknown>) =>
    new AppError('FORBIDDEN', 'Forbidden', details),
  notFound: (resource: string) => new AppError('NOT_FOUND', `${resource} not found`),
  conflict: (msg = 'Conflict', details?: Record<string, unknown>) =>
    new AppError('CONFLICT', msg, details),
  seatsNotAvailable: (details?: Record<string, unknown>) =>
    new AppError('SEATS_NOT_AVAILABLE', 'No seats available', details),
  bookingAlreadyExists: () =>
    new AppError('BOOKING_ALREADY_EXISTS', 'You already have an active booking on this trip'),
  tripNotActive: () => new AppError('TRIP_NOT_ACTIVE', 'Trip is not active'),
  rateLimited: (details?: Record<string, unknown>) =>
    new AppError('RATE_LIMITED', 'Too many requests', details),
  otpExpired: () => new AppError('OTP_EXPIRED', 'OTP expired'),
  otpWrong: () => new AppError('OTP_WRONG', 'Wrong OTP'),
  otpTooManyAttempts: () => new AppError('OTP_TOO_MANY_ATTEMPTS', 'Too many OTP attempts'),
  internal: (msg = 'Internal server error') => new AppError('INTERNAL_ERROR', msg),
  serviceUnavailable: (msg = 'Service unavailable') => new AppError('SERVICE_UNAVAILABLE', msg),
  whatsappWindowExpired: (details?: Record<string, unknown>) =>
    new AppError('WHATSAPP_WINDOW_EXPIRED', '24-hour window expired, a template message is required', details),
} as const;
