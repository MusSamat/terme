import { Router } from 'express';
import type { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { validate } from '@/middleware/validate.js';
import { asyncHandler } from '@/middleware/errorHandler.js';
import { createWhatsappInboxService } from './whatsapp.service.js';

const IdParam = z.object({ id: z.string().uuid() });
// WhatsApp text messages cap at 4096 chars.
const ReplyBody = z.object({ text: z.string().trim().min(1).max(4096) });

/**
 * Admin WhatsApp inbox API. Mounted under the admin router, which already
 * applies requireAdmin — no auth is re-applied here.
 */
export function createWhatsappAdminRouter(prisma: PrismaClient): Router {
  const router = Router();
  const service = createWhatsappInboxService(prisma);

  router.get(
    '/conversations',
    asyncHandler(async (_req, res) => {
      res.json(await service.listConversations());
    }),
  );

  router.get(
    '/conversations/:id/messages',
    validate({ params: IdParam }),
    asyncHandler(async (req, res) => {
      res.json(await service.listMessages(req.params.id!));
    }),
  );

  router.post(
    '/conversations/:id/reply',
    validate({ params: IdParam, body: ReplyBody }),
    asyncHandler(async (req, res) => {
      const { text } = req.body as z.infer<typeof ReplyBody>;
      res.status(201).json(await service.reply(req.params.id!, text));
    }),
  );

  return router;
}
