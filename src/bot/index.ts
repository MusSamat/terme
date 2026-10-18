import type { Bot, Context } from 'grammy';
import { InlineKeyboard } from 'grammy';
import { logger } from '@/lib/logger.js';
import { linkTelegramContact } from '@/modules/auth/auth.otp.js';
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
import { createMy } from './my.js';
import { TEXTS, langOf, type Lang } from './texts.js';
import { contactKeyboard, escapeHtml, mainMenu } from './format.js';

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
  const my = createMy(prisma, svc);

  await bot.api
    .setMyCommands([
      { command: 'start', description: 'Главное меню / Башкы меню' },
      { command: 'find', description: 'Найти поездку / Сапар табуу' },
      { command: 'publish', description: 'Опубликовать поездку / Сапар жарыялоо' },
      { command: 'airport', description: 'Аэропорт' },
      { command: 'my', description: 'Мои / Меникилер' },
      { command: 'settings', description: 'Настройки / Жөндөөлөр' },
      { command: 'help', description: 'Помощь / Жардам' },
    ])
    .catch((err: unknown) => logger.warn({ err }, 'setMyCommands failed'));

  // Menu buttons in both languages → action.
  const MENU: Record<string, string> = {};
  for (const l of ['ru', 'kg'] as Lang[]) {
    const t = TEXTS[l];
    Object.assign(MENU, {
      [t.menuFindTrip]: 'findTrip',
      [t.menuNeedRide]: 'needRide',
      [t.menuFindPassengers]: 'findPassengers',
      [t.menuPublish]: 'publish',
      [t.menuAirport]: 'airport',
      [t.menuMy]: 'my',
      [t.menuModePassenger]: 'mode',
      [t.menuModeDriver]: 'mode',
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
        const updated = await prisma.user.update({ where: { id: user.id }, data: { preferredMode: next } });
        await showMenu(ctx, updated, TEXTS[l].modeNow(next === 'driver'));
        return;
      }
      case 'settings':
        await ctx.reply(TEXTS[l].settingsTitle(l === 'kg' ? 'Кыргызча' : 'Русский', user.notificationsEnabled), {
          parse_mode: 'HTML',
          reply_markup: new InlineKeyboard()
            .text(TEXTS[l].langButton, 'lang')
            .row()
            .text(user.notificationsEnabled ? TEXTS[l].notifyOff : TEXTS[l].notifyOn, 'notify'),
        });
        return;
      case 'help':
        await ctx.reply(TEXTS[l].help, { parse_mode: 'HTML', reply_markup: mainMenu(l, isDriverMode(user)) });
        return;
    }
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
    if (result?.status !== 'ok') {
      await ctx.reply(result?.status === 'blocked' ? TEXTS[l].blocked : TEXTS[l].error, {
        reply_markup: { remove_keyboard: true },
      });
      return;
    }
    const user = await prisma.user.findUniqueOrThrow({ where: { id: result.userId } });
    await showMenu(ctx, user, `${TEXTS[langOf(user.language)].linked}\n${TEXTS[langOf(user.language)].modeNow(isDriverMode(user))}`);
  });

  bot.on('message:location', async (ctx) => {
    const user = await requireUser(prisma, ctx);
    if (user) await flows.onLocation(ctx, user, ctx.message.location.latitude, ctx.message.location.longitude);
  });

  bot.on('message:text', async (ctx) => {
    const text = ctx.message.text.trim();
    if (text.startsWith('/')) return;
    const action = MENU[text];
    if (action) {
      if (ctx.from) await svc.session.clear(ctx.from.id);
      await runAction(ctx, action);
      return;
    }
    const user = await requireUser(prisma, ctx);
    if (!user) return;
    if (!(await flows.onText(ctx, user, text))) await showMenu(ctx, user);
  });

  // ─── Inline buttons ─────────────────────────────────────────────────
  bot.on('callback_query:data', async (ctx) => {
    const data = ctx.callbackQuery.data;
    await ctx.answerCallbackQuery().catch(() => undefined);
    const user = await requireUser(prisma, ctx);
    if (!user) return;
    const l = langOf(user.language);
    try {
      if (data === 'lang') {
        const updated = await prisma.user.update({
          where: { id: user.id },
          data: { language: l === 'kg' ? 'ru' : 'kg' },
        });
        await showMenu(ctx, updated, updated.language === 'kg' ? 'Тил: кыргызча' : 'Язык: русский');
        return;
      }
      if (data === 'notify') {
        await prisma.user.update({ where: { id: user.id }, data: { notificationsEnabled: !user.notificationsEnabled } });
        await ctx.reply(TEXTS[l].done);
        return;
      }
      const decision = /^(accept|reject)_booking_(.+)$/.exec(data);
      if (decision) {
        const bookings = svc.bookings();
        if (decision[1] === 'accept') await bookings.accept(decision[2]!, user.id);
        else await bookings.reject(decision[2]!, user.id);
        await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => undefined);
        await ctx.reply(TEXTS[l].done);
        return;
      }
      if (data === 'go:needRide') return void (await flows.advance(ctx, user));
      if (data.startsWith('tc:')) return void (await flows.revealContact(ctx, user, 'trip', data.slice(3)));
      if (data.startsWith('rc:')) return void (await flows.revealContact(ctx, user, 'request', data.slice(3)));
      if (data.startsWith('tb:')) return void (await flows.startBooking(ctx, user, data.slice(3)));
      if (data.startsWith('ro:')) return void (await flows.startOffer(ctx, user, data.slice(3)));
      if (await my.onCallback(ctx, user, data)) return;
      if (await flows.onCallback(ctx, user, data)) return;
    } catch (err) {
      await ctx.reply(errorText(err, l));
    }
  });
}
