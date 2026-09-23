import http, { type Server } from 'node:http';
import { createApp } from '@/server.js';
import { env } from '@/config/env.js';
import { logger } from '@/lib/logger.js';
import { disconnectPrisma, getPrisma } from '@/db/prisma.js';
import { buildScheduler, type CronScheduler } from '@/cron/index.js';
import { attachChatNamespace, createIoServer } from '@/ws/socketServer.js';
import { createInProcessNotifier, type Notifier } from '@/lib/notifier.js';
import {
  composeNotifiers,
  createTelegramNotifier,
  startTelegramBot,
} from '@/lib/telegramBot.js';

/**
 * Entry point — boots HTTP + cron, wires graceful shutdown.
 * TZ §27 "Graceful shutdown · Корректное завершение при SIGTERM (15 сек)".
 */

const SHUTDOWN_TIMEOUT_MS = 15_000;

async function main(): Promise<void> {
  const prisma = getPrisma();
  await prisma.$connect();
  logger.info('Connected to database');

  // One HTTP server serves both REST and Socket.IO on the same port (TZ §2.2
  // "На MVP оба процесса на одном сервере"). Construction order:
  //   1. HTTP server → 2. io (needs server) → 3. notifier (needs io) →
  //   4. chat namespace (needs notifier) → 5. Express app (needs notifier).
  const server: Server = http.createServer();
  const io = createIoServer(server);
  // Bot ↔ notifier is circular: the bot's Accept/Reject callbacks need the
  // notifier, which itself wraps the bot. Break it with a late-bound ref the
  // callbacks read at fire time (set synchronously below, before listen).
  let notifierRef: Notifier | null = null;
  const bot = await startTelegramBot(prisma, () => notifierRef);
  const notifier = composeNotifiers(
    createInProcessNotifier(prisma, io),
    createTelegramNotifier({ prisma, bot }),
  );
  notifierRef = notifier;
  attachChatNamespace(io, prisma, notifier);
  const app = createApp(prisma, notifier, bot);
  server.on('request', app);

  // Notifier wired in so auto_complete_trips can deliver «оцените поездку»
  // live (socket + telegram), not just as a silent notifications row.
  const scheduler: CronScheduler = buildScheduler(prisma, notifier);

  // Listen errors (notably EADDRINUSE when tsx watch leaves a zombie holding
  // the port) otherwise bubble up as `uncaughtException`, which then tries to
  // close a server that never listened — noisy and misleading. Handle here.
  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      logger.fatal(
        { port: env.PORT },
        'Port already in use — another dev server is running. Stop it (pkill -f "tsx watch") and retry.',
      );
    } else {
      logger.fatal({ err }, 'HTTP server error during listen');
    }
    process.exit(1);
  });

  server.listen(env.PORT, () => {
    logger.info({ port: env.PORT, env: env.NODE_ENV }, 'HTTP + WS server listening');
    scheduler.start();
  });

  // ─── Graceful shutdown ──────────────────────────────────────────────
  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutdown initiated');

    const timer = setTimeout(() => {
      logger.error('shutdown timeout exceeded, forcing exit');
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    timer.unref();

    try {
      if (bot) await bot.stop();
      // Wait for any in-flight cron job to finish before we disconnect Prisma,
      // otherwise a running job hits a dead client. scheduler.stop() is bounded.
      await scheduler.stop();
      // Close Socket.IO first: `server.close()` only stops accepting new
      // connections — live WebSockets keep the server (and event loop) open
      // until the 15s force-exit. io.close() disconnects every socket and stops
      // the engine, letting server.close() actually resolve.
      await new Promise<void>((resolve) => io.close(() => resolve()));
      // `server.close()` throws ERR_SERVER_NOT_RUNNING if bootstrap failed
      // before .listen() resolved (e.g. EADDRINUSE). Only close when listening.
      // io.close() already closes the underlying server it was attached to, so
      // guard against a double-close (which would reject with that same error).
      if (server.listening) {
        await new Promise<void>((resolve, reject) =>
          server.close((err) =>
            err && (err as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING'
              ? reject(err)
              : resolve(),
          ),
        );
      }
      await disconnectPrisma();
      clearTimeout(timer);
      logger.info('shutdown complete');
      process.exit(0);
    } catch (err) {
      logger.error({ err }, 'shutdown error');
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  process.on('unhandledRejection', (reason) => {
    logger.error({ reason }, 'unhandledRejection');
  });
  process.on('uncaughtException', (err) => {
    logger.fatal({ err }, 'uncaughtException');
    void shutdown('uncaughtException');
  });
}

main().catch((err) => {
  logger.fatal({ err }, 'bootstrap failed');
  process.exit(1);
});
