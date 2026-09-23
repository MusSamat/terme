import type { PrismaClient } from '@prisma/client';
import { Errors } from '@/lib/errors.js';
import { logger } from '@/lib/logger.js';
import { toFileUrl } from '@/lib/uploads.js';
import { cursorArgs, sliceAndNext } from '@/lib/pagination.js';
import { filterPhoneNumbers } from '@/lib/phoneFilter.js';
import { filterSocialLinks } from '@/lib/socialFilter.js';
import type { Notifier } from '@/lib/notifier.js';

// ─── Chat access window ─────────────────────────────────────────────
const POST_COMPLETION_WRITE_WINDOW_HOURS = 48;

// ─── Pre-booking phase limits (TZ §13) ─────────────────────────────
const PRE_BOOKING_MSG_LIMIT = 10;
const PRE_BOOKING_WARN_AT = 8; // emit chat:limit_warning when this many sent

export interface ChatMessage {
  id: string;
  bookingId: string;
  senderId: string;
  text: string;
  chatPhase: string;
  isFiltered: boolean;
  isRead: boolean;
  readAt: Date | null;
  createdAt: Date;
}

export interface ChatService {
  history(
    bookingId: string,
    viewerId: string,
    input: { cursor?: string; limit: number },
  ): Promise<{ data: ChatMessage[]; nextCursor: string | null }>;
  send(
    bookingId: string,
    senderId: string,
    text: string,
    clientMsgId?: string,
  ): Promise<{ message: ChatMessage; clientMsgId?: string }>;
  markRead(messageId: string, viewerId: string): Promise<ChatMessage>;
  markAllRead(bookingId: string, userId: string): Promise<number>;
  participants(
    bookingId: string,
  ): Promise<{ driverId: string; passengerId: string; status: string } | null>;
  unreadCounts(userId: string): Promise<Record<string, number>>;
  summaries(userId: string): Promise<ChatSummary[]>;
}

export interface ChatSummary {
  bookingId: string;
  bookingStatus: string;
  role: 'passenger' | 'driver';
  otherName: string;
  otherAvatarUrl: string | null;
  route: string;
  lastMessageAt: string | null;
  unreadCount: number;
}

export function createChatService(prisma: PrismaClient, notifier: Notifier): ChatService {
  async function loadBooking(bookingId: string) {
    return prisma.booking.findUnique({
      where: { id: bookingId },
      include: {
        trip: { select: { id: true, driverId: true, status: true, updatedAt: true } },
      },
    });
  }

  function assertCanRead(
    bk: NonNullable<Awaited<ReturnType<typeof loadBooking>>>,
    viewerId: string,
  ): void {
    const isParticipant = bk.passengerId === viewerId || bk.trip.driverId === viewerId;
    if (!isParticipant) throw Errors.forbidden({ reason: 'not_participant' });

    if (bk.status === 'rejected') {
      throw Errors.forbidden({ reason: 'chat_not_available', booking_status: bk.status });
    }
  }

  function assertCanWrite(
    bk: NonNullable<Awaited<ReturnType<typeof loadBooking>>>,
    viewerId: string,
  ): void {
    assertCanRead(bk, viewerId);

    // Pre-booking inquiry (TZ §13.1 "Кто может писать: Пассажир → водителю").
    // Only the passenger may write before the driver accepts; the driver
    // responds by accepting/rejecting the request, not by chatting. This keeps
    // the anti-bypass intent intact (no contact exchange before commitment).
    if (bk.status === 'pending' || bk.status === 'viewed') {
      if (viewerId !== bk.passengerId) {
        throw Errors.forbidden({ reason: 'driver_cannot_write_pre_booking' });
      }
      return;
    }

    // 'direct' trips are created from passenger-request responses — they are
    // accepted bookings on synthetic trips that bypass the active-trip index.
    if (bk.status === 'accepted' && (bk.trip.status === 'active' || bk.trip.status === 'direct'))
      return;

    if (bk.status === 'completed') {
      const age = Date.now() - bk.trip.updatedAt.getTime();
      if (age < POST_COMPLETION_WRITE_WINDOW_HOURS * 60 * 60_000) return;
      throw Errors.forbidden({ reason: 'chat_write_window_expired' });
    }
    throw Errors.forbidden({ reason: 'chat_not_writable', booking_status: bk.status });
  }

  async function history(
    bookingId: string,
    viewerId: string,
    input: { cursor?: string; limit: number },
  ): Promise<{ data: ChatMessage[]; nextCursor: string | null }> {
    const bk = await loadBooking(bookingId);
    if (!bk) throw Errors.notFound('Booking');
    assertCanRead(bk, viewerId);

    const rows = await prisma.message.findMany({
      where: { bookingId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      ...cursorArgs({ cursor: input.cursor, limit: input.limit }),
    });
    return sliceAndNext(rows.map(toMessage), input.limit);
  }

  async function send(
    bookingId: string,
    senderId: string,
    text: string,
    clientMsgId?: string,
  ): Promise<{ message: ChatMessage; clientMsgId?: string }> {
    const bk = await loadBooking(bookingId);
    if (!bk) throw Errors.notFound('Booking');
    assertCanWrite(bk, senderId);

    const isPreBooking = bk.status === 'pending' || bk.status === 'viewed';
    const chatPhase = isPreBooking ? 'pre_booking' : 'full';

    // Enforce pre-booking message limit.
    if (isPreBooking) {
      const count = await prisma.message.count({
        where: { bookingId, chatPhase: 'pre_booking' },
      });
      if (count >= PRE_BOOKING_MSG_LIMIT) {
        throw Errors.forbidden({
          reason: 'pre_booking_limit_reached',
          limit: PRE_BOOKING_MSG_LIMIT,
        });
      }
    }

    // Filter phone numbers in all phases; also filter social links in pre-booking.
    let finalText = text;
    let wasFiltered = false;
    const originalText = text;

    const phoneResult = filterPhoneNumbers(finalText);
    if (phoneResult.redacted) {
      finalText = phoneResult.filtered;
      wasFiltered = true;
    }

    if (isPreBooking) {
      const socialResult = filterSocialLinks(finalText);
      if (socialResult.redacted) {
        finalText = socialResult.filtered;
        wasFiltered = true;
      }
    }

    const created = await prisma.message.create({
      data: {
        bookingId,
        senderId,
        text: finalText,
        chatPhase,
        isFiltered: wasFiltered,
        originalText: wasFiltered ? originalText : null,
      },
    });
    const msg = toMessage(created);

    const recipientId = senderId === bk.passengerId ? bk.trip.driverId : bk.passengerId;
    // Fire-and-forget: the composite notifier includes a Telegram send; awaiting
    // it would delay the socket ACK / room broadcast if Telegram is slow.
    void notifier.newMessage(recipientId, { message: msg }).catch((err) => {
      logger.warn({ err, bookingId }, 'chat: newMessage notify failed');
    });

    // Emit limit warning when pre-booking count hits the threshold.
    if (isPreBooking) {
      const newCount = await prisma.message.count({
        where: { bookingId, chatPhase: 'pre_booking' },
      });
      if (newCount >= PRE_BOOKING_WARN_AT) {
        const remaining = PRE_BOOKING_MSG_LIMIT - newCount;
        await notifier.chatLimitWarning(bookingId, Math.max(0, remaining));
      }
    }

    return { message: msg, ...(clientMsgId ? { clientMsgId } : {}) };
  }

  async function markRead(messageId: string, viewerId: string): Promise<ChatMessage> {
    const msg = await prisma.message.findUnique({
      where: { id: messageId },
      include: {
        booking: {
          include: { trip: { select: { driverId: true } } },
        },
      },
    });
    if (!msg) throw Errors.notFound('Message');
    const bk = msg.booking;
    const isParticipant = bk.passengerId === viewerId || bk.trip.driverId === viewerId;
    if (!isParticipant) throw Errors.forbidden({ reason: 'not_participant' });
    if (msg.senderId === viewerId) return toMessage(msg);
    if (msg.isRead) return toMessage(msg);

    const now = new Date();
    const updated = await prisma.message.update({
      where: { id: messageId },
      data: { isRead: true, readAt: now },
    });

    await notifier.messageRead(msg.senderId, { messageId, readAt: now });
    return toMessage(updated);
  }

  async function participants(bookingId: string) {
    const bk = await prisma.booking.findUnique({
      where: { id: bookingId },
      include: { trip: { select: { driverId: true } } },
    });
    if (!bk) return null;
    return {
      driverId: bk.trip.driverId,
      passengerId: bk.passengerId,
      status: bk.status,
    };
  }

  async function unreadCounts(userId: string): Promise<Record<string, number>> {
    const rows = await prisma.message.groupBy({
      by: ['bookingId'],
      where: {
        senderId: { not: userId },
        isRead: false,
        booking: {
          OR: [{ passengerId: userId }, { trip: { driverId: userId } }],
        },
      },
      _count: { id: true },
    });
    return Object.fromEntries(rows.map((r) => [r.bookingId, r._count.id]));
  }

  async function markAllRead(bookingId: string, userId: string): Promise<number> {
    // Verify the user is a participant before bulk-updating
    const bk = await prisma.booking.findUnique({
      where: { id: bookingId },
      include: { trip: { select: { driverId: true } } },
    });
    if (!bk) throw Errors.notFound('Booking');
    const isParticipant = bk.passengerId === userId || bk.trip.driverId === userId;
    if (!isParticipant) throw Errors.forbidden({ reason: 'not_participant' });

    const now = new Date();
    const { count } = await prisma.message.updateMany({
      where: { bookingId, senderId: { not: userId }, isRead: false },
      data: { isRead: true, readAt: now },
    });
    return count;
  }

  async function summaries(userId: string): Promise<ChatSummary[]> {
    // All accepted/completed bookings where the user is driver or passenger
    const bookings = await prisma.booking.findMany({
      where: {
        status: { in: ['accepted', 'completed'] },
        OR: [{ passengerId: userId }, { trip: { driverId: userId } }],
      },
      include: {
        trip: {
          select: {
            driverId: true,
            originCity: true,
            destinationCity: true,
            driver: { select: { name: true, avatarUrl: true } },
          },
        },
        passenger: { select: { name: true, avatarUrl: true } },
        messages: {
          orderBy: { createdAt: 'desc' },
          take: 1,
          select: { createdAt: true },
        },
      },
    });

    // Batch unread counts
    const unreadRows = await prisma.message.groupBy({
      by: ['bookingId'],
      where: {
        senderId: { not: userId },
        isRead: false,
        bookingId: { in: bookings.map((b) => b.id) },
      },
      _count: { id: true },
    });
    const unreadMap = Object.fromEntries(unreadRows.map((r) => [r.bookingId, r._count.id]));

    return (
      bookings
        .map((b) => {
          const isDriver = b.trip.driverId === userId;
          const lastMessageAt = b.messages[0]?.createdAt?.toISOString() ?? null;
          return {
            bookingId: b.id,
            bookingStatus: b.status,
            role: isDriver ? ('driver' as const) : ('passenger' as const),
            otherName: isDriver
              ? (b.passenger.name ?? 'Пассажир')
              : (b.trip.driver?.name ?? 'Водитель'),
            otherAvatarUrl: isDriver
              ? toFileUrl(b.passenger.avatarUrl)
              : toFileUrl(b.trip.driver?.avatarUrl),
            route: `${b.trip.originCity} → ${b.trip.destinationCity}`,
            lastMessageAt,
            unreadCount: unreadMap[b.id] ?? 0,
          };
        })
        // Most recently active chats first; bookings with no messages go to end
        .sort((a, b) => {
          if (!a.lastMessageAt && !b.lastMessageAt) return 0;
          if (!a.lastMessageAt) return 1;
          if (!b.lastMessageAt) return -1;
          return new Date(b.lastMessageAt).getTime() - new Date(a.lastMessageAt).getTime();
        })
    );
  }

  return { history, send, markRead, markAllRead, participants, unreadCounts, summaries };
}

function toMessage(m: {
  id: string;
  bookingId: string;
  senderId: string;
  text: string;
  chatPhase: string;
  isFiltered: boolean;
  isRead: boolean;
  readAt: Date | null;
  createdAt: Date;
}): ChatMessage {
  return {
    id: m.id,
    bookingId: m.bookingId,
    senderId: m.senderId,
    text: m.text,
    chatPhase: m.chatPhase,
    isFiltered: m.isFiltered,
    isRead: m.isRead,
    readAt: m.readAt,
    createdAt: m.createdAt,
  };
}
