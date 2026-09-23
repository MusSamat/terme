import type { PrismaClient } from '@prisma/client';
import type { Server as IoServer } from 'socket.io';
import { logger } from '@/lib/logger.js';

/**
 * Domain-event notifier — the booking/chat services call these after DB writes,
 * and the concrete implementation decides how events reach the client:
 *
 *   • InProcessNotifier: persists a `notifications` row (TZ §15 "in-app")
 *     and emits a Socket.IO event into the recipient's user room.
 *   • NoopNotifier: silently discards — useful in unit tests that don't care.
 *
 * This keeps business logic free of transport details and makes it trivial to
 * add SMS / Telegram / FCM channels later (TZ §15.1 Stage 2).
 */

export interface Notifier {
  bookingNewRequest(
    driverUserId: string,
    payload: { booking: PublicBooking; trip: PublicTrip; passengerName: string; passengerRating: number | null },
  ): Promise<void>;
  bookingAccepted(passengerUserId: string, payload: { booking: PublicBooking }): Promise<void>;
  /** Driver's own confirmation after they accept — appears in their bell. */
  bookingRequestConfirmed(driverUserId: string, payload: { booking: PublicBooking; passengerName: string }): Promise<void>;
  bookingRejected(passengerUserId: string, payload: { booking: PublicBooking }): Promise<void>;
  bookingExpired(passengerUserId: string, payload: { booking: PublicBooking }): Promise<void>;
  bookingCancelled(
    toUserId: string,
    payload: { booking: PublicBooking; cancelledBy: 'driver' | 'passenger' },
  ): Promise<void>;
  /** Driver opened the booking request — passenger gets a read-receipt (§11). */
  bookingViewed(passengerUserId: string, payload: { bookingId: string; viewedAt: Date }): Promise<void>;
  tripCancelled(passengerUserId: string, payload: { trip: PublicTrip }): Promise<void>;
  tripCompletedRate(userId: string, payload: { trip_id: string; origin_city: string; destination_city: string }): Promise<void>;
  newMessage(recipientUserId: string, payload: { message: PublicMessage }): Promise<void>;
  messageRead(senderUserId: string, payload: { messageId: string; readAt: Date }): Promise<void>;
  /** WS: chat room gets limit_warning at 8 pre-booking messages (§13). */
  chatLimitWarning(bookingId: string, remaining: number): Promise<void>;
  /** WS: chat room learns booking was accepted → phase transitions to full (§13). */
  chatPhaseChanged(bookingId: string, payload: { phase: 'full'; bookingId: string }): Promise<void>;
  /** loyalty tier upgraded (§Этап 3). */
  loyaltyTierChanged(userId: string, payload: { tier: string; points: number }): Promise<void>;

  // §15.2 catalog
  ratingReceived(
    rateeUserId: string,
    payload: { raterName: string; score: number; tripId: string },
  ): Promise<void>;
  ratingWarning(userId: string, payload: { rating: number }): Promise<void>;
  verificationApproved(userId: string, payload: Record<string, unknown>): Promise<void>;
  verificationRejected(userId: string, payload: { reason: string }): Promise<void>;
  verificationNeedDocs(userId: string, payload: { docs: string[]; note?: string }): Promise<void>;
  accountBlocked(userId: string, payload: { reason: string }): Promise<void>;

  // TZ v2.1 §7.5 — Token Reuse Detection — all sessions killed + security alert.
  securityAlertReuse(
    userId: string,
    payload: { reusedAt: Date; ip?: string | null },
  ): Promise<void>;

  /** Driver submitted an offer for a passenger request. */
  requestResponseReceived(
    passengerId: string,
    payload: { responseId: string; requestId: string; driverName: string; price: number; departureTime: Date },
  ): Promise<void>;
  /** Passenger accepted a driver's offer — driver gets notified with bookingId for chat. */
  requestResponseAccepted(
    driverId: string,
    payload: { responseId: string; requestId: string; bookingId: string; passengerName: string },
  ): Promise<void>;
  /** Passenger declined a driver's offer. */
  requestResponseDeclined(
    driverId: string,
    payload: { responseId: string; requestId: string },
  ): Promise<void>;

  /**
   * Admin-facing: fan-out to every active admin (and superadmin). Payload can
   * carry category, resource ids, etc. Returns the set of admin IDs notified.
   */
  broadcastToAdmins(type: string, payload: Record<string, unknown>): Promise<void>;
}

export interface PublicBooking {
  id: string;
  tripId: string;
  passengerId: string;
  seatsCount: number;
  status: string;
  createdAt: Date;
  expiresAt: Date | null;
  comment: string | null;
}

export interface PublicTrip {
  id: string;
  driverId: string;
  originCity: string;
  destinationCity: string;
  departureAt: Date;
}

export interface PublicMessage {
  id: string;
  bookingId: string;
  senderId: string;
  text: string;
  createdAt: Date;
}

export function createInProcessNotifier(prisma: PrismaClient, io: IoServer): Notifier {
  async function persist(userId: string, type: string, payload: unknown): Promise<void> {
    try {
      await prisma.notification.create({
        data: {
          userId,
          type,
          channel: 'telegram',
          payload: payload as object,
        },
      });
    } catch (err) {
      logger.error({ err, userId, type }, 'notifier: persist failed');
    }
  }

  function emitTo(userId: string, event: string, payload: unknown): void {
    io.to(`user:${userId}`).emit(event, payload);
  }

  return {
    async bookingNewRequest(driverUserId, payload) {
      await persist(driverUserId, 'new_booking_request', {
        bookingId: payload.booking.id,
        tripId: payload.trip.id,
        originCity: payload.trip.originCity,
        destinationCity: payload.trip.destinationCity,
        departureAt: payload.trip.departureAt,
        seatsCount: payload.booking.seatsCount,
        passengerName: payload.passengerName,
        passengerRating: payload.passengerRating,
        comment: payload.booking.comment,
        expiresAt: payload.booking.expiresAt,
      });
      emitTo(driverUserId, 'booking:new_request', payload);
    },
    async bookingAccepted(passengerUserId, payload) {
      await persist(passengerUserId, 'booking_accepted', payload);
      emitTo(passengerUserId, 'booking:accepted', payload);
    },
    async bookingRequestConfirmed(driverUserId, payload) {
      await persist(driverUserId, 'booking_request_confirmed', {
        bookingId: payload.booking.id,
        tripId: payload.booking.tripId,
        passengerName: payload.passengerName,
      });
      emitTo(driverUserId, 'booking:request_confirmed', payload);
    },
    async bookingRejected(passengerUserId, payload) {
      await persist(passengerUserId, 'booking_rejected', payload);
      emitTo(passengerUserId, 'booking:rejected', payload);
    },
    async bookingExpired(passengerUserId, payload) {
      await persist(passengerUserId, 'booking_expired', payload);
      emitTo(passengerUserId, 'booking:expired', payload);
    },
    async bookingCancelled(toUserId, payload) {
      const type =
        payload.cancelledBy === 'passenger'
          ? 'booking_cancelled_by_passenger'
          : 'booking_cancelled_by_driver';
      await persist(toUserId, type, payload);
      emitTo(toUserId, 'booking:cancelled', payload);
    },
    async bookingViewed(passengerUserId, payload) {
      emitTo(passengerUserId, 'booking:viewed', payload);
    },
    async tripCancelled(passengerUserId, payload) {
      await persist(passengerUserId, 'trip_cancelled', payload);
      emitTo(passengerUserId, 'trip:cancelled', payload);
    },
    async tripCompletedRate(userId, payload) {
      await persist(userId, 'trip_completed_rate', payload);
      emitTo(userId, 'trip:completed_rate', payload);
    },
    async newMessage(recipientUserId, payload) {
      emitTo(recipientUserId, 'chat:message', payload);
    },
    async messageRead(senderUserId, payload) {
      emitTo(senderUserId, 'chat:read', { message_id: payload.messageId, read_at: payload.readAt });
    },
    async ratingReceived(rateeUserId, payload) {
      await persist(rateeUserId, 'rating_received', payload);
      emitTo(rateeUserId, 'notification:new', { type: 'rating_received', payload });
    },
    async ratingWarning(userId, payload) {
      await persist(userId, 'rating_warning', payload);
      emitTo(userId, 'notification:new', { type: 'rating_warning', payload });
    },
    async verificationApproved(userId, payload) {
      await persist(userId, 'verification_approved', payload);
      emitTo(userId, 'notification:new', { type: 'verification_approved', payload });
    },
    async verificationRejected(userId, payload) {
      await persist(userId, 'verification_rejected', payload);
      emitTo(userId, 'notification:new', { type: 'verification_rejected', payload });
    },
    async verificationNeedDocs(userId, payload) {
      await persist(userId, 'verification_need_docs', payload);
      emitTo(userId, 'notification:new', { type: 'verification_need_docs', payload });
    },
    async accountBlocked(userId, payload) {
      await persist(userId, 'account_blocked', payload);
      emitTo(userId, 'notification:new', { type: 'account_blocked', payload });
    },
    async securityAlertReuse(userId, payload) {
      await persist(userId, 'security_alert_reuse', payload);
      emitTo(userId, 'notification:new', { type: 'security_alert_reuse', payload });
    },
    async chatLimitWarning(bookingId, remaining) {
      io.to(`chat:${bookingId}`).emit('chat:limit_warning', { remaining });
    },
    async chatPhaseChanged(bookingId, payload) {
      io.to(`chat:${bookingId}`).emit('chat:phase_changed', payload);
    },
    async loyaltyTierChanged(userId, payload) {
      await persist(userId, 'loyalty_tier_changed', payload);
      emitTo(userId, 'notification:new', { type: 'loyalty_tier_changed', payload });
    },
    async requestResponseReceived(passengerId, payload) {
      await persist(passengerId, 'request_response_received', payload);
      emitTo(passengerId, 'request:response_received', payload);
    },
    async requestResponseAccepted(driverId, payload) {
      await persist(driverId, 'request_response_accepted', payload);
      emitTo(driverId, 'request:response_accepted', payload);
    },
    async requestResponseDeclined(driverId, payload) {
      await persist(driverId, 'request_response_declined', payload);
      emitTo(driverId, 'request:response_declined', payload);
    },
    async broadcastToAdmins(type, payload) {
      const admins = await prisma.admin.findMany({
        where: { isActive: true },
        select: { id: true },
      });
      // Admin IDs don't live in `users`, so we can't persist per-admin rows in
      // `notifications` (whose FK is users). No admin socket ever joins the
      // `admin:<id>` rooms either — the handshake only accepts user tokens — so
      // a pure socket emit would silently vanish. Until an admin channel exists
      // (durable admin_notifications table / email — Stage 2), log every
      // admin-targeted event at WARN so it's captured in structured logs and
      // never lost, then keep the socket emit as best-effort for when/if an
      // admin room does get wired up.
      logger.warn(
        { type, payload, adminCount: admins.length },
        'admin notification (no durable admin channel yet — emitted to admin rooms best-effort)',
      );
      for (const a of admins) io.to(`admin:${a.id}`).emit('notification:new', { type, payload });
    },
  };
}

/**
 * Default test implementation — records everything in-memory for assertions.
 */
export class NoopNotifier implements Notifier {
  readonly events: Array<{ userId: string; event: string; payload: unknown }> = [];

  private push(userId: string, event: string, payload: unknown): void {
    this.events.push({ userId, event, payload });
  }

  async bookingNewRequest(d: string, p: { booking: PublicBooking; trip: PublicTrip; passengerName: string; passengerRating: number | null }) {
    this.push(d, 'booking:new_request', p);
  }
  async bookingAccepted(u: string, p: { booking: PublicBooking }) {
    this.push(u, 'booking:accepted', p);
  }
  async bookingRequestConfirmed(u: string, p: { booking: PublicBooking; passengerName: string }) {
    this.push(u, 'booking:request_confirmed', p);
  }
  async bookingRejected(u: string, p: { booking: PublicBooking }) {
    this.push(u, 'booking:rejected', p);
  }
  async bookingExpired(u: string, p: { booking: PublicBooking }) {
    this.push(u, 'booking:expired', p);
  }
  async bookingCancelled(
    u: string,
    p: { booking: PublicBooking; cancelledBy: 'driver' | 'passenger' },
  ) {
    this.push(u, 'booking:cancelled', p);
  }
  async bookingViewed(u: string, p: { bookingId: string; viewedAt: Date }) {
    this.push(u, 'booking:viewed', p);
  }
  async tripCancelled(u: string, p: { trip: PublicTrip }) {
    this.push(u, 'trip:cancelled', p);
  }
  async tripCompletedRate(u: string, p: { trip_id: string; origin_city: string; destination_city: string }) {
    this.push(u, 'trip:completed_rate', p);
  }
  async newMessage(u: string, p: { message: PublicMessage }) {
    this.push(u, 'chat:message', p);
  }
  async messageRead(u: string, p: { messageId: string; readAt: Date }) {
    this.push(u, 'chat:read', p);
  }
  async ratingReceived(u: string, p: { raterName: string; score: number; tripId: string }) {
    this.push(u, 'rating_received', p);
  }
  async ratingWarning(u: string, p: { rating: number }) {
    this.push(u, 'rating_warning', p);
  }
  async verificationApproved(u: string, p: Record<string, unknown>) {
    this.push(u, 'verification_approved', p);
  }
  async verificationRejected(u: string, p: { reason: string }) {
    this.push(u, 'verification_rejected', p);
  }
  async verificationNeedDocs(u: string, p: { docs: string[]; note?: string }) {
    this.push(u, 'verification_need_docs', p);
  }
  async accountBlocked(u: string, p: { reason: string }) {
    this.push(u, 'account_blocked', p);
  }
  async securityAlertReuse(u: string, p: { reusedAt: Date; ip?: string | null }) {
    this.push(u, 'security_alert_reuse', p);
  }
  async chatLimitWarning(bookingId: string, remaining: number) {
    this.push(bookingId, 'chat:limit_warning', { remaining });
  }
  async chatPhaseChanged(bookingId: string, payload: { phase: 'full'; bookingId: string }) {
    this.push(bookingId, 'chat:phase_changed', payload);
  }
  async loyaltyTierChanged(u: string, p: { tier: string; points: number }) {
    this.push(u, 'loyalty_tier_changed', p);
  }
  async requestResponseReceived(u: string, p: { responseId: string; requestId: string; driverName: string; price: number; departureTime: Date }) {
    this.push(u, 'request:response_received', p);
  }
  async requestResponseAccepted(u: string, p: { responseId: string; requestId: string; bookingId: string; passengerName: string }) {
    this.push(u, 'request:response_accepted', p);
  }
  async requestResponseDeclined(u: string, p: { responseId: string; requestId: string }) {
    this.push(u, 'request:response_declined', p);
  }
  async broadcastToAdmins(type: string, payload: Record<string, unknown>) {
    this.push('__admins__', type, payload);
  }

  findForUser(userId: string, event?: string): typeof this.events {
    return this.events.filter((e) => e.userId === userId && (!event || e.event === event));
  }

  clear(): void {
    this.events.length = 0;
  }
}
