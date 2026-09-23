import type { RequestHandler } from 'express';
import { generateUuid } from '@/lib/random.js';
import { parseAcceptLanguage } from '@/lib/i18n.js';
import { logger } from '@/lib/logger.js';

/**
 * Attach a stable request_id and derived locale to every request + set the
 * X-Request-Id response header so clients can quote it in support tickets
 * (TZ §22.2 "request_id: uuid-для-саппорта").
 */
export const requestContext: RequestHandler = (req, res, next) => {
  // Accept an incoming request id if the reverse proxy/client provided one —
  // this preserves trace continuity. Otherwise mint a fresh UUID v4.
  // Constrain the charset (hex + dash) AND cap the length (8..200) so a
  // malicious client can't inject newlines/control chars or an unbounded blob
  // into structured logs (log injection / memory pressure).
  const inbound = req.header('x-request-id');
  const requestId =
    inbound && /^[a-f0-9-]{8,200}$/i.test(inbound) ? inbound : generateUuid();

  req.requestId = requestId;
  req.locale = parseAcceptLanguage(req.header('accept-language'));
  res.setHeader('X-Request-Id', requestId);

  const start = process.hrtime.bigint();

  res.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - start) / 1_000_000;
    logger.info(
      {
        request_id: requestId,
        user_id: req.user?.id ?? req.admin?.id,
        method: req.method,
        path: req.originalUrl,
        status: res.statusCode,
        duration_ms: Number(durationMs.toFixed(1)),
        locale: req.locale,
      },
      'request',
    );
  });

  next();
};
