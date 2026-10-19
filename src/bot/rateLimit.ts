import type { Context, MiddlewareFn } from 'grammy';
import { env } from '@/config/env.js';
import { logger } from '@/lib/logger.js';
import { TEXTS, langOf } from './texts.js';

const BOT_LIMIT = 30;
const BOT_WINDOW_MS = 60_000;
const MAX_TRACKED = 10_000;

/**
 * Per-telegram_id flood guard for messages and button presses (30/min).
 * Over the limit the update is dropped; the user gets ONE friendly notice per
 * burst (a toast for buttons, a message otherwise). In-memory, per process.
 */
export function createBotRateLimiter(): MiddlewareFn<Context> {
  const hits = new Map<number, { times: number[]; warned: boolean }>();

  const prune = (now: number): void => {
    for (const [id, s] of hits) {
      if (!s.times.length || now - s.times[s.times.length - 1]! > BOT_WINDOW_MS) hits.delete(id);
    }
  };

  return async (ctx, next) => {
    const id = ctx.from?.id;
    if (!id || env.RATE_LIMIT_DISABLED) return next();
    const now = Date.now();
    if (hits.size > MAX_TRACKED) prune(now);
    const s = hits.get(id) ?? { times: [], warned: false };
    while (s.times.length && now - s.times[0]! > BOT_WINDOW_MS) s.times.shift();
    if (s.times.length >= BOT_LIMIT) {
      hits.set(id, s);
      const text = TEXTS[langOf(ctx.from?.language_code)].tooFast;
      if (s.warned) {
        if (ctx.callbackQuery) await ctx.answerCallbackQuery().catch(() => undefined);
        return;
      }
      s.warned = true;
      logger.warn({ event: 'abuse.limit_hit', telegramId: id, limiter: 'bot' }, 'abuse.limit_hit');
      if (ctx.callbackQuery) await ctx.answerCallbackQuery({ text }).catch(() => undefined);
      else await ctx.reply(text).catch(() => undefined);
      return;
    }
    s.times.push(now);
    s.warned = false;
    hits.set(id, s);
    await next();
  };
}
