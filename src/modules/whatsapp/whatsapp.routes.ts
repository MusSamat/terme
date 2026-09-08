import { Router, type Request } from 'express';
import crypto from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { env } from '@/config/env.js';
import { logger } from '@/lib/logger.js';
import { ingestWebhook, type WaWebhookBody } from './whatsapp.service.js';

// Meta signs every POST with HMAC-SHA256 over the raw body, sent as
// `X-Hub-Signature-256: sha256=<hex>`. We compare against WHATSAPP_APP_SECRET.
// The HMAC is computed over the RAW bytes captured in express.json's `verify`
// hook (server.ts) — never over JSON.stringify(req.body), which would reorder
// keys / change whitespace and never match.
//
// ⚠️ TEMPORARY DIAGNOSTIC MODE: on mismatch we LOG both signatures and proceed
// (non-blocking) instead of returning 403, so no inbound messages are lost while
// we debug. REVERT to blocking (see the POST handler) once the mismatch is
// understood. Logs land in `pm2 logs terme-api`.
function checkSignature(req: Request): boolean {
  if (!env.WHATSAPP_APP_SECRET) {
    logger.warn('whatsapp: WHATSAPP_APP_SECRET unset — skipping signature check');
    return true;
  }
  const header = req.get('x-hub-signature-256');
  const raw = (req as Request & { rawBody?: Buffer }).rawBody;
  const expected = raw
    ? 'sha256=' + crypto.createHmac('sha256', env.WHATSAPP_APP_SECRET).update(raw).digest('hex')
    : null;

  const ok =
    !!header &&
    !!expected &&
    header.length === expected.length &&
    crypto.timingSafeEqual(Buffer.from(header), Buffer.from(expected));

  if (!ok) {
    logger.warn(
      {
        received: header ?? '(no header)',
        expected: expected ?? '(no rawBody captured)',
        hasRawBody: !!raw,
        rawBodyPreview: raw ? raw.toString('utf8').slice(0, 200) : null,
        appSecretLen: env.WHATSAPP_APP_SECRET.length,
      },
      'whatsapp: SIGNATURE MISMATCH (diagnostic — compare received vs expected)',
    );
  }
  return ok;
}

export function createWhatsappRouter(prisma: PrismaClient): Router {
  const router = Router();

  // GET — webhook verification handshake. Meta calls this once when you save the
  // Callback URL: echo hub.challenge iff the verify token matches ours.
  router.get('/webhook', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (!env.WHATSAPP_VERIFY_TOKEN) {
      logger.error('whatsapp: WHATSAPP_VERIFY_TOKEN unset — cannot verify webhook');
      res.sendStatus(500);
      return;
    }
    if (mode === 'subscribe' && token === env.WHATSAPP_VERIFY_TOKEN) {
      res.status(200).send(String(challenge ?? ''));
      return;
    }
    res.sendStatus(403);
  });

  // POST — incoming messages + delivery-status updates. Reply 200 immediately
  // (Meta retries on any non-200 / slow response), then persist off the request.
  router.post('/webhook', (req, res) => {
    const signatureOk = checkSignature(req);
    // ⚠️ TEMPORARY: proceed even on a bad signature so we don't drop inbound
    // traffic while debugging. To RESTORE security, replace the line below with:
    //   if (!signatureOk) { res.sendStatus(403); return; }
    if (!signatureOk) {
      logger.warn('whatsapp: proceeding despite signature mismatch (TEMP non-blocking mode)');
    }
    res.sendStatus(200);
    void ingestWebhook(prisma, req.body as WaWebhookBody).catch((err) => {
      logger.error({ err }, 'whatsapp: webhook ingest failed');
    });
  });

  return router;
}
