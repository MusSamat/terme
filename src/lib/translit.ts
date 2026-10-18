// Латиница → кириллица для поиска городов: пользователи набирают "jalal",
// "bishkek", "uzgen" в любой привычной транслитерации — приводим запрос к
// кириллице и сравниваем с name_ru / name_kg. Диграфы раньше одиночных букв.
const DIGRAPHS: Array<[string, string]> = [
  ['shch', 'щ'],
  ['dzh', 'ж'],
  ['sch', 'щ'],
  ['kh', 'х'],
  ['ts', 'ц'],
  ['ch', 'ч'],
  ['sh', 'ш'],
  ['zh', 'ж'],
  ['yo', 'е'],
  ['yu', 'ю'],
  ['ya', 'я'],
  ['ye', 'е'],
  ['dj', 'ж'],
];

const SINGLES: Record<string, string> = {
  a: 'а', b: 'б', c: 'к', d: 'д', e: 'е', f: 'ф', g: 'г', h: 'х',
  i: 'и', j: 'ж', k: 'к', l: 'л', m: 'м', n: 'н', o: 'о', p: 'п',
  q: 'к', r: 'р', s: 'с', t: 'т', u: 'у', v: 'в', w: 'в', x: 'кс',
  y: 'ы', z: 'з',
};

export function latinToCyrillic(input: string): string {
  let s = input.toLowerCase();
  for (const [lat, cyr] of DIGRAPHS) s = s.split(lat).join(cyr);
  return s.replace(/[a-z]/g, (ch) => SINGLES[ch] ?? ch);
}

/**
 * Свести RU/KG-варианты букв к одному виду для сравнения (дж→ж, ё→е, ө→о,
 * ү→у, ң→н) — «озгон» находит «Өзгөн», «джалал» — «Жалал-Абад». В SQL то же
 * самое делает функция kg_fold() (миграция 20261018130000).
 */
export const CYR_FOLD_FROM = 'ёөүң';
export const CYR_FOLD_TO = 'еоун';

export function foldCyrillic(input: string): string {
  let s = input.toLowerCase().split('дж').join('ж');
  for (let i = 0; i < CYR_FOLD_FROM.length; i++) {
    s = s.split(CYR_FOLD_FROM[i]!).join(CYR_FOLD_TO[i]!);
  }
  return s;
}

// Английская раскладка на тех же клавишах (QWERTY → ЙЦУКЕН): пользователь
// забыл переключить язык и набрал «Бишкек» как «<birtr». Включая шифт-варианты
// пунктуации (<, >, :, ", {, }, ~).
const EN_LAYOUT: Record<string, string> = {
  q: 'й', w: 'ц', e: 'у', r: 'к', t: 'е', y: 'н', u: 'г', i: 'ш', o: 'щ', p: 'з',
  '[': 'х', ']': 'ъ', '{': 'х', '}': 'ъ',
  a: 'ф', s: 'ы', d: 'в', f: 'а', g: 'п', h: 'р', j: 'о', k: 'л', l: 'д',
  ';': 'ж', ':': 'ж', "'": 'э', '"': 'э',
  z: 'я', x: 'ч', c: 'с', v: 'м', b: 'и', n: 'т', m: 'ь',
  ',': 'б', '<': 'б', '.': 'ю', '>': 'ю', '`': 'ё', '~': 'ё',
};

export function layoutToCyrillic(input: string): string {
  return [...input.toLowerCase()].map((ch) => EN_LAYOUT[ch] ?? ch).join('');
}
