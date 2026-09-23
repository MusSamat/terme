import type { ErrorRequestHandler, RequestHandler } from 'express';
import { AppError, Errors, type ErrorCodeValue } from '@/lib/errors.js';
import { translateError } from '@/lib/i18n.js';
import { logger } from '@/lib/logger.js';
import { isProd } from '@/config/env.js';
import { captureException } from '@/lib/sentry.js';

/**
 * Wrap an async handler so uncaught promise rejections flow into express's
 * error pipeline. Avoids repeating try/catch in every handler.
 */
export function asyncHandler(
  fn: (
    req: import('express').Request,
    res: import('express').Response,
    next: import('express').NextFunction,
  ) => unknown | Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

/**
 * 404 fallback for anything not matched by the router. Always ends in
 * globalErrorHandler so the response format is consistent.
 */
export const notFoundHandler: RequestHandler = (_req, _res, next) => {
  next(Errors.notFound('Route'));
};

/**
 * Global error formatter. TZ §22.2 defines the exact JSON shape:
 *   { error: { code, message, message_ky, details, request_id } }
 * Note: message is in the request's locale; the Kyrgyz translation is always
 * also provided. We emit it under BOTH `message_ky` (the TZ contract / ISO
 * 639-1 code) and the legacy `message_kg` key so existing clients keep working
 * while the platform converges on `ky`.
 */
export const globalErrorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  const appError = toAppError(err);

  const messageRu = translateError(appError.code as ErrorCodeValue, 'ru');
  const messageKg = translateError(appError.code as ErrorCodeValue, 'kg');
  const localised = req.locale === 'kg' ? messageKg : messageRu;

  const logPayload = {
    request_id: req.requestId,
    user_id: req.user?.id ?? req.admin?.id,
    code: appError.code,
    status: appError.httpStatus,
    path: req.originalUrl,
    method: req.method,
    stack: appError.httpStatus >= 500 ? (err instanceof Error ? err.stack : undefined) : undefined,
    details: appError.details,
  };

  if (appError.httpStatus >= 500) {
    logger.error(logPayload, 'request failed');
    // Only real faults reach Sentry: every 5xx (whether a deliberate 5xx
    // AppError or an unexpected throw mapped to INTERNAL_ERROR). Deliberate
    // 4xx AppErrors (validation, auth, conflict …) are expected control flow.
    captureException(err);
  } else logger.warn(logPayload, 'request rejected');

  res.status(appError.httpStatus).json({
    error: {
      code: appError.code,
      message: localised,
      message_ky: messageKg, // TZ §22.2 contract key (ISO 639-1)
      message_kg: messageKg, // legacy alias — kept until clients migrate to ky
      ...(appError.details ? { details: appError.details } : {}),
      request_id: req.requestId,
    },
  });
};

function toAppError(err: unknown): AppError {
  if (err instanceof AppError) return err;
  // express.json() throws SyntaxError for malformed JSON bodies — surface
  // as a validation error so clients don't see a 500.
  if (err instanceof SyntaxError && 'body' in (err as object)) {
    return Errors.validation({ reason: 'malformed_json' });
  }
  // Multer limits (file too big, too many files) — a client error, not a 500.
  if (err instanceof Error && err.name === 'MulterError') {
    const code = (err as { code?: string }).code;
    return Errors.validation({
      reason: code === 'LIMIT_FILE_SIZE' ? 'file_too_large' : 'upload_rejected',
      multer_code: code ?? null,
    });
  }
  if (err instanceof Error) {
    return new AppError('INTERNAL_ERROR', isProd ? 'Internal server error' : err.message);
  }
  return Errors.internal();
}
