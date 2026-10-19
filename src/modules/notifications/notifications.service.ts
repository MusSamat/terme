import type { Notification, PrismaClient } from '@prisma/client';
import { Errors } from '@/lib/errors.js';
import { cursorArgs, sliceAndNext } from '@/lib/pagination.js';

// Types that live in the notifications table for admin triage / trace history
// but must never surface in a user's in-app feed — e.g. the 24h verification
// SLA-breach escalation (escalate_verifications cron), which is an admin
// concern written per-driver only to trace history. Clients can't render it, so
// it would show as a generic "Уведомление" and flood the feed every 4h.
const HIDDEN_FROM_USER_FEED = ['verification_sla_breach'];

export function createNotificationsService(prisma: PrismaClient) {
  async function list(
    userId: string,
    q: { cursor?: string; limit: number; unread?: boolean },
  ): Promise<{ data: Notification[]; nextCursor: string | null; unreadCount: number }> {
    const rows = await prisma.notification.findMany({
      where: {
        userId,
        type: { notIn: HIDDEN_FROM_USER_FEED },
        ...(q.unread === true ? { readAt: null } : {}),
        ...(q.unread === false ? { readAt: { not: null } } : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      ...cursorArgs({ cursor: q.cursor, limit: q.limit }),
    });
    const unreadCount = await prisma.notification.count({
      where: { userId, readAt: null, type: { notIn: HIDDEN_FROM_USER_FEED } },
    });
    return { ...sliceAndNext(rows, q.limit), unreadCount };
  }

  // Bulk: one UPDATE marks everything unread, including rows on pages the
  // client never loaded (the old client-side fan-out missed those).
  async function markAllRead(userId: string): Promise<{ updated: number }> {
    const r = await prisma.notification.updateMany({
      where: { userId, readAt: null },
      data: { readAt: new Date() },
    });
    return { updated: r.count };
  }

  async function markRead(id: string, userId: string): Promise<Notification> {
    const n = await prisma.notification.findUnique({ where: { id } });
    if (!n || n.userId !== userId) throw Errors.notFound('Notification');
    if (n.readAt) return n;
    return prisma.notification.update({ where: { id: n.id }, data: { readAt: new Date() } });
  }

  return { list, markAllRead, markRead };
}
