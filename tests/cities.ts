// Settlement ids of the real directory (loaded by migrations, filled in
// tests/setup.ts beforeAll): CITY['Бишкек'], CITY['Ош'], … An unknown name
// throws so a typo fails loudly instead of inserting a bad FK.
export const CITY_IDS: Record<string, number> = {};

export type TestCity =
  | 'Бишкек'
  | 'Ош'
  | 'Каракол'
  | 'Нарын'
  | 'Баткен'
  | 'Токмок'
  | 'Талас'
  | 'Кара-Балта'
  | 'Чолпон-Ата'
  | 'Манас'
  | 'Кант'
  | 'Узген';

export const CITY = new Proxy(CITY_IDS, {
  get(target, name: string) {
    const id = target[name];
    if (id === undefined) throw new Error(`test city not in directory: ${name}`);
    return id;
  },
}) as Readonly<Record<TestCity, number>>;
