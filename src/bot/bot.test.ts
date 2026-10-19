import { beforeEach, describe, expect, it } from 'vitest';
import { Bot } from 'grammy';
import type { Update } from 'grammy/types';
import { testPrisma } from '../../tests/setup.js';
import { CITY } from '../../tests/cities.js';
import { createBooking, createTrip, createUser, createVerifiedDriver } from '../../tests/factories.js';
import { createPassengerRequestsService } from '@/modules/passenger-requests/passenger-requests.service.js';
import { registerBotHandlers } from './index.js';
import { getSentMessages, clearSentMessages } from '@/lib/otpCapture.js';
import { env } from '@/config/env.js';
import { TEXTS } from './texts.js';

// The bot runs against the real DB; Telegram API calls are captured instead of sent.
interface Call {
  method: string;
  payload: Record<string, unknown>;
}

const TG = 700_100;
let calls: Call[];
let bot: Bot;
let updateId = 1;

beforeEach(async () => {
  calls = [];
  bot = new Bot('test-bot-token-1234567890', {
    botInfo: {
      id: 1,
      is_bot: true,
      first_name: 'Terme',
      username: 'terme_kg_bot',
      can_join_groups: false,
      can_read_all_group_messages: false,
      supports_inline_queries: false,
      can_connect_to_business: false,
      has_main_web_app: false,
      can_manage_bots: false,
      has_topics_enabled: false,
      allows_users_to_create_topics: false,
    } as never,
  });
  bot.api.config.use(async (_prev, method, payload) => {
    calls.push({ method, payload: payload as Record<string, unknown> });
    const result =
      method === 'sendMessage'
        ? { message_id: calls.length, date: 0, chat: { id: TG, type: 'private' }, text: '' }
        : true;
    return { ok: true, result } as never;
  });
  await registerBotHandlers(bot, { prisma: testPrisma, getNotifier: () => null });
});

const from = { id: TG, is_bot: false, first_name: 'Айбек', language_code: 'ru' };
const chat = { id: TG, type: 'private' as const, first_name: 'Айбек' };

async function text(t: string): Promise<void> {
  const entities = t.startsWith('/') ? [{ type: 'bot_command' as const, offset: 0, length: t.split(' ')[0]!.length }] : undefined;
  await bot.handleUpdate({
    update_id: updateId++,
    message: { message_id: updateId, date: 0, chat, from, text: t, ...(entities ? { entities } : {}) },
  } as Update);
}

async function press(data: string): Promise<void> {
  await bot.handleUpdate({
    update_id: updateId++,
    callback_query: {
      id: String(updateId),
      from,
      chat_instance: 'x',
      data,
      message: { message_id: 1, date: 0, chat, text: '' },
    },
  } as Update);
}

const sent = () => calls.filter((c) => c.method === 'sendMessage').map((c) => String(c.payload['text']));
const lastButtons = (): string[] => {
  const msg = [...calls].reverse().find((c) => c.method === 'sendMessage' && c.payload['reply_markup']);
  const markup = msg?.payload['reply_markup'] as { inline_keyboard?: Array<Array<{ callback_data?: string }>> };
  return (markup?.inline_keyboard ?? []).flat().map((b) => b.callback_data ?? '');
};

const toasts = (): string[] =>
  calls.filter((c) => c.method === 'answerCallbackQuery' && c.payload['text']).map((c) => String(c.payload['text']));
const draft = async () =>
  ((await testPrisma.botSession.findUnique({ where: { telegramId: BigInt(TG) } }))?.data ?? {}) as Record<string, unknown>;
// DD.MM of a Bishkek day `days` from now.
const ddmm = (days: number): string => {
  const [, m, d] = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bishkek' }).format(new Date(Date.now() + days * 86_400_000)).split('-');
  return `${d}.${m}`;
};

async function linkedUser(mode: 'passenger' | 'driver' = 'passenger') {
  const u = mode === 'driver'
    ? await createVerifiedDriver(testPrisma, { plate: `BOT${Math.floor(Math.random() * 1e5)}` })
    : await createUser(testPrisma);
  await testPrisma.user.update({ where: { id: u.id }, data: { telegramId: BigInt(TG), preferredMode: mode } });
  return u;
}

describe('Telegram bot', () => {
  it('/start asks a new chat to share its number; sharing links the account', async () => {
    await text('/start');
    const ask = calls.filter((c) => c.method === 'sendMessage').at(-1)!.payload['reply_markup'] as {
      keyboard: Array<Array<{ text: string; request_contact?: boolean }>>;
    };
    expect(ask.keyboard[0]![0]).toMatchObject({ text: '📱 Поделиться номером', request_contact: true });

    await bot.handleUpdate({
      update_id: updateId++,
      message: {
        message_id: 99,
        date: 0,
        chat,
        from,
        contact: { phone_number: '996700555111', first_name: 'Айбек', user_id: TG },
      },
    } as Update);
    const user = await testPrisma.user.findFirst({ where: { telegramId: BigInt(TG) } });
    expect(user).toMatchObject({ phone: '+996700555111', name: 'Айбек' });
    expect(sent().at(-1)).toContain('Номер подтверждён');
  });

  it('an existing web / mobile account is linked only after its WhatsApp code', async () => {
    clearSentMessages();
    const existing = await createUser(testPrisma, { phone: '+996700555222' });
    const contact = (phone: string) =>
      bot.handleUpdate({
        update_id: updateId++,
        message: { message_id: 97, date: 0, chat, from, contact: { phone_number: phone, first_name: 'Айбек', user_id: TG } },
      } as Update);
    await contact('996700555222');
    expect((await testPrisma.user.findUniqueOrThrow({ where: { id: existing.id } })).telegramId).toBeNull();
    expect(sent().at(-1)).toContain('код в WhatsApp');

    await text('000000');
    expect(sent().at(-1)).toContain('Код неверный');
    await contact('996700555222'); // new code (gap) is rate limited → resend after the gap in real life
    const code = /(\d{6})/.exec(getSentMessages().find((m) => m.phone === '+996700555222')!.text)![1]!;
    await testPrisma.botSession.update({
      where: { telegramId: BigInt(TG) },
      data: { data: { flow: 'link', step: 'code', phone: '+996700555222' } },
    });
    await testPrisma.otpCode.updateMany({ where: { phone: '+996700555222' }, data: { attempts: 0 } });
    await text(code);
    expect((await testPrisma.user.findUniqueOrThrow({ where: { id: existing.id } })).telegramId).toBe(BigInt(TG));
  });

  it('a stale «any date» button cannot corrupt a publish draft', async () => {
    const u = await linkedUser('driver');
    await text('➕ Опубликовать поездку');
    await press(`pl:${CITY['Бишкек']}`);
    await press(`pl:${CITY['Нарын']}`);
    await press('d:any'); // from an old search message
    const draft = await testPrisma.botSession.findUniqueOrThrow({ where: { telegramId: BigInt(TG) } });
    expect((draft.data as { date?: unknown }).date).toBeUndefined();
    expect(await testPrisma.trip.count({ where: { driverId: u.id } })).toBe(0);
  });

  it('refuses a forwarded foreign contact', async () => {
    await bot.handleUpdate({
      update_id: updateId++,
      message: { message_id: 98, date: 0, chat, from, contact: { phone_number: '996700555112', first_name: 'X', user_id: 1 } },
    } as Update);
    expect(await testPrisma.user.count()).toBe(0);
  });

  it('passenger finds a trip: place by text → pick → date → card with Contact / Book', async () => {
    await linkedUser('passenger');
    const d = await createVerifiedDriver(testPrisma, { plate: 'BOTD1' });
    await testPrisma.trip.create({
      data: {
        driverId: d.id,
        originCityId: CITY['Бишкек'], originCity: 'Бишкек',
        destinationCityId: CITY['Ош'], destinationCity: 'Ош',
        departureAt: new Date(Date.now() + 26 * 60 * 60_000),
        estimatedDurationMin: 600, seatsTotal: 3, seatsAvailable: 3, pricePerSeat: 1200, status: 'active',
      },
    });
    await text('🔍 Найти поездку');
    await text('бишкек');
    expect(lastButtons()).toContain(`pl:${CITY['Бишкек']}`);
    await press(`pl:${CITY['Бишкек']}`);
    await text('Ош');
    await press(`pl:${CITY['Ош']}`);
    await press('d:any');
    expect(sent().some((m) => m.includes('Бишкек → Ош') && m.includes('1200'))).toBe(true);
    expect(lastButtons().some((b) => b.startsWith('tb:'))).toBe(true);
  });

  it('passenger posts a ride request when nothing is found', async () => {
    const u = await linkedUser('passenger');
    await text('🙋 Нужна поездка');
    await press(`pl:${CITY['Бишкек']}`);
    await press(`pl:${CITY['Каракол']}`);
    const [tomorrow] = lastButtons().filter((b) => b.startsWith('d:')).slice(1);
    await press(tomorrow!);
    await press('sk'); // time: flexible
    await press('n:2');
    await press('sk'); // comment
    await press('ok');
    const req = await testPrisma.passengerRequest.findFirstOrThrow({ where: { passengerId: u.id } });
    expect(req).toMatchObject({ originCityId: CITY['Бишкек'], destinationCityId: CITY['Каракол'], seatsNeeded: 2, flexible: true });
  });

  it('driver publishes a trip step by step', async () => {
    const u = await linkedUser('driver');
    await text('➕ Опубликовать поездку');
    await press(`pl:${CITY['Бишкек']}`);
    await press(`pl:${CITY['Нарын']}`);
    const [, tomorrow] = lastButtons().filter((b) => b.startsWith('d:'));
    await press(tomorrow!);
    await text('07:30');
    await press('n:3');
    await text('900');
    await text('Выезд от ЦУМа');
    const beforeConfirm = await draft();
    await press('ok');
    // A second «Подтвердить» (double tap racing the first) replays, not duplicates.
    await testPrisma.botSession.create({ data: { telegramId: BigInt(TG), data: beforeConfirm as never } });
    await press('ok');
    expect(await testPrisma.trip.count({ where: { driverId: u.id } })).toBe(1);
    const trip = await testPrisma.trip.findFirstOrThrow({ where: { driverId: u.id } });
    expect(trip).toMatchObject({ destinationCityId: CITY['Нарын'], seatsTotal: 3, pricePerSeat: 900, comment: 'Выезд от ЦУМа' });
    expect(sent().at(-1)).toContain('опубликована');
  });

  it('passenger reveals the driver contact (WhatsApp button) and books a seat', async () => {
    const u = await linkedUser('passenger');
    const d = await createVerifiedDriver(testPrisma, { plate: 'BOTD2' });
    const trip = await testPrisma.trip.create({
      data: {
        driverId: d.id,
        originCityId: CITY['Бишкек'], originCity: 'Бишкек',
        destinationCityId: CITY['Ош'], destinationCity: 'Ош',
        departureAt: new Date(Date.now() + 30 * 60 * 60_000),
        estimatedDurationMin: 600, seatsTotal: 3, seatsAvailable: 3, pricePerSeat: 1000, status: 'active',
      },
    });
    await press(`tc:${trip.id}`);
    const contactMsg = calls.filter((c) => c.method === 'sendMessage').at(-1)!;
    expect(String(contactMsg.payload['text'])).toContain(d.phone);
    const wa = (contactMsg.payload['reply_markup'] as { inline_keyboard: Array<Array<{ url?: string }>> }).inline_keyboard[0]![0]!;
    expect(wa.url).toBe(`https://wa.me/${d.phone.replace('+', '')}`);

    await press(`tb:${trip.id}`);
    await press('n:2');
    expect(sent().at(-1)).toContain('1000 × 2 = 2000');
    await press('ok');
    const booking = await testPrisma.booking.findFirstOrThrow({ where: { passengerId: u.id } });
    expect(booking).toMatchObject({ tripId: trip.id, seatsCount: 2, status: 'pending' });
  });

  it('switches mode and the menu follows', async () => {
    const u = await linkedUser('passenger');
    await text('🔄 Я пассажир');
    expect((await testPrisma.user.findUniqueOrThrow({ where: { id: u.id } })).preferredMode).toBe('driver');
    const menu = [...calls].reverse().find((c) => c.method === 'sendMessage')!.payload['reply_markup'] as {
      keyboard: Array<Array<{ text: string }>>;
    };
    expect(menu.keyboard.flat().map((b) => b.text)).toContain('➕ Опубликовать поездку');
  });

  it('airport: a passenger picks «Манас» and gets transfer search', async () => {
    await linkedUser('passenger');
    const manas = await testPrisma.city.findUniqueOrThrow({ where: { soateCode: 'airport:FRU' } });
    await text('✈️ Аэропорт');
    await press('ad:to');
    await press(`ap:${manas.id}`);
    expect(lastButtons().some((b) => b.startsWith('d:'))).toBe(true);
    await press('d:any');
    expect(sent().at(-1)).toMatch(/Пока ничего нет|Оставьте заявку/);
  });
  it('«Назад» returns to the previous step and forgets its answer', async () => {
    await linkedUser('passenger');
    await text('🙋 Нужна поездка');
    await press(`pl:${CITY['Бишкек']}`);
    await press(`pl:${CITY['Каракол']}`);
    expect(lastButtons()).toContain('bk');
    await press('bk');
    expect(await draft()).toMatchObject({ step: 'to', from: CITY['Бишкек'] });
    expect((await draft())['to']).toBeUndefined();
    expect(sent().at(-1)).toContain('Куда?');
  });

  it('rejects the same place as origin and destination', async () => {
    await linkedUser('passenger');
    await text('🔍 Найти поездку');
    await press(`pl:${CITY['Бишкек']}`);
    await press(`pl:${CITY['Бишкек']}`);
    expect(sent().at(-1)).toContain('совпадают');
    expect(await draft()).toMatchObject({ step: 'to' });
  });

  it('accepts a typed date and refuses a departure time that has passed', async () => {
    await linkedUser('driver');
    await text('➕ Опубликовать поездку');
    await press(`pl:${CITY['Бишкек']}`);
    await press(`pl:${CITY['Нарын']}`);
    await text('завтра?');
    expect(sent().at(-1)).toContain('ДД.ММ');
    await text(ddmm(0));
    expect(await draft()).toMatchObject({ step: 'time' });
    await text('00:00');
    expect(sent().at(-1)).toContain('30 минут');
    expect((await draft())['time']).toBeUndefined();
  });

  it('a stale button answers with a toast instead of silence', async () => {
    await linkedUser('passenger');
    await press('n:2');
    expect(toasts().at(-1)).toContain('устарела');
  });

  it('«Мои»: sections, cancel asks for confirmation first', async () => {
    const u = await linkedUser('passenger');
    const d = await createVerifiedDriver(testPrisma, { plate: 'BOTD3' });
    const trip = await createTrip(testPrisma, d.id);
    const booking = await createBooking(testPrisma, u.id, trip.id);
    await text('📋 Мои');
    expect(lastButtons()).toEqual(['my:b']);
    await press('my:b');
    expect(lastButtons()).toContain(`cb:${booking.id}`);
    await press(`cb:${booking.id}`);
    expect(lastButtons()).toEqual([`yb:${booking.id}`, 'no']);
    expect((await testPrisma.booking.findUniqueOrThrow({ where: { id: booking.id } })).status).toBe('pending');
    await press(`yb:${booking.id}`);
    expect((await testPrisma.booking.findUniqueOrThrow({ where: { id: booking.id } })).status).toBe('cancelled_by_passenger');
  });

  it('driver accepts a booking from the notification and gets the passenger contact', async () => {
    const driver = await linkedUser('driver');
    const p = await createUser(testPrisma, { phone: '+996700555333' });
    const trip = await createTrip(testPrisma, driver.id);
    const booking = await createBooking(testPrisma, p.id, trip.id);
    await press(`accept_booking_${booking.id}`);
    expect((await testPrisma.booking.findUniqueOrThrow({ where: { id: booking.id } })).status).toBe('accepted');
    expect(sent().at(-1)).toContain('+996700555333');
  });

  it('driver offers a ride on a passenger request', async () => {
    const driver = await linkedUser('driver');
    const p = await createUser(testPrisma);
    const req = await createPassengerRequestsService(testPrisma).create(p.id, {
      originCityId: CITY['Бишкек'],
      destinationCityId: CITY['Ош'],
      seatsNeeded: 1,
      departureDate: new Date(Date.now() + 48 * 60 * 60_000).toISOString(),
      flexible: false,
    });
    await press(`ro:${req.id}`);
    const hint = lastButtons().find((b) => b.startsWith('t:'))!;
    await press(hint);
    await text('1500');
    await press('sk');
    expect(sent().at(-1)).toContain('1500');
    await press('ok');
    const resp = await testPrisma.passengerRequestResponse.findFirstOrThrow({ where: { requestId: req.id } });
    expect(resp).toMatchObject({ driverId: driver.id, price: 1500, status: 'pending' });
  });

  it('settings switch the language in place and resend the menu', async () => {
    const u = await linkedUser('passenger');
    await text('⚙️ Настройки');
    await press('lang');
    expect((await testPrisma.user.findUniqueOrThrow({ where: { id: u.id } })).language).toBe('kg');
    expect(calls.some((c) => c.method === 'editMessageText' && String(c.payload['text']).includes('Кыргызча'))).toBe(true);
    const menu = [...calls].reverse().find((c) => c.method === 'sendMessage')!.payload['reply_markup'] as {
      keyboard: Array<Array<{ text: string }>>;
    };
    expect(menu.keyboard.flat().map((b) => b.text)).toContain('🔍 Сапар табуу');
  });

  it('ignores group chats', async () => {
    await linkedUser('passenger');
    await bot.handleUpdate({
      update_id: updateId++,
      message: { message_id: 5, date: 0, chat: { id: -100, type: 'group', title: 'g' }, from, text: '/start' },
    } as Update);
    expect(sent()).toHaveLength(0);
  });
});

describe('bot flood guard', () => {
  it('drops updates past 30/min per user with one friendly notice', async () => {
    env.RATE_LIMIT_DISABLED = false;
    try {
      for (let i = 0; i < 30; i += 1) await text('/help');
      const before = sent().length;
      await text('/help');
      await text('/help');
      const after = sent().slice(before);
      expect(after).toEqual([TEXTS.ru.tooFast]);
    } finally {
      env.RATE_LIMIT_DISABLED = true;
    }
  });
});
