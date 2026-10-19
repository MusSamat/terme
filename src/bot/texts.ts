// Every user-facing bot string lives in texts.ru.ts / texts.kg.ts (same keys).
import { ru, type Texts } from './texts.ru.js';
import { kg } from './texts.kg.js';

export type Lang = 'ru' | 'kg';
export type { Texts };

export const TEXTS: Record<Lang, Texts> = { ru, kg };

export const langOf = (code: string | null | undefined): Lang => (code === 'kg' || code === 'ky' ? 'kg' : 'ru');

// Reply-keyboard labels from earlier bot versions — Telegram keeps an old
// persistent keyboard on screen until we send a new one, so they must still work.
export const LEGACY_MENU: Record<string, string> = {
  '🔄 Я пассажир': 'mode',
  '🔄 Я водитель': 'mode',
  '🔄 Мен жүргүнчүмүн': 'mode',
  '🔄 Мен айдоочумун': 'mode',
  '📋 Меникилер': 'my',
};
