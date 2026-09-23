import type { PrismaClient } from '@prisma/client';
import { Bot, type Context, GrammyError, InlineKeyboard, Keyboard } from 'grammy';
import { env } from '@/config/env.js';
import { logger } from '@/lib/logger.js';
import {
  handleTelegramLinkToken,
  handleBotLoginToken,
  registerFromTelegramContact,
} from '@/modules/auth/auth.otp.js';
import { createBookingsService } from '@/modules/bookings/bookings.service.js';
import { AppError } from '@/lib/errors.js';
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
 * selects the matching template. Commands: /start, /help, /mytrips, /support,
 * /lang, /unsubscribe, /subscribe.
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
    kg: '📬 <b>Сапарга жаңы арыз</b>\nКимден: <b>{passengerName}</b>{ratingSuffix}\nСапар: {from} → {to}\nДата: {date}\nОрундар: {seats}',
  },
  booking_accepted: {
    ru: '✅ <b>{driverName}</b> принял ваш запрос! Чат открыт.',
    kg: '✅ <b>{driverName}</b> арызыңызды кабыл алды! Чат ачылды.',
  },
  booking_rejected: {
    ru: '❌ Водитель отклонил ваш запрос.',
    kg: '❌ Айдоочу арызыңызды четке какты.',
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

// Mini App base for deep-link buttons (TZ §8.6 routes). Telegram `web_app`
// buttons require HTTPS, so on a plain-http dev host we omit them entirely
// (callback Accept/Reject buttons still work — they carry no URL).
const MINI_APP_URL = (env.MINI_APP_URL ?? env.BASE_URL).replace(/\/$/, '');
const MINI_APP_HTTPS = MINI_APP_URL.startsWith('https://');

function miniAppUrl(path: string): string {
  return `${MINI_APP_URL}${path}`;
}

const L = (lang: 'ru' | 'kg', ru: string, kg: string): string => (lang === 'kg' ? kg : ru);

// Map a thrown AppError to a short localized toast for the callback button.
function bookingDecisionError(err: unknown, lang: 'ru' | 'kg'): string {
  if (err instanceof AppError) {
    switch (err.code) {
      case 'FORBIDDEN':
        return L(lang, 'Это не ваша поездка', 'Бул сиздин сапарыңыз эмес');
      case 'SEATS_NOT_AVAILABLE':
        return L(lang, 'Мест больше нет', 'Орун калган жок');
      case 'TRIP_NOT_ACTIVE':
        return L(lang, 'Поездка неактивна', 'Сапар активдүү эмес');
      case 'CONFLICT':
        return L(lang, 'Запрос уже обработан', 'Арыз мурунтан иштелген');
      case 'NOT_FOUND':
        return L(lang, 'Запрос не найден', 'Арыз табылган жок');
      default:
        break;
    }
  }
  return L(lang, 'Ошибка. Откройте приложение.', 'Ката. Колдонмону ачыңыз.');
}

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
          if (MINI_APP_HTTPS) {
            kb.row().webApp(L(lang, '→ Открыть', '→ Ачуу'), miniAppUrl('/my/bookings'));
          }
          return kb;
        },
      );
    },
    async bookingAccepted(passengerUserId, { booking }) {
      const driverName = await driverNameForBooking(prisma, booking);
      await send(passengerUserId, T.booking_accepted, { driverName }, (lang) =>
        MINI_APP_HTTPS
          ? new InlineKeyboard().webApp(
              L(lang, '💬 Чат', '💬 Чат'),
              miniAppUrl(`/my/bookings/${booking.id}/chat`),
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
          MINI_APP_HTTPS
            ? new InlineKeyboard().webApp(
                L(lang, '→ Ответить', '→ Жооп берүү'),
                miniAppUrl(`/my/bookings/${message.bookingId}/chat`),
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
          MINI_APP_HTTPS
            ? new InlineKeyboard().webApp(L(lang, '→ Посмотреть', '→ Көрүү'), miniAppUrl('/profile'))
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
      await send(passengerId, { ru: 'Водитель {name} предлагает поездку за {price} сом', kg: 'Айдоочу {name} жол {price} сом сунуштады' }, { name: payload.driverName, price: payload.price });
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

  await bot.api
    .setMyCommands([
      { command: 'start', description: '🏠 Главное меню' },
      { command: 'find', description: '🔍 Найти поездку' },
      { command: 'publish', description: '➕ Опубликовать поездку' },
      { command: 'my', description: '📋 Мои поездки и брони' },
      { command: 'help', description: 'ℹ️ Как это работает' },
      { command: 'lang', description: '🌐 Язык / Тил' },
      { command: 'support', description: '💬 Поддержка' },
      { command: 'unsubscribe', description: '🔕 Отключить уведомления' },
      { command: 'subscribe', description: '🔔 Включить уведомления' },
    ])
    .catch((err: unknown) => logger.warn({ err }, 'setMyCommands failed'));

  if (MINI_APP_HTTPS) {
    await bot.api
      .setChatMenuButton({
        menu_button: {
          type: 'web_app',
          text: '🚗 Открыть Terme',
          web_app: { url: MINI_APP_URL },
        },
      })
      .catch((err: unknown) => logger.warn({ err }, 'setChatMenuButton failed'));
  }

  bot.command('start', async (ctx: Context) => {
    const payload = ctx.match as string | undefined;
    logger.debug({ payload, from: ctx.from?.id }, 'bot /start received');
    if (payload?.startsWith('reg_') && ctx.from) {
      await handleTelegramLinkToken(prisma, bot, payload.slice(4), ctx.from.id).catch(
        (err: unknown) => logger.warn({ err }, 'handleTelegramLinkToken failed'),
      );
      return;
    }
    if (payload?.startsWith('bl_') && ctx.from) {
      const outcome = await handleBotLoginToken(prisma, bot, payload.slice(3), ctx.from.id).catch(
        (err: unknown) => {
          logger.warn({ err }, 'handleBotLoginToken failed');
          return 'expired' as const;
        },
      );
      if (outcome === 'need_contact') {
        // Free registration: ask the user to share their Telegram-verified
        // number. The reply keyboard's request_contact button returns a contact
        // whose user_id is the sharer's own — no OTP, no SMS.
        const kb = new Keyboard().requestContact('📱 Поделиться номером').oneTime().resized();
        await ctx.reply(
          'Один шаг до регистрации в Terme 🚗\n\nНажмите кнопку ниже, чтобы поделиться номером телефона — Telegram подтвердит его автоматически.',
          { reply_markup: kb },
        );
      }
      return;
    }

    // User-controlled name goes into parse_mode:'HTML' — escape it, otherwise
    // a name containing <>& breaks rendering (or the sendMessage call itself).
    const escapeHtml = (v: string): string =>
      v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const firstName = escapeHtml(ctx.from?.first_name ?? 'друг');
    const isReturning = ctx.from
      ? !!(await prisma.authProvider.findFirst({
          where: { provider: 'telegram', providerUserId: String(ctx.from.id) },
        }))
      : false;



    const greeting = isReturning
      ? `👋 С возвращением, <b>${firstName}</b>!`
      : `👋 Привет, <b>${firstName}</b>!`;

    const text =
      `${greeting}\n\n` +
      `🚗 <b>Terme — поездки по Кыргызстану</b>\n\n` +
      `Попутчики и такси из Бишкека в Ош, Каракол, Нарын и другие города. Или предложи свою поездку!\n\n` +
      `✅ Верифицированные водители\n` +
      `⭐ Рейтинги и отзывы\n` +
      `💬 Встроенный чат\n` +
      `📱 Работает прямо в Telegram`;

    // Phase 1: no roles — one clear action set for everyone. Publishing asks
    // for a car inside the form, no verification needed.
    const kb = new InlineKeyboard();
    if (MINI_APP_HTTPS) {
      kb.webApp('🔍 Найти поездку', miniAppUrl('/trips'))
        .webApp('🧍 Найти пассажира', miniAppUrl('/requests'))
        .row();
      kb.webApp('➕ Опубликовать поездку', miniAppUrl('/trips/create')).row();
      kb.webApp('📋 Мои поездки и брони', miniAppUrl('/my/bookings')).row();
    }
    kb.text('🌐 Язык', 'lang').text('🔔 Уведомления', 'notify').row();
    kb.text('ℹ️ Помощь', 'help');
    await ctx.reply(text, { parse_mode: 'HTML', reply_markup: kb });
  });

  bot.callbackQuery('help', async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.reply(
      'Платформа попутчиков. Публикуйте поездки, бронируйте места.\nПоддержка: @tappjet_support',
    );
  });

  bot.callbackQuery('notify', async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!ctx.from) return;
    const user = await prisma.user.findFirst({ where: { telegramId: BigInt(ctx.from.id) } });
    if (!user) {
      await ctx.reply('Войдите через приложение, чтобы управлять уведомлениями.');
      return;
    }
    const next = !user.notificationsEnabled;
    await prisma.user.update({ where: { id: user.id }, data: { notificationsEnabled: next } });
    await ctx.reply(next ? '🔔 Уведомления включены.' : '🔕 Уведомления отключены.');
  });

  bot.callbackQuery('lang', async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!ctx.from) return;
    const user = await prisma.user.findFirst({ where: { telegramId: BigInt(ctx.from.id) } });
    if (!user) {
      await ctx.reply('Войдите через приложение.');
      return;
    }
    const next = user.language === 'ru' ? 'kg' : 'ru';
    await prisma.user.update({ where: { id: user.id }, data: { language: next } });
    await ctx.reply(next === 'kg' ? 'Тил: кыргызча' : 'Язык: русский');
  });

  // ─── Accept / Reject a booking straight from the notification ────────
  // Reuses bookingsService — which enforces driver ownership and the seat
  // transaction — so the bot path is exactly as safe as the REST path.
  const decide = async (
    ctx: Context,
    action: 'accept' | 'reject',
    bookingId: string,
  ): Promise<void> => {
    if (!ctx.from) {
      await ctx.answerCallbackQuery();
      return;
    }
    const user = await prisma.user.findFirst({ where: { telegramId: BigInt(ctx.from.id) } });
    if (!user) {
      await ctx.answerCallbackQuery({ text: 'Войдите через приложение', show_alert: true });
      return;
    }
    const notifier = getNotifier();
    if (!notifier) {
      await ctx.answerCallbackQuery({
        text: 'Сервис недоступен — откройте приложение',
        show_alert: true,
      });
      return;
    }
    const lang: 'ru' | 'kg' = user.language === 'kg' ? 'kg' : 'ru';
    const bookings = createBookingsService(prisma, notifier);
    try {
      if (action === 'accept') await bookings.accept(bookingId, user.id);
      else await bookings.reject(bookingId, user.id);
      const ok =
        action === 'accept'
          ? L(lang, '✅ Принято. Чат открыт.', '✅ Кабыл алынды. Чат ачылды.')
          : L(lang, '❌ Отклонено', '❌ Четке кагылды');
      await ctx.answerCallbackQuery({ text: ok });
      // Drop the buttons so the request can't be actioned twice.
      await ctx.editMessageReplyMarkup().catch(() => undefined);
    } catch (err) {
      logger.warn({ err, bookingId, action }, 'bot booking decision failed');
      await ctx.answerCallbackQuery({ text: bookingDecisionError(err, lang), show_alert: true });
    }
  };

  bot.callbackQuery(/^accept_booking_(.+)$/, (ctx) => decide(ctx, 'accept', ctx.match[1]!));
  bot.callbackQuery(/^reject_booking_(.+)$/, (ctx) => decide(ctx, 'reject', ctx.match[1]!));

  // Shared phone from the request_contact button → finish free registration.
  bot.on('message:contact', async (ctx) => {
    const c = ctx.message.contact;
    // Only the user's OWN contact carries user_id === sender; a manually
    // attached foreign contact is rejected (can't register someone else).
    if (!ctx.from || c.user_id !== ctx.from.id) {
      await ctx.reply('Пожалуйста, нажмите именно кнопку «Поделиться номером».');
      return;
    }
    const result = await registerFromTelegramContact(
      prisma, ctx.from.id, c.phone_number, c.first_name, ctx.from.language_code,
    ).catch((err: unknown) => {
      logger.warn({ err }, 'registerFromTelegramContact failed');
      return 'no_pending' as const;
    });
    if (result === 'ok') {
      await ctx.reply('✅ Готово! Аккаунт создан. Вернитесь в браузер — вы уже вошли.', {
        reply_markup: { remove_keyboard: true },
      });
    } else if (result === 'blocked') {
      await ctx.reply('Аккаунт заблокирован. Обратитесь в поддержку.', {
        reply_markup: { remove_keyboard: true },
      });
    } else {
      await ctx.reply('Регистрация не начата или ссылка устарела. Откройте сайт и нажмите «Продолжить через Telegram» заново.', {
        reply_markup: { remove_keyboard: true },
      });
    }
  });

  // Single-purpose commands — each answers with one clear web-app button so
  // first-timers never have to type or guess anything.
  const linkCommand = (text: string, btn: string, path: string) => async (ctx: Context) => {
    const kb = MINI_APP_HTTPS
      ? new InlineKeyboard().webApp(btn, miniAppUrl(path))
      : undefined;
    await ctx.reply(text, kb ? { reply_markup: kb } : undefined);
  };
  bot.command('find', linkCommand(
    'Куда едем? Нажмите кнопку — увидите все поездки по вашему маршруту.',
    '🔍 Найти поездку', '/trips',
  ));
  bot.command('publish', linkCommand(
    'Едете сами и есть свободные места? Опубликуйте поездку за 30 секунд — пассажиры позвонят напрямую.',
    '➕ Опубликовать поездку', '/trips/create',
  ));
  bot.command('my', linkCommand(
    'Ваши объявления, брони и избранное — в одном месте.',
    '📋 Открыть «Мои»', '/my/bookings',
  ));

  bot.command('help', (ctx: Context) =>
    ctx.reply(
      'Платформа попутчиков. Публикуйте поездки, бронируйте места. Поддержка: @tappjet_support',
    ),
  );

  bot.command('support', (ctx: Context) =>
    ctx.reply('Контакт поддержки: @tappjet_support'),
  );

  bot.command('lang', async (ctx: Context) => {
    if (!ctx.from) return;
    const user = await prisma.user.findFirst({ where: { telegramId: BigInt(ctx.from.id) } });
    if (!user) return;
    const next = user.language === 'ru' ? 'kg' : 'ru';
    await prisma.user.update({ where: { id: user.id }, data: { language: next } });
    await ctx.reply(next === 'kg' ? 'Тил: кыргызча' : 'Язык: русский');
  });

  const toggleSubscribe = async (ctx: Context, enabled: boolean): Promise<void> => {
    if (!ctx.from) return;
    const user = await prisma.user.findFirst({ where: { telegramId: BigInt(ctx.from.id) } });
    if (!user) return;
    await prisma.user.update({
      where: { id: user.id },
      data: { notificationsEnabled: enabled },
    });
    await ctx.reply(
      enabled ? 'Вы подписаны на уведомления.' : 'Вы отписаны от уведомлений.',
    );
  };
  bot.command('unsubscribe', (ctx: Context) => toggleSubscribe(ctx, false));
  bot.command('subscribe', (ctx: Context) => toggleSubscribe(ctx, true));

  bot.command('mytrips', async (ctx: Context) => {
    if (!ctx.from) return;
    const user = await prisma.user.findFirst({ where: { telegramId: BigInt(ctx.from.id) } });
    if (!user) {
      await ctx.reply('Войдите через Mini App.');
      return;
    }
    const now = new Date();
    const [active, pending, accepted] = await Promise.all([
      prisma.trip.count({
        where: { driverId: user.id, status: 'active', departureAt: { gte: now } },
      }),
      prisma.booking.count({ where: { passengerId: user.id, status: 'pending' } }),
      prisma.booking.count({ where: { passengerId: user.id, status: 'accepted' } }),
    ]);
    await ctx.reply(
      `Активных поездок (как водитель): ${active}\n` +
        `Бронирований в ожидании: ${pending}\n` +
        `Принятых бронирований: ${accepted}`,
    );
  });

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
