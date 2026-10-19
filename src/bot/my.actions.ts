import type { PrismaClient, User } from '@prisma/client';
import { InlineKeyboard, type Context } from 'grammy';
import { logger } from '@/lib/logger.js';
import type { BotServices } from './context.js';
import { TEXTS, langOf, type Lang } from './texts.js';
import { HTML, escapeHtml, formatWhen, waLink } from './format.js';

// Destructive actions ask first: «cb:<id>» → «Да» (yb:<id>) / «Нет» (no).
const ASK: Record<string, { confirm: string; question: 'askCancelBooking' | 'askCancelTrip' | 'askCancelRequest' | 'askCompleteTrip' }> = {
  cb: { confirm: 'yb', question: 'askCancelBooking' },
  ct: { confirm: 'yt', question: 'askCancelTrip' },
  cr: { confirm: 'yr', question: 'askCancelRequest' },
  tf: { confirm: 'yf', question: 'askCompleteTrip' },
};

const rated = (r: number | null): string => (r ? ` ★${r.toFixed(1)}` : '');

/** Buttons on «Мои» cards and on notifications (accept / decline / cancel). */
export function createMyActions(prisma: PrismaClient, svc: BotServices) {
  // Result text + the counterpart's contact (phone is visible once accepted).
  async function replyWithContact(ctx: Context, l: Lang, text: string, name: string, phone: string | null | undefined) {
    const kb = phone ? new InlineKeyboard().url(TEXTS[l].writeWhatsapp, waLink(phone)) : undefined;
    await ctx.reply(`${text}\n\n${TEXTS[l].personLine(escapeHtml(name), phone ?? null)}`, {
      ...HTML,
      ...(kb ? { reply_markup: kb } : {}),
    });
  }

  async function incoming(ctx: Context, user: User, tripId: string): Promise<void> {
    const l = langOf(user.language);
    const t = TEXTS[l];
    const bookings = svc.bookings();
    const list = (await bookings.listIncoming(user.id, { tripId, limit: 20 })).data;
    if (list.length === 0) return void (await ctx.reply(t.sectionEmpty));
    for (const b of list) {
      // Opening the request counts as «seen», same as on the web.
      if (b.status === 'pending') {
        await bookings.markViewed(b.id, user.id).catch((err: unknown) => logger.warn({ err }, 'bot markViewed failed'));
      }
      await ctx.reply(
        `👤 <b>${escapeHtml(b.passenger.name)}</b>${rated(b.passenger.rating)}\n💺 ${b.seatsCount}${b.comment ? `\n💬 ${escapeHtml(b.comment)}` : ''}`,
        { ...HTML, reply_markup: new InlineKeyboard().text(t.accept, `accept_booking_${b.id}`).text(t.reject, `reject_booking_${b.id}`) },
      );
    }
  }

  async function offers(ctx: Context, user: User, requestId: string): Promise<void> {
    const l = langOf(user.language);
    const t = TEXTS[l];
    const list = (await svc.responses().listResponses(requestId, user.id)).filter((r) => r.status === 'pending');
    if (list.length === 0) return void (await ctx.reply(t.sectionEmpty));
    for (const r of list) {
      await ctx.reply(
        `🚗 <b>${escapeHtml(r.driver.name)}</b>${rated(r.driver.rating)}\n🕒 ${formatWhen(r.departureTime, l)} · 💰 ${r.price} ${t.som}${r.message ? `\n💬 ${escapeHtml(r.message)}` : ''}`,
        { ...HTML, reply_markup: new InlineKeyboard().text(t.acceptOffer, `oa:${r.id}`).text(t.declineOffer, `od:${r.id}`) },
      );
    }
  }

  // Confirmed destructive action → the question message turns into the result.
  async function perform(ctx: Context, user: User, key: string, id: string): Promise<boolean> {
    const t = TEXTS[langOf(user.language)];
    let result: string;
    switch (key) {
      case 'yb':
        await svc.bookings().cancel(id, user.id, {});
        result = t.bookingCancelled;
        break;
      case 'yt':
        await svc.trips().cancel(id, user.id);
        result = t.tripCancelled;
        break;
      case 'yr':
        await svc.requests.cancel(id, user.id);
        result = t.requestCancelled;
        break;
      case 'yf':
        await svc.trips().complete(id, user.id);
        result = t.tripCompleted;
        break;
      default:
        return false;
    }
    await ctx.editMessageText(result).catch(() => ctx.reply(result));
    return true;
  }

  async function decide(ctx: Context, user: User, key: string, id: string): Promise<boolean> {
    const l = langOf(user.language);
    const t = TEXTS[l];
    switch (key) {
      case 'accept_booking': {
        const b = await svc.bookings().accept(id, user.id);
        await ctx.editMessageReplyMarkup().catch(() => undefined);
        await replyWithContact(ctx, l, t.bookingAccepted, b.passenger.name, b.passenger.phone);
        return true;
      }
      case 'reject_booking':
        await svc.bookings().reject(id, user.id);
        await ctx.editMessageReplyMarkup().catch(() => undefined);
        await ctx.reply(t.bookingRejected);
        return true;
      case 'oa':
      case 'od': {
        // callback_data fits one uuid only — the request id is looked up.
        const resp = await prisma.passengerRequestResponse.findUnique({ where: { id }, select: { requestId: true } });
        if (!resp) return false;
        await ctx.editMessageReplyMarkup().catch(() => undefined);
        if (key === 'od') {
          await svc.responses().declineResponse(user.id, resp.requestId, id);
          await ctx.reply(t.offerDeclined);
          return true;
        }
        const { bookingId } = await svc.responses().acceptResponse(user.id, resp.requestId, id);
        const b = await svc.bookings().getById(bookingId, user.id);
        await replyWithContact(ctx, l, t.offerAccepted, b.trip.driver.name, b.trip.driver.phone);
        return true;
      }
      default:
        return false;
    }
  }

  /** Returns false for callbacks that are not «Мои» actions. */
  async function onCallback(ctx: Context, user: User, data: string, showSection: (which: string) => Promise<boolean>) {
    const t = TEXTS[langOf(user.language)];
    const decision = /^(accept_booking|reject_booking)_(.+)$/.exec(data);
    if (decision) return decide(ctx, user, decision[1]!, decision[2]!);
    if (data === 'no') {
      await ctx.editMessageText(t.keptAsIs).catch(() => undefined);
      return true;
    }
    const [key, id] = [data.slice(0, 2), data.slice(3)];
    if (data[2] !== ':' || !id) return false;
    const ask = ASK[key];
    if (ask) {
      await ctx.reply(t[ask.question], {
        reply_markup: new InlineKeyboard()
          .text(key === 'tf' ? t.yesComplete : t.yesCancel, `${ask.confirm}:${id}`)
          .text(t.no, 'no'),
      });
      return true;
    }
    switch (key) {
      case 'my':
        return showSection(id);
      case 'in':
        await incoming(ctx, user, id);
        return true;
      case 'of':
        await offers(ctx, user, id);
        return true;
      case 'oa':
      case 'od':
        return decide(ctx, user, key, id);
      default:
        return perform(ctx, user, key, id);
    }
  }

  return { onCallback };
}
