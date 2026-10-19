import type { Bot, Context } from 'grammy';
import type { User } from '@prisma/client';
import { logger } from '@/lib/logger.js';
import { AppError } from '@/lib/errors.js';
import { createOtpMethods, linkTelegramContact } from '@/modules/auth/auth.otp.js';
import {
  createBotServices,
  errorText,
  findUser,
  isDriverMode,
  requireUser,
  showMenu,
  userLang,
  type BotDeps,
} from './context.js';
import { createFlows } from './flows.js';
import { createListing } from './listing.js';
import { createMy } from './my.js';
import { createMyActions } from './my.actions.js';
import { createSettings } from './settings.js';
import { LEGACY_MENU, TEXTS, langOf, type Lang } from './texts.js';
import { contactKeyboard, escapeHtml } from './format.js';

/**
 * The Telegram bot is a full client: search, publish, book, passenger requests,
 * contacts, airport transfers, «Мои» — all through buttons, no typing beyond
 * place names. Sign-in = sharing the Telegram-verified contact once; after that
 * the chat is recognised by users.telegram_id.
 */
export async function registerBotHandlers(bot: Bot, deps: BotDeps): Promise<void> {
  const { prisma } = deps;
  const svc = createBotServices(deps);
  const flows = createFlows(svc);
  const listing = createListing(svc, flows);
  const my = createMy(svc);
  const myActions = createMyActions(svc);
  const settings = createSettings(svc);
  const otp = createOtpMethods(prisma);

  await bot.api
    .setMyCommands([
      { command: 'start', description: 'Главное меню / Башкы меню' },
      { command: 'find', description: 'Найти поездку / Сапар табуу' },
      { command: 'publish', description: 'Опубликовать поездку / Сапар жарыялоо' },
      { command: 'airport', description: 'Аэропорт' },
      { command: 'my', description: 'Мои / Менин сапарларым' },
      { command: 'settings', description: 'Настройки / Жөндөөлөр' },
      { command: 'cancel', description: 'Отмена / Жокко чыгаруу' },
      { command: 'help', description: 'Помощь / Жардам' },
    ])
    .catch((err: unknown) => logger.warn({ err }, 'setMyCommands failed'));

  // The bot is a private assistant — groups and channels are ignored.
  bot.use(async (ctx, next) => {
    if (ctx.chat && ctx.chat.type !== 'private') return;
    await next();
  });

  // Last-resort guard: an unexpected failure still answers the user.
  bot.use(async (ctx, next) => {
    try {
      await next();
    } catch (err) {
      logger.warn({ err, update: ctx.update.update_id }, 'bot handler failed');
      await ctx.reply(TEXTS[langOf(ctx.from?.language_code)].error).catch(() => undefined);
    }
  });

  // Menu buttons in both languages (plus labels of older keyboards) → action.
  const MENU: Record<string, string> = { ...LEGACY_MENU };
  for (const l of ['ru', 'kg'] as Lang[]) {
    const t = TEXTS[l];
    Object.assign(MENU, {
      [t.menuFindTrip]: 'findTrip',
      [t.menuNeedRide]: 'needRide',
      [t.menuFindPassengers]: 'findPassengers',
      [t.menuPublish]: 'publish',
      [t.menuAirport]: 'airport',
      [t.menuMy]: 'my',
      [t.menuToDriver]: 'mode',
      [t.menuToPassenger]: 'mode',
      [t.menuSettings]: 'settings',
      [t.menuHelp]: 'help',
    });
  }

  async function runAction(ctx: Context, action: string): Promise<void> {
    const user = await requireUser(prisma, ctx);
    if (!user) return;
    const l = langOf(user.language);
    switch (action) {
      case 'findTrip':
      case 'needRide':
      case 'findPassengers':
      case 'publish':
      case 'airport':
        await flows.start(ctx, user, action);
        return;
      case 'my':
        await svc.session.clear(ctx.from!.id);
        await my.show(ctx, user);
        return;
      case 'mode': {
        const next = isDriverMode(user) ? 'passenger' : 'driver';
        await svc.users.updateSelf(user.id, { preferredMode: next });
        await showMenu(ctx, { ...user, preferredMode: next }, TEXTS[l].modeNow(next === 'driver'));
        return;
      }
      case 'settings':
        await settings.show(ctx, user);
        return;
      case 'help':
        await showMenu(ctx, user, TEXTS[l].help);
        return;
      case 'cancel':
        await flows.cancel(ctx, user);
        return;
    }
  }

  async function finishLink(ctx: Context, userId: string): Promise<void> {
    if (ctx.from) await svc.session.clear(ctx.from.id);
    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    const t = TEXTS[langOf(user.language)];
    await showMenu(ctx, user, `${t.linked}\n${t.modeNow(isDriverMode(user))}`);
  }

  bot.command('start', async (ctx) => {
    const user = await findUser(prisma, ctx);
    const l = userLang(user, ctx);
    const name = escapeHtml(user?.name ?? ctx.from?.first_name ?? '');
    if (ctx.from) await svc.session.clear(ctx.from.id);
    if (!user) {
      await ctx.reply(TEXTS[l].welcome(name), { parse_mode: 'HTML' });
      await ctx.reply(TEXTS[l].shareContactAsk, { reply_markup: contactKeyboard(l) });
      return;
    }
    await showMenu(ctx, user, `${TEXTS[l].welcomeBack(name)}\n${TEXTS[l].modeNow(isDriverMode(user))}`);
  });
  bot.command('find', (ctx) => runAction(ctx, 'findTrip'));
  bot.command('publish', (ctx) => runAction(ctx, 'publish'));
  bot.command('airport', (ctx) => runAction(ctx, 'airport'));
  bot.command('my', (ctx) => runAction(ctx, 'my'));
  bot.command('settings', (ctx) => runAction(ctx, 'settings'));
  bot.command(['cancel', 'menu'], (ctx) => runAction(ctx, 'cancel'));
  bot.command('help', (ctx) => runAction(ctx, 'help'));

  // Sign-in: the user's OWN contact (user_id === sender) is Telegram-verified.
  bot.on('message:contact', async (ctx) => {
    const c = ctx.message.contact;
    const l = langOf(ctx.from.language_code);
    if (c.user_id !== ctx.from.id) {
      await ctx.reply(TEXTS[l].shareContactOwnOnly, { reply_markup: contactKeyboard(l) });
      return;
    }
    const result = await linkTelegramContact(prisma, ctx.from.id, c.phone_number, c.first_name, ctx.from.language_code).catch(
      (err: unknown) => {
        logger.warn({ err }, 'linkTelegramContact failed');
        return null;
      },
    );
    if (result?.status === 'needs_otp') {
      // Existing web / mobile account: prove the number with a WhatsApp code.
      try {
        await otp.sendOtp(result.phone);
        await svc.session.set(ctx.from.id, { flow: 'link', step: 'code', phone: result.phone });
        await ctx.reply(TEXTS[l].linkCodeSent(result.phone), { reply_markup: { remove_keyboard: true } });
      } catch (err) {
        await ctx.reply(errorText(err, l), { reply_markup: contactKeyboard(l) });
      }
      return;
    }
    if (result?.status !== 'ok') {
      await ctx.reply(result?.status === 'blocked' ? TEXTS[l].blocked : TEXTS[l].error, {
        reply_markup: result?.status === 'blocked' ? { remove_keyboard: true } : contactKeyboard(l),
      });
      return;
    }
    await finishLink(ctx, result.userId);
  });

  async function onLinkCode(ctx: Context, phone: string, text: string): Promise<void> {
    const l = langOf(ctx.from?.language_code);
    try {
      await otp.consumeOtp(phone, text.replace(/\D/g, ''));
    } catch (err) {
      const tooMany = err instanceof AppError && (err.code === 'OTP_TOO_MANY_ATTEMPTS' || err.code === 'RATE_LIMITED');
      await ctx.reply(tooMany ? errorText(err, l) : TEXTS[l].linkCodeWrong, { reply_markup: contactKeyboard(l) });
      return;
    }
    const linked = await linkTelegramContact(prisma, ctx.from!.id, phone, ctx.from?.first_name, ctx.from?.language_code, true);
    if (linked.status === 'ok') await finishLink(ctx, linked.userId);
    else await ctx.reply(linked.status === 'blocked' ? TEXTS[l].blocked : TEXTS[l].error);
  }

  bot.on('message:location', async (ctx) => {
    const user = await requireUser(prisma, ctx);
    if (user) await flows.onLocation(ctx, user, ctx.message.location.latitude, ctx.message.location.longitude);
  });

  bot.on('message:text', async (ctx) => {
    const text = ctx.message.text.trim();
    if (text.startsWith('/')) return;
    const action = MENU[text];
    if (action) {
      await svc.session.clear(ctx.from.id);
      await runAction(ctx, action);
      return;
    }
    const draft = await svc.session.get(ctx.from.id);
    if (draft.flow === 'link' && draft.phone) return onLinkCode(ctx, draft.phone, text);
    const user = await requireUser(prisma, ctx);
    if (!user) return;
    if (!(await flows.onText(ctx, user, text))) await showMenu(ctx, user);
  });

  // ─── Inline buttons ─────────────────────────────────────────────────
  async function onButton(ctx: Context, user: User, data: string): Promise<boolean> {
    if (data === 'lang' || data === 'notify') return settings.onCallback(ctx, user, data);
    if (await listing.onCallback(ctx, user, data)) return true;
    if (await myActions.onCallback(ctx, user, data, (which) => my.section(ctx, user, which))) return true;
    return flows.onCallback(ctx, user, data);
  }

  bot.on('callback_query:data', async (ctx) => {
    let toast: string | undefined;
    try {
      const user = await requireUser(prisma, ctx);
      if (!user) return;
      const l = langOf(user.language);
      try {
        if (!(await onButton(ctx, user, ctx.callbackQuery.data))) toast = TEXTS[l].stale;
      } catch (err) {
        await ctx.reply(errorText(err, l));
      }
    } finally {
      await ctx.answerCallbackQuery(toast ? { text: toast } : undefined).catch(() => undefined);
    }
  });
}
