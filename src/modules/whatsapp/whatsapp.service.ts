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

// Forward-only ranking so an out-of-order webhook (e.g. a late `delivered`
// arriving after `read`) never downgrades a message's status.
const STATUS_RANK: Record<string, number> = { SENT: 1, DELIVERED: 2, READ: 3, FAILED: 4 };
function statusRank(s: string | null): number {
  return s ? (STATUS_RANK[s] ?? 0) : 0;
}

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

  const existing = await prisma.whatsappMessage.findUnique({
    where: { whatsappMessageId: s.id },
    select: { id: true, status: true },
  });

  // Normal path: our OUTBOUND row exists → advance status forward-only.
  if (existing) {
    if (statusRank(mapped) > statusRank(existing.status)) {
      await prisma.whatsappMessage.update({ where: { id: existing.id }, data: { status: mapped } });
    }
    return;
  }

  // Race: Meta can deliver the `sent`/`delivered` status webhook before the
  // reply endpoint's row-save commits. Without a placeholder the status would be
  // lost forever (updateMany no-op) and the bubble would stay stuck at SENT.
  // Create a minimal OUTBOUND placeholder keyed by wamid; the reply upsert fills
  // the body afterwards. recipient_id is the customer's number = conversation.
  if (!s.recipient_id) return;
  const conversation = await prisma.whatsappConversation.upsert({
    where: { phoneNumber: s.recipient_id },
    update: {},
    create: { phoneNumber: s.recipient_id },
  });
  try {
    await prisma.whatsappMessage.create({
      data: {
        conversationId: conversation.id,
        direction: 'OUTBOUND',
        body: '',
        status: mapped,
        whatsappMessageId: s.id,
      },
    });
  } catch {
    // Lost the create race with the reply endpoint — the row now exists; apply
    // the status as an update instead.
    await prisma.whatsappMessage.updateMany({
      where: { whatsappMessageId: s.id },
      data: { status: mapped },
    });
  }
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
