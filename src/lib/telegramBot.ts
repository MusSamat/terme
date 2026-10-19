import type { PrismaClient } from '@prisma/client';
import { Bot, GrammyError, InlineKeyboard } from 'grammy';
import { env } from '@/config/env.js';
import { logger } from '@/lib/logger.js';
import { registerBotHandlers } from '@/bot/index.js';
import type {
  Notifier,
  PublicBooking,
} from '@/lib/notifier.js';

/**
 * Telegram Bot — TZ §25. Uses `grammy` (fetch-based; no deprecated `request`
 * transitive deps that plague `node-telegram-bot-api`). The TZ listed the
 * latter; we picked grammy because the former pulls in critical-severity CVEs
 * in its tar/request/form-data dependency chain.
 *
 * Modes:
 *   • No token → bot stays stopped; all notifier calls become no-ops.
 *   • Token set → long-poll in-process (MVP). Stage 2 switches to webhook +
 *     own worker process; the public surface stays the same.
 *
 * Language: every outgoing notification reads users.language (ru | kg) and
 * selects the matching template. The conversational client (menus, flows)
 * lives in src/bot.
 */

export type BotInstance = Bot;

export interface TelegramNotifierDeps {
  prisma: PrismaClient;
  bot: Bot | null;
}

interface MessageTemplate {
  ru: string;
  kg: string;
}

const T = {
  new_booking_request: {
    ru: '📬 <b>Новый запрос на поездку</b>\nОт: <b>{passengerName}</b>{ratingSuffix}\nПоездка: {from} → {to}\nДата: {date}\nМест: {seats}',
    kg: '📬 <b>Сапарга жаңы өтүнмө</b>\nКимден: <b>{passengerName}</b>{ratingSuffix}\nСапар: {from} → {to}\nДата: {date}\nОрундар: {seats}',
  },
  booking_accepted: {
    ru: '✅ <b>{driverName}</b> принял ваш запрос! Чат открыт.',
    kg: '✅ <b>{driverName}</b> өтүнмөңүздү кабыл алды! Чат ачылды.',
  },
  booking_rejected: {
    ru: '❌ Водитель отклонил ваш запрос.',
    kg: '❌ Айдоочу өтүнмөңүздү четке какты.',
  },
  booking_expired: {
    ru: '⏰ Водитель не ответил. Попробуйте другую поездку.',
    kg: '⏰ Айдоочу жооп бербеди. Башка сапарды сынап көрүңүз.',
  },
  booking_cancelled_by_passenger: {
    ru: '🚫 {name} отменил бронирование.',
    kg: '🚫 {name} брондоону жокко чыгарды.',
  },
  booking_cancelled_by_driver: {
    ru: '🚫 Водитель отменил ваше бронирование.',
    kg: '🚫 Айдоочу брондооңузду жокко чыгарды.',
  },
  trip_cancelled: {
    ru: '🚫 Поездка {from} → {to} на {date} отменена.',
    kg: '🚫 {from} → {to} сапары {date} күнү жокко чыгарылды.',
  },
  chat_message: {
    ru: '💬 <b>{senderName}</b>: {preview}',
    kg: '💬 <b>{senderName}</b>: {preview}',
  },
  rating_received: {
    ru: '⭐ <b>{raterName}</b> поставил(-а) вам оценку {score}.',
    kg: '⭐ <b>{raterName}</b> сизге {score} баа койду.',
  },
  rating_warning: {
    ru: '⚠ Ваш рейтинг снизился до <b>{rating}</b>. Улучшите его.',
    kg: '⚠ Рейтингиңиз <b>{rating}</b> чейин түштү. Жакшыртыңыз.',
  },
  verification_approved: {
    ru: '🎉 Поздравляем! Вы верифицированы как водитель.',
    kg: '🎉 Куттуктайбыз! Сиз айдоочу катары ырасталдыңыз.',
  },
  verification_rejected: {
    ru: '❌ Верификация отклонена. Причина: {reason}',
    kg: '❌ Ырастоо четке кагылды. Себеби: {reason}',
  },
  verification_need_docs: {
    ru: '📎 Нужны дополнительные документы: {docs}',
    kg: '📎 Кошумча документтер керек: {docs}',
  },
  account_blocked: {
    ru: '🚫 Ваш аккаунт заблокирован. Причина: {reason}',
    kg: '🚫 Аккаунтуңуз бөгөттөлдү. Себеби: {reason}',
  },
  loyalty_tier_changed: {
    ru: '🏆 Ваш уровень лояльности повышен до <b>{tier}</b>!',
    kg: '🏆 Лоялтуулук деңгээлиңиз <b>{tier}</b> болуп жогорулады!',
  },
} as const;

type Vars = Record<string, string | number>;

function render(tpl: MessageTemplate, lang: 'ru' | 'kg', vars: Vars): string {
  const raw = tpl[lang] ?? tpl.ru;
  return raw.replace(/\{(\w+)\}/g, (_, key: string) => String(vars[key] ?? ''));
}

function formatDepartureDate(d: Date, lang: 'ru' | 'kg'): string {
  try {
    return new Intl.DateTimeFormat(lang === 'kg' ? 'ky-KG' : 'ru-RU', {
      day: 'numeric',
      month: 'long',
      hour: '2-digit',
      minute: '2-digit',
      timeZone: 'Asia/Bishkek',
    }).format(d);
  } catch {
    return d.toISOString();
  }
}

// Web site base for link buttons. Telegram rejects non-HTTPS URL buttons on
// some clients, so on a plain-http dev host we omit them entirely (callback
// Accept/Reject buttons still work — they carry no URL).
const WEB_URL = (env.WEB_URL ?? env.BASE_URL).replace(/\/$/, '');
const WEB_HTTPS = WEB_URL.startsWith('https://');

function webUrl(path: string): string {
  return `${WEB_URL}${path}`;
}

const L = (lang: 'ru' | 'kg', ru: string, kg: string): string => (lang === 'kg' ? kg : ru);

export function createTelegramNotifier(deps: TelegramNotifierDeps): Notifier {
  const { prisma, bot } = deps;

  async function send(
    userId: string,
    tpl: MessageTemplate,
    // Callers pass a function when a var depends on the recipient's language
    // (e.g. formatDepartureDate) — the language is only known here.
    vars: Vars | ((lang: 'ru' | 'kg') => Vars),
    keyboard?: (lang: 'ru' | 'kg') => InlineKeyboard | undefined,
  ): Promise<void> {
    if (!bot) return;
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { telegramId: true, language: true, notificationsEnabled: true },
    });
    if (!user || !user.telegramId || !user.notificationsEnabled) return;
    const lang: 'ru' | 'kg' = user.language === 'kg' ? 'kg' : 'ru';
    const text = render(tpl, lang, typeof vars === 'function' ? vars(lang) : vars);
    const kb = keyboard?.(lang);
    const opts = {
      parse_mode: 'HTML' as const,
      ...(kb ? { reply_markup: kb } : {}),
    };
    const chatId = Number(user.telegramId);
    try {
      await bot.api.sendMessage(chatId, text, opts);
    } catch (err) {
      // 429 Too Many Requests → Telegram tells us how long to wait in
      // parameters.retry_after. Respect it once (bounded single retry) instead
      // of dropping the notification.
      if (err instanceof GrammyError && err.error_code === 429) {
        const retryAfter = Math.min(err.parameters.retry_after ?? 1, 60);
        logger.warn({ userId, retryAfter }, 'telegram 429 — retrying after backoff');
        await new Promise((r) => setTimeout(r, retryAfter * 1000));
        await bot.api
          .sendMessage(chatId, text, opts)
          .catch((e: unknown) => logger.warn({ err: e, userId }, 'telegram send failed after 429 retry'));
        return;
      }
      // 403 Forbidden → the user blocked the bot (or deleted their account).
      // Clear their delivery flag so we stop trying every notification.
      if (err instanceof GrammyError && err.error_code === 403) {
        logger.info({ userId }, 'telegram 403 — bot blocked by user, disabling delivery');
        await prisma.user
          .update({ where: { id: userId }, data: { notificationsEnabled: false } })
          .catch((e: unknown) => logger.warn({ err: e, userId }, 'failed to clear telegram delivery flag'));
        return;
      }
      logger.warn({ err, userId }, 'telegram send failed');
    }
  }

  return {
    async bookingNewRequest(driverUserId, { booking, trip, passengerName, passengerRating }) {
      const ratingSuffix = passengerRating !== null
        ? ` (★ ${passengerRating.toFixed(1)})`
        : '';
      await send(
        driverUserId,
        T.new_booking_request,
        (lang) => ({
          passengerName,
          ratingSuffix,
          from: trip.originCity,
          to: trip.destinationCity,
          date: formatDepartureDate(trip.departureAt, lang),
          seats: booking.seatsCount,
        }),
        (lang) => {
          const kb = new InlineKeyboard()
            .text(L(lang, '✅ Принять', '✅ Кабыл алуу'), `accept_booking_${booking.id}`)
            .text(L(lang, '❌ Отклонить', '❌ Четке кагуу'), `reject_booking_${booking.id}`);
          if (WEB_HTTPS) {
            kb.row().url(L(lang, '→ Открыть', '→ Ачуу'), webUrl('/my/bookings'));
          }
          return kb;
        },
      );
    },
    async bookingAccepted(passengerUserId, { booking }) {
      const driverName = await driverNameForBooking(prisma, booking);
      await send(passengerUserId, T.booking_accepted, { driverName }, (lang) =>
        WEB_HTTPS
          ? new InlineKeyboard().url(
              L(lang, '💬 Чат', '💬 Чат'),
              webUrl(`/my/bookings/${booking.id}/chat`),
            )
          : undefined,
      );
    },
    async bookingRequestConfirmed() {
      // Telegram delivery for driver confirmation is not needed — in-app bell only.
    },
    async bookingRejected(passengerUserId) {
      await send(passengerUserId, T.booking_rejected, {});
    },
    async bookingExpired(passengerUserId) {
      await send(passengerUserId, T.booking_expired, {});
    },
    async bookingCancelled(toUserId, payload) {
      if (payload.cancelledBy === 'passenger') {
        const passenger = await prisma.user.findUnique({
          where: { id: payload.booking.passengerId },
          select: { name: true },
        });
        await send(toUserId, T.booking_cancelled_by_passenger, {
          name: passenger?.name ?? '—',
        });
      } else {
        await send(toUserId, T.booking_cancelled_by_driver, {});
      }
    },
    async tripCancelled(passengerUserId, { trip }) {
      await send(passengerUserId, T.trip_cancelled, (lang) => ({
        from: trip.originCity,
        to: trip.destinationCity,
        date: formatDepartureDate(trip.departureAt, lang),
      }));
    },
    async newMessage(recipientUserId, { message }) {
      const sender = await prisma.user.findUnique({
        where: { id: message.senderId },
        select: { name: true },
      });
      const preview = message.text.length > 80 ? `${message.text.slice(0, 80)}…` : message.text;
      await send(
        recipientUserId,
        T.chat_message,
        { senderName: sender?.name ?? '—', preview },
        (lang) =>
          WEB_HTTPS
            ? new InlineKeyboard().url(
                L(lang, '→ Ответить', '→ Жооп берүү'),
                webUrl(`/my/bookings/${message.bookingId}/chat`),
              )
            : undefined,
      );
    },
    async messageRead() {
      // Too noisy for Telegram — kept in app only.
    },
    async ratingReceived(rateeUserId, payload) {
      await send(
        rateeUserId,
        T.rating_received,
        { raterName: payload.raterName, score: payload.score },
        (lang) =>
          WEB_HTTPS
            ? new InlineKeyboard().url(L(lang, '→ Посмотреть', '→ Көрүү'), webUrl('/profile'))
            : undefined,
      );
    },
    async ratingWarning(userId, payload) {
      await send(userId, T.rating_warning, { rating: payload.rating });
    },
    async verificationApproved(userId) {
      await send(userId, T.verification_approved, {});
    },
    async verificationRejected(userId, payload) {
      await send(userId, T.verification_rejected, { reason: payload.reason });
    },
    async verificationNeedDocs(userId, payload) {
      await send(userId, T.verification_need_docs, { docs: payload.docs.join(', ') });
    },
    async accountBlocked(userId, payload) {
      await send(userId, T.account_blocked, { reason: payload.reason });
    },
    async securityAlertReuse(userId) {
      // TZ v2.1 §7.5: deliver to the user's Telegram channel (their primary
      // trusted contact) with a fixed message — no template vars so it lands
      // fast even if we don't know the IP/timezone context.
      await send(
        userId,
        {
          ru: '🚨 Обнаружена подозрительная активность. Все ваши сессии завершены — войдите снова. Если это не вы — смените пароль и свяжитесь с поддержкой.',
          kg: '🚨 Шектүү аракет табылды. Бардык сессияларыңыз жабылды — кайра кириңиз. Эгер бул сиз эмес болсоңуз — паролду алмаштырып, колдоого кайрылыңыз.',
        },
        {},
      );
    },
    async broadcastToAdmins() {
      // Admin alerts flow via Admin Panel (Socket.IO) + email (Stage 2) —
      // not the user-facing Telegram bot.
    },
    async bookingViewed() {
      // Read-receipt — in-app only, no Telegram noise.
    },
    async chatLimitWarning() {
      // In-app warning only.
    },
    async chatPhaseChanged() {
      // Phase upgrade — in-app only.
    },
    async loyaltyTierChanged(userId, payload) {
      await send(userId, T.loyalty_tier_changed, { tier: payload.tier });
    },
    async requestResponseReceived(passengerId, payload) {
      await send(
        passengerId,
        {
          ru: '📨 Водитель <b>{name}</b> предлагает поездку за {price} сом.',
          kg: '📨 Айдоочу <b>{name}</b> {price} сомго сапар сунуштады.',
        },
        { name: payload.driverName, price: payload.price },
        (lang) =>
          new InlineKeyboard().text(L(lang, '📋 Посмотреть предложения', '📋 Сунуштарды көрүү'), `of:${payload.requestId}`),
      );
    },
    async requestResponseAccepted(driverId) {
      await send(driverId, { ru: 'Пассажир принял ваше предложение! Откройте чат.', kg: 'Жүргүнчү сиздин сунушту кабыл алды! Чатты ачыңыз.' }, {});
    },
    async requestResponseDeclined(driverId) {
      await send(driverId, { ru: 'Пассажир отклонил ваше предложение.', kg: 'Жүргүнчү сиздин сунушту четке какты.' }, {});
    },
    async tripCompletedRate() {
      // In-app rating prompt only — no Telegram noise.
    },
    async disconnectUser() {
      // Sockets only — nothing to do on Telegram.
    },
  };
}

async function driverNameForBooking(
  prisma: PrismaClient,
  booking: PublicBooking,
): Promise<string> {
  const trip = await prisma.trip.findUnique({
    where: { id: booking.tripId },
    include: { driver: { select: { name: true } } },
  });
  return trip?.driver.name ?? '—';
}

// ─── Composite notifier ─────────────────────────────────────────────
export function composeNotifiers(...notifiers: Notifier[]): Notifier {
  const call =
    <K extends keyof Notifier>(method: K) =>
    async (...args: Parameters<Notifier[K]>): Promise<void> => {
      await Promise.all(
        notifiers.map(async (n) => {
          try {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            await (n[method] as (...a: any[]) => Promise<void>)(...args);
          } catch (err) {
            logger.error({ err, method }, 'notifier channel failed');
          }
        }),
      );
    };

  return {
    bookingNewRequest: call('bookingNewRequest'),
    bookingAccepted: call('bookingAccepted'),
    bookingRequestConfirmed: call('bookingRequestConfirmed'),
    bookingRejected: call('bookingRejected'),
    bookingExpired: call('bookingExpired'),
    bookingCancelled: call('bookingCancelled'),
    tripCancelled: call('tripCancelled'),
    newMessage: call('newMessage'),
    messageRead: call('messageRead'),
    ratingReceived: call('ratingReceived'),
    ratingWarning: call('ratingWarning'),
    verificationApproved: call('verificationApproved'),
    verificationRejected: call('verificationRejected'),
    verificationNeedDocs: call('verificationNeedDocs'),
    accountBlocked: call('accountBlocked'),
    securityAlertReuse: call('securityAlertReuse'),
    broadcastToAdmins: call('broadcastToAdmins'),
    bookingViewed: call('bookingViewed'),
    chatLimitWarning: call('chatLimitWarning'),
    chatPhaseChanged: call('chatPhaseChanged'),
    loyaltyTierChanged: call('loyaltyTierChanged'),
    requestResponseReceived: call('requestResponseReceived'),
    requestResponseAccepted: call('requestResponseAccepted'),
    requestResponseDeclined: call('requestResponseDeclined'),
    tripCompletedRate: call('tripCompletedRate'),
    disconnectUser: call('disconnectUser'),
  };
}

// ─── Bot bootstrap + command handlers ─────────────────────────────
export async function startTelegramBot(
  prisma: PrismaClient,
  // Lazy getter — the notifier wraps this bot, so it doesn't exist yet at boot.
  // index.ts sets it right after construction; callbacks read it at fire time.
  getNotifier: () => Notifier | null = () => null,
): Promise<Bot | null> {
  if (!env.TELEGRAM_BOT_TOKEN) {
    logger.info('TELEGRAM_BOT_TOKEN not set — Telegram bot disabled');
    return null;
  }
  const bot = new Bot(env.TELEGRAM_BOT_TOKEN);

  await registerBotHandlers(bot, { prisma, getNotifier });

  bot.catch((err) => logger.warn({ err }, 'grammy bot handler error'));

  // Long-poll in background — don't await (start() resolves only on stop()).
  // A rejected start (409 Conflict from a second poller, invalid token, network
  // loss) must NOT die silently: log it and attempt a bounded, backing-off
  // restart. 409 usually means a duplicate instance — retrying a few times
  // covers a transient overlap during redeploy without hammering the API.
  const MAX_RESTARTS = 5;
  const startWithRetry = (attempt = 0): void => {
    bot.start({ drop_pending_updates: true }).catch((err: unknown) => {
      const conflict = err instanceof GrammyError && err.error_code === 409;
      const level = attempt >= MAX_RESTARTS ? 'fatal' : 'error';
      logger[level](
        { err, attempt, conflict },
        conflict
          ? 'telegram bot start conflict (another poller running)'
          : 'telegram bot start failed',
      );
      if (attempt >= MAX_RESTARTS) return;
      // Exponential backoff, capped at 30s.
      const delayMs = Math.min(2 ** attempt * 1000, 30_000);
      const timer = setTimeout(() => startWithRetry(attempt + 1), delayMs);
      timer.unref();
    });
  };
  startWithRetry();

  logger.info('Telegram bot started (long polling)');
  return bot;
}
