import type { PrismaClient } from '@prisma/client';
import { logger } from '@/lib/logger.js';

// ─── Meta webhook payload shapes (only the fields we read) ─────────────────
interface WaTextMessage {
  from: string;
  id: string;
  type: string;
  text?: { body: string };
}
interface WaStatus {
  id: string;
  status: string; // sent | delivered | read | failed
  recipient_id?: string;
}
interface WaValue {
  messages?: WaTextMessage[];
  statuses?: WaStatus[];
}
interface WaChange {
  field?: string;
  value?: WaValue;
}
interface WaEntry {
  changes?: WaChange[];
}
export interface WaWebhookBody {
  object?: string;
  entry?: WaEntry[];
}

const STATUS_MAP: Record<string, string> = {
  sent: 'SENT',
  delivered: 'DELIVERED',
  read: 'READ',
  failed: 'FAILED',
};

// Non-text messages (image/audio/location/…) have no body — store a marker so
// the inbox thread shows something rather than an empty bubble.
function extractBody(m: WaTextMessage): string {
  if (m.type === 'text' && m.text?.body) return m.text.body;
  return `[${m.type ?? 'unknown'}]`;
}

async function ingestInbound(prisma: PrismaClient, m: WaTextMessage): Promise<void> {
  const conversation = await prisma.whatsappConversation.upsert({
    where: { phoneNumber: m.from },
    update: { lastMessageAt: new Date() },
    create: { phoneNumber: m.from },
  });

  // wamid is unique → upsert makes redelivered webhooks idempotent (Meta retries
  // until it gets a 200, and may double-deliver).
  await prisma.whatsappMessage.upsert({
    where: { whatsappMessageId: m.id },
    update: {},
    create: {
      conversationId: conversation.id,
      direction: 'INBOUND',
      body: extractBody(m),
      whatsappMessageId: m.id,
    },
  });
}

async function ingestStatus(prisma: PrismaClient, s: WaStatus): Promise<void> {
  const mapped = STATUS_MAP[s.status];
  if (!mapped) return;
  // Match our OUTBOUND row by wamid. updateMany (not update) so a status for an
  // unknown message id is a silent no-op instead of a throw.
  await prisma.whatsappMessage.updateMany({
    where: { whatsappMessageId: s.id, direction: 'OUTBOUND' },
    data: { status: mapped },
  });
}

/**
 * Process a full Meta webhook body: persist inbound messages and apply status
 * updates. Errors are logged, not thrown — the caller has already replied 200
 * to Meta and we must not crash the request.
 */
export async function ingestWebhook(prisma: PrismaClient, body: WaWebhookBody): Promise<void> {
  const changes = (body.entry ?? []).flatMap((e) => e.changes ?? []);
  for (const change of changes) {
    const value = change.value;
    if (!value) continue;
    for (const m of value.messages ?? []) {
      try {
        await ingestInbound(prisma, m);
      } catch (err) {
        logger.error({ err, wamid: m.id }, 'whatsapp: failed to ingest inbound message');
      }
    }
    for (const s of value.statuses ?? []) {
      try {
        await ingestStatus(prisma, s);
      } catch (err) {
        logger.error({ err, wamid: s.id }, 'whatsapp: failed to apply status update');
      }
    }
  }
}
