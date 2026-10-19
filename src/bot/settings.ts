import type { PrismaClient, User } from '@prisma/client';
import { InlineKeyboard, type Context } from 'grammy';
import { showMenu, type BotServices } from './context.js';
import { TEXTS, langOf } from './texts.js';
import { HTML } from './format.js';

// «Настройки»: language and notifications, toggled in place on one message.
export function createSettings(prisma: PrismaClient, svc: BotServices) {
  function view(user: User) {
    const t = TEXTS[langOf(user.language)];
    return {
      text: t.settingsTitle(t.langName, user.notificationsEnabled),
      markup: new InlineKeyboard()
        .text(t.langButton, 'lang')
        .row()
        .text(user.notificationsEnabled ? t.notifyOff : t.notifyOn, 'notify'),
    };
  }

  async function show(ctx: Context, user: User): Promise<void> {
    const { text, markup } = view(user);
    await ctx.reply(text, { ...HTML, reply_markup: markup });
  }

  async function onCallback(ctx: Context, user: User, data: 'lang' | 'notify'): Promise<boolean> {
    let updated: User;
    if (data === 'lang') {
      const language = langOf(user.language) === 'kg' ? 'ru' : 'kg';
      await svc.users.updateSelf(user.id, { language });
      updated = { ...user, language };
    } else {
      // No users-service method covers this flag yet — direct update.
      updated = await prisma.user.update({
        where: { id: user.id },
        data: { notificationsEnabled: !user.notificationsEnabled },
      });
    }
    const { text, markup } = view(updated);
    await ctx.editMessageText(text, { ...HTML, reply_markup: markup }).catch(() => undefined);
    // The reply keyboard is per-language — resend the menu after a language switch.
    if (data === 'lang') await showMenu(ctx, updated, TEXTS[langOf(updated.language)].langChanged);
    return true;
  }

  return { show, onCallback };
}
