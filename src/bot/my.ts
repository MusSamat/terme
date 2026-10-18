import type { PrismaClient, User } from '@prisma/client';
import { InlineKeyboard, type Context } from 'grammy';
import { errorText, showMenu, type BotServices } from './context.js';
import { TEXTS, langOf, type Lang } from './texts.js';
import { escapeHtml, formatWhen, waLink } from './format.js';

const LIVE_BOOKING = new Set(['pending', 'viewed', 'accepted']);

// «Мои»: what the user is waiting for / has to act on, with one-tap actions.
export function createMy(prisma: PrismaClient, svc: BotServices) {
  const html = { parse_mode: 'HTML' as const };

  async function show(ctx: Context, user: User): Promise<void> {
    const l = langOf(user.language);
    const t = TEXTS[l];
    let shown = 0;
    await ctx.reply(t.myTitle, html);

    const bookings = (await svc.bookings().listMy(user.id, { limit: 20 })).data.filter((b) =>
      LIVE_BOOKING.has(b.status),
    );
    for (const b of bookings) {
      shown++;
      const kb = new InlineKeyboard();
      const phone = b.trip.driver.phone;
      if (b.status === 'accepted' && phone) kb.url(t.writeWhatsapp, waLink(phone)).row();
      kb.text(t.cancelBooking, `cb:${b.id}`);
      await ctx.reply(
        [
          `🎫 <b>${escapeHtml(b.trip.originCity)} → ${escapeHtml(b.trip.destinationCity)}</b>`,
          `🕒 ${formatWhen(b.trip.departureAt, l)} · 💺 ${b.seatsCount}`,
          `👤 ${escapeHtml(b.trip.driver.name)}${b.status === 'accepted' && phone ? ` · 📞 ${phone}` : ''}`,
          t.bookingStatus[b.status] ?? b.status,
        ].join('\n'),
        { ...html, reply_markup: kb },
      );
    }

    const requests = (await svc.requests.listMy(user.id)).data.filter((r) => r.status === 'open');
    for (const r of requests) {
      shown++;
      const offers = await prisma.passengerRequestResponse.count({ where: { requestId: r.id, status: 'pending' } });
      const kb = new InlineKeyboard();
      if (offers > 0) kb.text(t.offers(offers), `of:${r.id}`).row();
      kb.text(t.cancelRequest, `cr:${r.id}`);
      await ctx.reply(
        [`🙋 <b>${escapeHtml(r.originCity)} → ${escapeHtml(r.destinationCity)}</b>`, `🕒 ${formatWhen(r.departureDate, l, !r.flexible)} · 👥 ${r.seatsNeeded}`].join('\n'),
        { ...html, reply_markup: kb },
      );
    }

    const trips = (await svc.trips().myTrips(user.id, { tab: 'active', limit: 20 })).data;
    for (const trip of trips) {
      shown++;
      const waiting = await prisma.booking.count({ where: { tripId: trip.id, status: { in: ['pending', 'viewed'] } } });
      const kb = new InlineKeyboard();
      if (waiting > 0) kb.text(t.incoming(waiting), `in:${trip.id}`).row();
      kb.text(t.cancelTrip, `ct:${trip.id}`);
      await ctx.reply(
        [
          `🚗 <b>${escapeHtml(trip.originCity)} → ${escapeHtml(trip.destinationCity)}</b>`,
          `🕒 ${formatWhen(trip.departureAt, l)} · 💺 ${trip.seatsAvailable}/${trip.seatsTotal} · 💰 ${trip.pricePerSeat} ${t.som}`,
        ].join('\n'),
        { ...html, reply_markup: kb },
      );
    }

    if (shown === 0) await showMenu(ctx, user, t.myEmpty);
  }

  async function incoming(ctx: Context, user: User, tripId: string): Promise<void> {
    const l = langOf(user.language);
    const t = TEXTS[l];
    const list = (await svc.bookings().listIncoming(user.id, { tripId, limit: 20 })).data;
    if (list.length === 0) return void (await ctx.reply(t.myEmpty));
    for (const b of list) {
      const rating = b.passenger.rating ? ` ★${b.passenger.rating.toFixed(1)}` : '';
      await ctx.reply(`👤 <b>${escapeHtml(b.passenger.name)}</b>${rating}\n💺 ${b.seatsCount}${b.comment ? `\n💬 ${escapeHtml(b.comment)}` : ''}`, {
        ...html,
        reply_markup: new InlineKeyboard().text(t.accept, `accept_booking_${b.id}`).text(t.reject, `reject_booking_${b.id}`),
      });
    }
  }

  async function offers(ctx: Context, user: User, requestId: string): Promise<void> {
    const l = langOf(user.language);
    const t = TEXTS[l];
    try {
      const list = (await svc.responses().listResponses(requestId, user.id)).filter((r) => r.status === 'pending');
      if (list.length === 0) return void (await ctx.reply(t.myEmpty));
      for (const r of list) {
        const rating = r.driver.rating ? ` ★${r.driver.rating.toFixed(1)}` : '';
        await ctx.reply(
          `🚗 <b>${escapeHtml(r.driver.name)}</b>${rating}\n🕒 ${formatWhen(r.departureTime, l)} · 💰 ${r.price} ${t.som}${r.message ? `\n💬 ${escapeHtml(r.message)}` : ''}`,
          { ...html, reply_markup: new InlineKeyboard().text(t.acceptOffer, `oa:${r.id}`).text(t.declineOffer, `od:${r.id}`) },
        );
      }
    } catch (err) {
      await ctx.reply(errorText(err, l));
    }
  }

  // Cancel / accept / decline actions; returns false for unknown callbacks.
  async function onCallback(ctx: Context, user: User, data: string): Promise<boolean> {
    const l: Lang = langOf(user.language);
    const [key, id] = [data.slice(0, 2), data.slice(3)];
    try {
      switch (key) {
        case 'in':
          await incoming(ctx, user, id);
          return true;
        case 'of':
          await offers(ctx, user, id);
          return true;
        case 'cb':
          await svc.bookings().cancel(id, user.id, {});
          break;
        case 'ct':
          await svc.trips().cancel(id, user.id);
          break;
        case 'cr':
          await svc.requests.cancel(id, user.id);
          break;
        case 'oa':
        case 'od': {
          const resp = await prisma.passengerRequestResponse.findUnique({ where: { id }, select: { requestId: true } });
          if (!resp) return false;
          if (key === 'oa') await svc.responses().acceptResponse(user.id, resp.requestId, id);
          else await svc.responses().declineResponse(user.id, resp.requestId, id);
          break;
        }
        default:
          return false;
      }
      await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => undefined);
      await ctx.reply(TEXTS[l].done);
    } catch (err) {
      await ctx.reply(errorText(err, l));
    }
    return true;
  }

  return { show, onCallback };
}
