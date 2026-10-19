// TZ §13.1 "Фильтр контента · Телефоны, адреса соцсетей → [скрыто]". Strips
// Kyrgyz-style international (+996…) and
// local bare-digit numbers from chat messages so drivers and passengers can't
// bypass the platform before mutual consent.
//
// We intentionally keep this moderately aggressive: false positives are
// acceptable (numbers rarely appear in legitimate text) and under-blocking
// would defeat the anti-bypass purpose.

const PATTERNS: RegExp[] = [
  // +996 XXX XXX XXX with assorted separators
  /\+?\s*9\s*9\s*6[\s\-()]*\d[\s\d\-()]{8,}/g,
  // 0XXX XXX XXX local format (leading 0 + 9 digits, 10 total)
  /(?:^|\D)0\s*\d{3}[\s-]*\d{3}[\s-]*\d{3}(?=$|\D)/g,
  // Plain runs of 9-12 digits not touching other digits — catches attempts like
  // "my number 700123456". Allow short numeric strings (years, codes) by
  // requiring ≥9 consecutive digits.
  /(?:^|\D)(?:\d[\s-]*){9,12}(?=$|\D)/g,
];

const REDACTED = '[скрыто]';

export function filterPhoneNumbers(text: string): { filtered: string; redacted: boolean } {
  let filtered = text;
  let redacted = false;
  for (const re of PATTERNS) {
    filtered = filtered.replace(re, (match) => {
      redacted = true;
      // Preserve any leading non-digit we captured (the (?:^|\D) part) so we
      // don't accidentally glue words together.
      const lead = /^(?:\D)/.exec(match);
      return `${lead?.[0] ?? ''}${REDACTED}`;
    });
  }
  return { filtered, redacted };
}
