import { Router, type Request } from 'express';
import crypto from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { env } from '@/config/env.js';
import { logger } from '@/lib/logger.js';
import { ingestWebhook, type WaWebhookBody } from './whatsapp.service.js';

// Meta signs every POST with HMAC-SHA256 over the raw body, sent as
// `X-Hub-Signature-256: sha256=<hex>`. We compare against WHATSAPP_APP_SECRET.
// Skipped when APP_SECRET is empty (initial dashboard testing before secrets
// are wired) — logged so it's obvious the check is off.
function verifySignature(req: Request): boolean {
  if (!env.WHATSAPP_APP_SECRET) {
    logger.warn('whatsapp: WHATSAPP_APP_SECRET unset — skipping signature check');
    return true;
  }
  const header = req.get('x-hub-signature-256');
  const raw = (req as Request & { rawBody?: Buffer }).rawBody;
  if (!header || !raw) return false;

  const expected =
    'sha256=' + crypto.createHmac('sha256', env.WHATSAPP_APP_SECRET).update(raw).digest('hex');
  const a = Buffer.from(header);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
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
    if (!verifySignature(req)) {
      res.sendStatus(403);
      return;
    }
    res.sendStatus(200);
    void ingestWebhook(prisma, req.body as WaWebhookBody).catch((err) => {
      logger.error({ err }, 'whatsapp: webhook ingest failed');
    });
  });

  return router;
}
