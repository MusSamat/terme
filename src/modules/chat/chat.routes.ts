import { Router } from 'express';
import type { PrismaClient } from '@prisma/client';
import { createChatService } from './chat.service.js';
import {
  BookingIdParam,
  MessageIdParam,
  MessagesQuery,
  SendMessageBody,
} from './chat.schemas.js';
import { validate } from '@/middleware/validate.js';
import { asyncHandler } from '@/middleware/errorHandler.js';
import { requireAuth } from '@/middleware/auth.js';
import type { Notifier } from '@/lib/notifier.js';
import { chatSendLimit } from '@/middleware/rateLimit.js';

export function createChatsRouter(prisma: PrismaClient, notifier: Notifier): Router {
  const router = Router();
  const service = createChatService(prisma, notifier);

  router.get(
    '/summaries',
    requireAuth,
    asyncHandler(async (req, res) => {
      const chats = await service.summaries(req.user!.id);
      res.json({ chats });
    }),
  );

  router.get(
    '/unread-counts',
    requireAuth,
    asyncHandler(async (req, res) => {
      const counts = await service.unreadCounts(req.user!.id);
      res.json({ counts });
    }),
  );

  router.patch(
    '/:booking_id/read-all',
    requireAuth,
    validate({ params: BookingIdParam }),
    asyncHandler(async (req, res) => {
      const count = await service.markAllRead(req.params.booking_id!, req.user!.id);
      res.json({ count });
    }),
  );

  router.get(
    '/:booking_id/messages',
    requireAuth,
    validate({ params: BookingIdParam, query: MessagesQuery }),
    asyncHandler(async (req, res) => {
      const result = await service.history(req.params.booking_id!, req.user!.id, {
        cursor: (req.query as unknown as { cursor?: string }).cursor,
        limit: (req.query as unknown as { limit: number }).limit,
      });
      res.json(result);
    }),
  );

  router.post(
    '/:booking_id/messages',
    requireAuth,
    chatSendLimit,
    validate({ params: BookingIdParam, body: SendMessageBody }),
    asyncHandler(async (req, res) => {
      const { text, clientMsgId } = req.body as { text: string; clientMsgId?: string };
      const result = await service.send(req.params.booking_id!, req.user!.id, text, clientMsgId);
      res.status(201).json(result);
    }),
  );

  return router;
}

// /messages/:id/read lives outside /chats — matches TZ §19.2.
export function createMessagesRouter(prisma: PrismaClient, notifier: Notifier): Router {
  const router = Router();
  const service = createChatService(prisma, notifier);

  router.patch(
    '/:id/read',
    requireAuth,
    validate({ params: MessageIdParam }),
    asyncHandler(async (req, res) => {
      const msg = await service.markRead(req.params.id!, req.user!.id);
      res.json(msg);
    }),
  );

  return router;
}
