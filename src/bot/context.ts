import type { PrismaClient, User } from '@prisma/client';
import type { Context } from 'grammy';
import { AppError } from '@/lib/errors.js';
import { logger } from '@/lib/logger.js';
import { NoopNotifier, type Notifier } from '@/lib/notifier.js';
import { createTripsService } from '@/modules/trips/trips.service.js';
import { createBookingsService } from '@/modules/bookings/bookings.service.js';
import {
  createPassengerRequestResponsesService,
  createPassengerRequestsService,
} from '@/modules/passenger-requests/passenger-requests.service.js';
import { createContactsService } from '@/modules/contacts/contacts.service.js';
import { createCitiesService } from '@/modules/cities/cities.service.js';
import { createCarsService } from '@/modules/cars/cars.service.js';
import { createSessionStore, type SessionStore } from './session.js';
import { TEXTS, langOf, type Lang } from './texts.js';
import { contactKeyboard, mainMenu } from './format.js';

export interface BotDeps {
  prisma: PrismaClient;
  // Lazy: the notifier wraps the bot, so it is created after it.
  getNotifier: () => Notifier | null;
}

// The bot calls the same services as the HTTP API — one set of business rules.
export function createBotServices(deps: BotDeps) {
  const notifier = (): Notifier => deps.getNotifier() ?? new NoopNotifier();
  return {
    trips: () => createTripsService(deps.prisma, notifier()),
    bookings: () => createBookingsService(deps.prisma, notifier()),
    requests: createPassengerRequestsService(deps.prisma),
    responses: () => createPassengerRequestResponsesService(deps.prisma, notifier()),
    contacts: createContactsService(deps.prisma),
    cities: createCitiesService(deps.prisma),
    cars: createCarsService(deps.prisma),
    session: createSessionStore(deps.prisma) as SessionStore,
  };
}

export type BotServices = ReturnType<typeof createBotServices>;

export async function findUser(prisma: PrismaClient, ctx: Context): Promise<User | null> {
  if (!ctx.from) return null;
  return prisma.user.findFirst({ where: { telegramId: BigInt(ctx.from.id), deletedAt: null } });
}

export function userLang(user: User | null, ctx: Context): Lang {
  return user ? langOf(user.language) : langOf(ctx.from?.language_code);
}

export const isDriverMode = (user: User | null): boolean => user?.preferredMode === 'driver';

/** Resolves the linked account or asks the chat to share its contact. */
export async function requireUser(prisma: PrismaClient, ctx: Context): Promise<User | null> {
  const user = await findUser(prisma, ctx);
  if (user?.isBlocked) {
    await ctx.reply(TEXTS[userLang(user, ctx)].blocked);
    return null;
  }
  if (!user) {
    const lang = userLang(null, ctx);
    await ctx.reply(TEXTS[lang].needAccount, { reply_markup: contactKeyboard(lang) });
    return null;
  }
  return user;
}

export async function showMenu(ctx: Context, user: User, text?: string): Promise<void> {
  const lang = langOf(user.language);
  await ctx.reply(text ?? TEXTS[lang].chooseAction, {
    parse_mode: 'HTML',
    reply_markup: mainMenu(lang, isDriverMode(user)),
  });
}

/** Maps a service error to a short localized message (logs the unexpected ones). */
export function errorText(err: unknown, lang: Lang): string {
  const t = TEXTS[lang];
  if (err instanceof AppError) {
    const reason = typeof err.details?.['reason'] === 'string' ? (err.details['reason'] as string) : '';
    return t.errors[reason] ?? t.errors[err.code] ?? t.error;
  }
  logger.warn({ err }, 'bot action failed');
  return t.error;
}
