import { Router } from 'express';
import type { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { validate } from '@/middleware/validate.js';
import { asyncHandler } from '@/middleware/errorHandler.js';
import { Errors } from '@/lib/errors.js';
import { sendWhatsappText } from '@/lib/whatsapp.js';

const IdParam = z.object({ id: z.string().uuid() });
// WhatsApp text messages cap at 4096 chars.
const ReplyBody = z.object({ text: z.string().trim().min(1).max(4096) });

/**
 * Admin WhatsApp inbox API. Mounted under the admin router, which already
 * applies requireAdmin — no auth is re-applied here.
 */
export function createWhatsappAdminRouter(prisma: PrismaClient): Router {
  const router = Router();

  // List conversations, newest activity first, each with a last-message preview.
  router.get(
    '/conversations',
    asyncHandler(async (_req, res) => {
      const rows = await prisma.whatsappConversation.findMany({
        orderBy: { lastMessageAt: 'desc' },
        take: 200,
        include: { messages: { orderBy: { createdAt: 'desc' }, take: 1 } },
      });
      res.json(
        rows.map((c) => ({
          id: c.id,
          phoneNumber: c.phoneNumber,
          lastMessageAt: c.lastMessageAt,
          lastMessagePreview: c.messages[0]?.body ?? null,
        })),
      );
    }),
  );

  // Full message thread for one conversation, oldest first.
  router.get(
    '/conversations/:id/messages',
    validate({ params: IdParam }),
    asyncHandler(async (req, res) => {
      const conversation = await prisma.whatsappConversation.findUnique({
        where: { id: req.params.id! },
      });
      if (!conversation) throw Errors.notFound('Conversation');
      const messages = await prisma.whatsappMessage.findMany({
        where: { conversationId: conversation.id },
        orderBy: { createdAt: 'asc' },
      });
      res.json(messages);
    }),
  );

  // Send a free-text reply via the Cloud API, then persist it as OUTBOUND.
  // Send-first, save-after: if the 24h window is closed sendWhatsappText throws
  // WHATSAPP_WINDOW_EXPIRED (409) and nothing is written.
  router.post(
    '/conversations/:id/reply',
    validate({ params: IdParam, body: ReplyBody }),
    asyncHandler(async (req, res) => {
      const conversation = await prisma.whatsappConversation.findUnique({
        where: { id: req.params.id! },
      });
      if (!conversation) throw Errors.notFound('Conversation');

      const { text } = req.body as z.infer<typeof ReplyBody>;
      const { wamid } = await sendWhatsappText(conversation.phoneNumber, text);

      // Upsert (not create) by wamid: a delivery-status webhook for this message
      // can race ahead and create a placeholder row first (see ingestStatus). If
      // so, fill in the body but keep the already-advanced status — don't reset
      // it to SENT. Upsert also avoids a unique-collision 500 on that race.
      const message = await prisma.whatsappMessage.upsert({
        where: { whatsappMessageId: wamid },
        update: { body: text, conversationId: conversation.id, direction: 'OUTBOUND' },
        create: {
          conversationId: conversation.id,
          direction: 'OUTBOUND',
          body: text,
          status: 'SENT',
          whatsappMessageId: wamid,
        },
      });
      await prisma.whatsappConversation.update({
        where: { id: conversation.id },
        data: { lastMessageAt: message.createdAt },
      });

      res.status(201).json(message);
    }),
  );

  return router;
}
