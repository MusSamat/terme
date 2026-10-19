import type { Server as HttpServer } from 'node:http';
import { Server as IoServer, type Socket } from 'socket.io';
import { z } from 'zod';
import type { PrismaClient } from '@prisma/client';
import { verifyAccessToken, verifyAdminAccessToken } from '@/lib/jwt.js';
import { isAllowedOrigin } from '@/lib/cors.js';
import { logger } from '@/lib/logger.js';
import { createChatService } from '@/modules/chat/chat.service.js';
import { createBookingsService } from '@/modules/bookings/bookings.service.js';
import type { Notifier } from '@/lib/notifier.js';
import { SendMessageBody } from '@/modules/chat/chat.schemas.js';
import { env } from '@/config/env.js';

// Socket payloads are untrusted input — same Zod rules as the REST twins.
const BookingRef = z.object({ booking_id: z.string().uuid() });
const ChatSendPayload = BookingRef.extend({
  text: SendMessageBody.shape.text,
  client_msg_id: SendMessageBody.shape.clientMsgId,
});
const MessageRef = z.object({ message_id: z.string().uuid() });

/**
 * Socket.IO server — mounted on the same HTTP server as REST in the MVP
 * (TZ §2.2: "На MVP оба процесса на одном сервере"). Split into its own
 * process in Stage 2.
 *
 * Protocol (TZ §13.2 + §20):
 *   Auth:            JWT in handshake.auth.token
 *   Rooms:           `user:<uuid>` per connection, `chat:<booking_id>` on chat:join
 *   Client → Server: chat:join, chat:send, chat:read, chat:typing, booking:view
 *   Server → Client: chat:joined, chat:message, chat:message_sent, chat:read,
 *                    chat:typing, chat:error, booking:*, trip:cancelled,
 *                    notification:new
 *
 * Rate limits are enforced in-memory per socket (not cross-process — fine for
 * MVP since Socket.IO is single-instance per TZ §20.3).
 */

const CHAT_SEND_LIMIT_PER_MIN = 20;
const TYPING_LIMIT_PER_10S = 10;
const CHAT_JOIN_LIMIT_PER_MIN = 30;

/** Per-socket sliding-window limiter — returns true while under `limit`. */
function windowLimiter(limit: number, windowMs: number): () => boolean {
  const times: number[] = [];
  return () => {
    const now = Date.now();
    while (times.length && now - times[0]! > windowMs) times.shift();
    if (times.length >= limit) return false;
    times.push(now);
    return true;
  };
}

function logSocketLimit(userId: string, limiter: string): void {
  logger.warn({ event: 'abuse.limit_hit', userId, limiter }, 'abuse.limit_hit');
}

// Live user connections per user id (single process) — caps socket floods.
const connectionsPerUser = new Map<string, number>();

// A socket is either a user connection (userId set, joins user/chat rooms) or an
// admin connection (adminId set, joins only the admin:<id> room, no chat access).
interface AuthedSocket extends Socket {
  data: {
    userId?: string;
    phone?: string;
    roles?: string[];
    adminId?: string;
    /** Access-token expiry (unix seconds) — the socket is dropped then (M1). */
    exp?: number;
  };
}

/**
 * Step 1 — create the Socket.IO server but don't attach any handlers yet.
 * Callers need the io reference to build a notifier before step 2.
 */
export function createIoServer(httpServer: HttpServer): IoServer {
  return new IoServer(httpServer, {
    // Same allowlist as REST — no more reflect-any origin.
    cors: {
      origin: (origin, cb) => cb(null, isAllowedOrigin(origin)),
      credentials: true,
    },
    transports: ['websocket'],
    pingInterval: 25_000,
    pingTimeout: 20_000,
  });
}

/**
 * Step 2 — wire handshake auth, chat namespace, and per-socket user rooms.
 * Call this once the notifier is constructed.
 */
export function attachChatNamespace(io: IoServer, prisma: PrismaClient, notifier: Notifier): void {
  const chat = createChatService(prisma, notifier);
  const bookings = createBookingsService(prisma, notifier);

  // ─── Handshake auth ───────────────────────────────────────────────
  // Mirrors REST requireAuth: verify the JWT signature AND confirm the user is
  // still active (not blocked, not soft-deleted). A valid-but-stale token from
  // a since-blocked user must not open a socket.
  io.use((socket, next) => {
    void (async () => {
      try {
        const token = extractToken(socket);
        if (!token) return next(new Error('auth_required'));
        // Try a user access token first; if that fails, try an admin access
        // token. Admin sockets exist only to receive admin:<id> notifications
        // (new_complaint etc.) — they never join user/chat rooms.
        let decoded: ReturnType<typeof verifyAccessToken> | null = null;
        try {
          decoded = verifyAccessToken(token);
        } catch {
          decoded = null;
        }
        if (decoded) {
          const user = await prisma.user.findUnique({
            where: { id: decoded.sub },
            select: { isBlocked: true, deletedAt: true },
          });
          if (!user || user.deletedAt) return next(new Error('auth_failed'));
          if (user.isBlocked) return next(new Error('forbidden'));
          if ((connectionsPerUser.get(decoded.sub) ?? 0) >= env.WS_MAX_CONNECTIONS_PER_USER) {
            logSocketLimit(decoded.sub, 'ws_connections');
            return next(new Error('too_many_connections'));
          }
          (socket as AuthedSocket).data = {
            userId: decoded.sub,
            phone: decoded.phone,
            roles: decoded.roles,
            exp: decoded.exp,
          };
          return next();
        }
        // Not a user token — try admin. verifyAdminAccessToken throws on any
        // non-admin token, so a garbage token still lands in the catch below.
        const admin = verifyAdminAccessToken(token);
        const adminRow = await prisma.admin.findUnique({
          where: { id: admin.sub },
          select: { isActive: true },
        });
        if (!adminRow || !adminRow.isActive) return next(new Error('auth_failed'));
        (socket as AuthedSocket).data = { adminId: admin.sub, exp: admin.exp };
        return next();
      } catch (err) {
        logger.debug({ err }, 'socket handshake rejected');
        next(err instanceof Error ? err : new Error('auth_failed'));
      }
    })();
  });

  io.on('connection', (rawSocket: Socket) => {
    const socket = rawSocket as AuthedSocket;
    scheduleExpiry(socket);

    // Admin connection: join only the admin room and register no chat/booking
    // handlers. This is what makes notifier.ts admin:<id> emits deliverable.
    if (socket.data.adminId) {
      const adminId = socket.data.adminId;
      socket.join(`admin:${adminId}`);
      logger.debug({ adminId, socketId: socket.id }, 'admin socket connected');
      socket.on('disconnect', (reason) => {
        logger.debug({ adminId, socketId: socket.id, reason }, 'admin socket disconnected');
      });
      return;
    }

    const userId = socket.data.userId!;
    socket.join(`user:${userId}`);
    connectionsPerUser.set(userId, (connectionsPerUser.get(userId) ?? 0) + 1);

    logger.debug({ userId, socketId: socket.id }, 'socket connected');

    const canSend = windowLimiter(CHAT_SEND_LIMIT_PER_MIN, 60_000);
    const canJoin = windowLimiter(CHAT_JOIN_LIMIT_PER_MIN, 60_000);

    // ─── chat:join ───────────────────────────────────────────────────
    socket.on('chat:join', async (raw: unknown) => {
      if (!canJoin()) {
        logSocketLimit(userId, 'ws_chat_join');
        socket.emit('chat:error', { code: 'RATE_LIMITED' });
        return;
      }
      const parsed = BookingRef.safeParse(raw);
      if (!parsed.success) {
        socket.emit('chat:error', { code: 'VALIDATION_ERROR' });
        return;
      }
      const { booking_id } = parsed.data;
      try {
        const parts = await chat.participants(booking_id);
        if (!parts) {
          socket.emit('chat:error', { code: 'NOT_FOUND' });
          return;
        }
        if (parts.driverId !== userId && parts.passengerId !== userId) {
          socket.emit('chat:error', { code: 'FORBIDDEN' });
          return;
        }
        if (parts.status === 'rejected') {
          socket.emit('chat:error', { code: 'CHAT_NOT_AVAILABLE' });
          return;
        }
        await socket.join(`chat:${booking_id}`);
        const history = await chat.history(booking_id, userId, { limit: 50 });
        socket.emit('chat:joined', { booking_id, history: history.data });
      } catch (err) {
        logger.error({ err, userId }, 'chat:join failed');
        socket.emit('chat:error', { code: 'INTERNAL_ERROR' });
      }
    });

    // ─── chat:send ───────────────────────────────────────────────────
    socket.on(
      'chat:send',
      async (raw: unknown) => {
        if (!canSend()) {
          logSocketLimit(userId, 'ws_chat_send');
          socket.emit('chat:error', { code: 'RATE_LIMITED' });
          return;
        }
        const parsed = ChatSendPayload.safeParse(raw);
        if (!parsed.success) {
          socket.emit('chat:error', { code: 'VALIDATION_ERROR' });
          return;
        }
        const payload = parsed.data;
        try {
          const { message } = await chat.send(
            payload.booking_id,
            userId,
            payload.text,
            payload.client_msg_id,
          );
          // ACK to sender with server id for idempotency matching.
          socket.emit('chat:message_sent', {
            client_msg_id: payload.client_msg_id,
            server_id: message.id,
          });
          // Fan out to the room. Include client_msg_id so the sender's
          // onMessage handler can detect this is their own optimistic message
          // and skip adding a duplicate (race between ACK and broadcast).
          io.to(`chat:${payload.booking_id}`).emit('chat:message', {
            message,
            client_msg_id: payload.client_msg_id ?? null,
          });
        } catch (err) {
          logger.warn({ err, userId }, 'chat:send failed');
          socket.emit('chat:error', {
            code:
              err instanceof Error && 'code' in err
                ? (err as { code: string }).code
                : 'SEND_FAILED',
          });
        }
      },
    );

    socket.on('chat:read', async (raw: unknown) => {
      const parsed = MessageRef.safeParse(raw);
      if (!parsed.success) return;
      try {
        await chat.markRead(parsed.data.message_id, userId);
      } catch (err) {
        logger.debug({ err }, 'chat:read ignored');
      }
    });

    socket.on('chat:leave', (raw: unknown) => {
      const parsed = BookingRef.safeParse(raw);
      if (parsed.success) void socket.leave(`chat:${parsed.data.booking_id}`);
    });

    // typing has its own sliding-window limiter — clients fire it on every
    // keystroke, so cap the relay rate to avoid flooding the room.
    const canType = windowLimiter(TYPING_LIMIT_PER_10S, 10_000);
    socket.on('chat:typing', (raw: unknown) => {
      const parsed = BookingRef.safeParse(raw);
      if (!parsed.success) return;
      const { booking_id } = parsed.data;
      // Only relay for rooms this socket actually joined (chat:join already
      // verified membership + status) — otherwise a client could spoof typing
      // into arbitrary chats it isn't part of.
      if (!socket.rooms.has(`chat:${booking_id}`)) return;
      if (!canType()) return;
      // Broadcast to the room, except the sender.
      socket.to(`chat:${booking_id}`).emit('chat:typing', { user_id: userId });
    });

    // ─── booking:view ──────────────────────────────────────────────────
    // TZ §13.3/§13.4 "Новое: водитель открыл карточку запроса". Stamp
    // viewed_at and emit booking:viewed to the passenger (markViewed checks
    // that the caller is the trip's driver). Mirrors REST GET /bookings/:id.
    socket.on('booking:view', async (raw: unknown) => {
      const parsed = BookingRef.safeParse(raw);
      if (!parsed.success) return;
      try {
        await bookings.markViewed(parsed.data.booking_id, userId);
      } catch (err) {
        logger.debug({ err, userId }, 'booking:view ignored');
      }
    });

    socket.on('disconnect', (reason) => {
      const left = (connectionsPerUser.get(userId) ?? 1) - 1;
      if (left > 0) connectionsPerUser.set(userId, left);
      else connectionsPerUser.delete(userId);
      logger.debug({ userId, socketId: socket.id, reason }, 'socket disconnected');
    });
  });
}

// M1: a socket authenticated with a 15-minute access token must not live on
// for hours. At expiry the client gets `auth:expired`, then the socket is
// dropped; the client refreshes its token and reconnects.
function scheduleExpiry(socket: AuthedSocket): void {
  if (!env.WS_DISCONNECT_ON_TOKEN_EXPIRY || !socket.data.exp) return;
  const expire = (): void => {
    socket.emit('auth:expired', { reason: 'token_expired' });
    socket.disconnect(true);
  };
  const ms = socket.data.exp * 1000 - Date.now();
  if (ms <= 0) return expire();
  const timer = setTimeout(expire, ms);
  timer.unref();
  socket.on('disconnect', () => clearTimeout(timer));
}

function extractToken(socket: Socket): string | null {
  const authToken = (socket.handshake.auth as { token?: unknown } | undefined)?.token;
  if (typeof authToken === 'string' && authToken) return authToken;
  const authHeader = socket.handshake.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) return authHeader.slice(7);
  return null;
}
