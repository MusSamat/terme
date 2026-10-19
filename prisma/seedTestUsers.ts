/**
 * Test-load seed — marked users («<Имя>Test», e.g. AlmazTest) with cars,
 * verified driver profiles, trips and ride-requests, so a deployed test server
 * (or a local DB) has a realistically busy feed / map / airport tab.
 *
 * Default (no --target): 20 users, each a driver+passenger, 7 KG-days,
 *   10 trips + 10 requests per user-day → ≈1400 trips + 1400 requests.
 * --target N: ≈N listings (50% trips / 50% requests) over --days (default 30)
 *   by max(20, N/10) users (--users overrides); ~40% of them drive.
 *
 * Mix: weighted popular intercity pairs, random city↔city, village↔nearest
 * city (real SOATE places, active, with coordinates), ~8% airport transfers
 * (only ACTIVE airports — Манас / Ош), ~45% with a meeting-point pin, departures
 * now+1h … +days (KG daytime-heavy), price ≈ 3–4.5 сом/км, ~5% trips with
 * accepted bookings, ~3% requests with driver offers.
 *
 * DB rules this respects:
 *   • idx_trips_route_day_unique   — 1 active trip  per (driver, route, KG-day)
 *   • idx_requests_route_day_unique — 1 open request per (passenger, route, KG-day)
 *   (deduped in memory; airport trips are deduped too, stricter than needed)
 *   • seats_available = seats_total − accepted booking seats, seats ≤ car seats
 *   • luggage_count 0–5, kind derived from an airport endpoint, name snapshots
 *
 * Safe on a DEPLOYED server: unlike seedDemo it does NOT refuse on
 * NODE_ENV=production — the test server runs as production — but it REQUIRES an
 * explicit confirmation flag so it can never fire by accident, and every user it
 * writes is tagged (phone block +9967009xxxxx — the old +99670090xxxx block is
 * its first 10 000 numbers — and name suffix «Test») so --purge removes exactly
 * this data and nothing else.
 *
 *   Seed:  npm run db:seed:test -- --yes [--target 20000] [--users N] [--days N]
 *   Purge: npm run db:seed:test -- --purge --yes
 */

process.loadEnvFile?.('.env');

import { randomUUID } from 'node:crypto';
import { PrismaClient, Prisma } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { estimateDurationMin, lookupRoute } from '../src/lib/routes.js';
import { haversineKm } from '../src/lib/places.js';

const prisma = new PrismaClient();

// ─── Config ────────────────────────────────────────────────────────────
const PHONE_PREFIX = '+9967009'; // +996 7009 NNNNN — reserved test block
const PHONE_DIGITS = 5;
const NAME_SUFFIX = 'Test';
const KG_OFFSET_MS = 6 * 60 * 60_000; // UTC+6, no DST
const DAY_MS = 24 * 60 * 60_000;
const BATCH = 1000;

// First 20 keep their order — they are the original test users.
const FIRST_NAMES = [
  'Almaz', 'Nurlan', 'Aziz', 'Bakyt', 'Ermek',
  'Timur', 'Ulan', 'Adil', 'Ruslan', 'Kanat',
  'Aibek', 'Daniyar', 'Emil', 'Marat', 'Sanjar',
  'Talant', 'Bekzat', 'Chyngyz', 'Iskender', 'Maksat',
  'Aigul', 'Aizada', 'Aidana', 'Begimai', 'Cholpon', 'Gulnara', 'Jyldyz', 'Kanykei',
  'Meerim', 'Nazgul', 'Nurzhan', 'Asel', 'Elnura', 'Altynai', 'Saikal', 'Tolkun',
  'Azamat', 'Bolot', 'Dastan', 'Erlan', 'Kubanych', 'Mirlan', 'Nurbek', 'Samat',
  'Tilek', 'Zhanybek', 'Aleksei', 'Dmitrii', 'Sergei', 'Andrei', 'Ivan', 'Pavel',
  'Olga', 'Elena', 'Natalia', 'Irina', 'Svetlana', 'Anna', 'Tatiana', 'Viktor',
];

const LUGGAGE: Array<'yes' | 'small' | 'no'> = ['yes', 'small', 'no'];
const KG_BOUNDS = { latMin: 39, latMax: 43.5, lngMin: 69, lngMax: 81 };

// [a, b, weight] by directory name_ru (capital / city / town); direction random.
const POPULAR: Array<[string, string, number]> = [
  ['Бишкек', 'Ош', 14], ['Бишкек', 'Каракол', 9], ['Бишкек', 'Чолпон-Ата', 8],
  ['Бишкек', 'Манас', 7], ['Бишкек', 'Токмок', 7], ['Бишкек', 'Нарын', 6],
  ['Бишкек', 'Талас', 6], ['Бишкек', 'Кара-Балта', 6], ['Ош', 'Манас', 6],
  ['Бишкек', 'Кант', 5], ['Бишкек', 'Балыкчы', 5], ['Ош', 'Узген', 4],
  ['Ош', 'Кара-Суу', 4], ['Бишкек', 'Баткен', 3], ['Ош', 'Баткен', 3],
  ['Каракол', 'Чолпон-Ата', 3], ['Ош', 'Кызыл-Кия', 3], ['Ош', 'Ноокат', 2],
  ['Бишкек', 'Токтогул', 2], ['Манас', 'Таш-Кумыр', 2], ['Бишкек', 'Кемин', 2],
  ['Бишкек', 'Каинды', 2], ['Бишкек', 'Кербен', 1], ['Манас', 'Базар-Коргон', 2],
];

// Non-airport ends of transfers, by airport soate code.
const AIRPORT_ENDS: Record<string, Array<[string, number]>> = {
  'airport:FRU': [
    ['41711000000000', 8], ['41711201000000', 1], ['41711202000000', 1],
    ['41711203000000', 1], ['41711204000000', 1], ['41708410000010', 2],
    ['41708400000010', 2], ['41708420000010', 2],
  ],
  'airport:OSS': [
    ['41721000000000', 6], ['41703410000010', 3], ['41706255600010', 2],
    ['41706226600010', 2], ['41706242600010', 1],
  ],
};

const AIRLINES = ['SU', 'TK', 'FZ', 'KC', 'S7', 'U6', 'QH', 'ZM', 'HY', 'DV', 'PC'];
const KG_HOUR_WEIGHTS: Array<[number, number]> = [
  [5, 3], [6, 6], [7, 8], [8, 8], [9, 7], [10, 6], [11, 5], [12, 5], [13, 5],
  [14, 6], [15, 6], [16, 6], [17, 6], [18, 5], [19, 4], [20, 3], [21, 2], [22, 1],
];
const ADDRESS_NOTES = [
  'у остановки', 'возле рынка', 'у заправки', 'напротив школы', 'у мечети',
  'центральная площадь', 'у автовокзала', 'возле аптеки', 'у магазина', 'у моста',
];
const BISHKEK_NOTES = [
  'Западный автовокзал', 'Ошский базар', 'ЦУМ', 'Аламединский рынок', 'Южные ворота',
  'Дордой', 'Восточный автовокзал', 'Филармония',
];
const TRIP_COMMENTS = [
  'Багажник свободен', 'Могу забрать по пути', 'Кондиционер, комфортная поездка',
  'Без курения', 'Выезжаю по заполнению', 'Есть детское кресло', 'Звоните заранее',
];
const REQUEST_COMMENTS = [
  'Нужно доехать, гибок по времени.', 'Еду с ребёнком', 'Есть небольшая сумка',
  'Могу выехать пораньше', 'Ищу попутку, оплата на месте', 'Двое взрослых',
];
const SEATS_BY_BODY: Record<string, number> = {
  sedan: 4, hatchback: 4, suv: 4, pickup: 4, mpv: 6, van: 7,
};

// ─── Helpers ───────────────────────────────────────────────────────────
const phoneFor = (i: number) => `${PHONE_PREFIX}${String(i).padStart(PHONE_DIGITS, '0')}`;
const plateFor = (i: number) => `01KGT${String(i).padStart(3, '0')}`;
const rand = (a: number, b: number) => a + Math.random() * (b - a);
const randInt = (a: number, b: number) => Math.floor(rand(a, b + 1));
const chance = (p: number) => Math.random() < p;
const pick = <T>(xs: readonly T[]): T => xs[Math.floor(Math.random() * xs.length)]!;
function pickWeighted<T>(xs: ReadonlyArray<readonly [T, number]>): T {
  let r = Math.random() * xs.reduce((s, x) => s + x[1], 0);
  for (const [v, w] of xs) if ((r -= w) < 0) return v;
  return xs[xs.length - 1]![0];
}
const kgDayKey = (d: Date) => Math.floor((d.getTime() + KG_OFFSET_MS) / DAY_MS);

/**
 * Instant that reads as KG hour `h`:`minute` on KG-day (today + dayOffset). KG
 * date is derived from now+6h; UTC hour = h-6 (Date.UTC handles the day
 * rollover, and `AT TIME ZONE 'Asia/Bishkek'` reverses it to the KG date).
 */
function kgDeparture(dayOffset: number, kgHour: number, minute = 0): Date {
  const kgNow = new Date(Date.now() + KG_OFFSET_MS);
  return new Date(
    Date.UTC(
      kgNow.getUTCFullYear(),
      kgNow.getUTCMonth(),
      kgNow.getUTCDate() + dayOffset,
      kgHour - 6,
      minute,
      0,
    ),
  );
}

/** Daytime-heavy KG departure ≥ now+1h on a day in [0, days). */
function randomDeparture(days: number): Date {
  const minAt = Date.now() + 60 * 60_000;
  for (;;) {
    const minute = chance(0.7) ? 15 * randInt(0, 3) : 5 * randInt(0, 11);
    const at = kgDeparture(randInt(0, days - 1), pickWeighted(KG_HOUR_WEIGHTS), minute);
    if (at.getTime() >= minAt) return at;
  }
}

async function chunkedCreateMany<T>(
  rows: T[],
  create: (batch: T[]) => Promise<unknown>,
  size = BATCH,
): Promise<number> {
  for (let i = 0; i < rows.length; i += size) {
    await create(rows.slice(i, i + size));
  }
  return rows.length;
}

interface Place {
  id: number;
  type: string;
  nameRu: string;
  lat: number;
  lng: number;
}
interface Area { id: number; cityId: number; lat: number; lng: number }
interface Route { o: Place; d: Place; kind: 'intercity' | 'airport' }
interface Point { lat: number; lng: number; address: string; areaId: number | null }

async function loadPlaces(): Promise<{
  hubs: Map<string, Place>;
  hubList: Place[];
  villages: Place[];
  bySoate: Map<string, Place>;
  areas: Area[];
}> {
  const rows = await prisma.city.findMany({
    where: {
      isActive: true,
      lat: { not: null },
      lng: { not: null },
      OR: [
        { type: { in: ['capital', 'city', 'town', 'village'] }, isSearchable: true },
        { type: { in: ['airport', 'city_district'] } },
      ],
    },
    select: { id: true, type: true, nameRu: true, lat: true, lng: true, soateCode: true },
  });
  const all = rows.map((r) => ({ ...r, lat: r.lat!, lng: r.lng! }));
  const hubList = all.filter((p) => ['capital', 'city', 'town'].includes(p.type));
  const areas = await prisma.cityArea.findMany({ select: { id: true, cityId: true, lat: true, lng: true } });
  return {
    hubs: new Map(hubList.map((p) => [p.nameRu, p])),
    hubList,
    villages: all.filter((p) => p.type === 'village'),
    bySoate: new Map(all.map((p) => [p.soateCode, p])),
    areas,
  };
}

function makeRoutePicker(places: Awaited<ReturnType<typeof loadPlaces>>): () => Route {
  const hub = (name: string) => {
    const p = places.hubs.get(name);
    if (!p) throw new Error(`seed place not in directory: ${name}`);
    return p;
  };
  const popular = POPULAR.map(([a, b, w]) => [[hub(a), hub(b)] as const, w] as const);
  const airports = Object.entries(AIRPORT_ENDS)
    .map(([code, ends]) => ({
      airport: places.bySoate.get(code),
      ends: ends
        .map(([c, w]) => [places.bySoate.get(c), w] as const)
        .filter((e): e is readonly [Place, number] => e[0] !== undefined),
    }))
    .filter((a): a is { airport: Place; ends: Array<readonly [Place, number]> } =>
      a.airport !== undefined && a.ends.length > 0);
  const capitals = places.hubList.filter((p) => p.type === 'capital');
  const nearestHub = (v: Place) =>
    places.hubList.reduce((best, h) => (haversineKm(v, h) < haversineKm(v, best) ? h : best));
  const flip = (a: Place, b: Place, kind: Route['kind']): Route =>
    chance(0.5) ? { o: a, d: b, kind } : { o: b, d: a, kind };

  return () => {
    const r = Math.random();
    if (r < 0.08 && airports.length > 0) {
      const a = pick(airports);
      return flip(a.airport, pickWeighted(a.ends), 'airport');
    }
    if (r < 0.66) {
      const [a, b] = pickWeighted(popular);
      return flip(a, b, 'intercity');
    }
    if (r < 0.8) {
      const a = pick(places.hubList);
      let b = pick(places.hubList);
      while (b.id === a.id) b = pick(places.hubList);
      return flip(a, b, 'intercity');
    }
    const v = pick(places.villages);
    const near = nearestHub(v);
    const b = chance(0.3) || haversineKm(v, near) < 5
      ? capitals.reduce((x, c) => (haversineKm(v, c) < haversineKm(v, x) ? c : x))
      : near;
    return flip(v, b, 'intercity');
  };
}

/** Pin 0.3–4 km around the place, inside KG; area label like nearestAreaId. */
function jitterPoint(p: Place, areas: Area[]): Point | null {
  for (let i = 0; i < 5; i++) {
    const km = rand(0.3, 4);
    const t = rand(0, 2 * Math.PI);
    const lat = p.lat + (km * Math.cos(t)) / 111;
    const lng = p.lng + (km * Math.sin(t)) / (111 * Math.cos((p.lat * Math.PI) / 180));
    if (lat < KG_BOUNDS.latMin || lat > KG_BOUNDS.latMax || lng < KG_BOUNDS.lngMin || lng > KG_BOUNDS.lngMax) continue;
    const pt = { lat: Math.round(lat * 1e6) / 1e6, lng: Math.round(lng * 1e6) / 1e6 };
    let areaId: number | null = null;
    let bestKm = 1.5;
    for (const a of areas) {
      if (a.cityId !== p.id) continue;
      const d = haversineKm(pt, a);
      if (d <= bestKm) { bestKm = d; areaId = a.id; }
    }
    const address = p.nameRu === 'Бишкек' && chance(0.6) ? pick(BISHKEK_NOTES) : pick(ADDRESS_NOTES);
    return { ...pt, address, areaId };
  }
  return null;
}

function pointColumns(side: 'origin' | 'destination', p: Point | null) {
  return {
    [`${side}Lat`]: p?.lat ?? null,
    [`${side}Lng`]: p?.lng ?? null,
    [`${side}Address`]: p?.address ?? null,
    [`${side}AreaId`]: p?.areaId ?? null,
  };
}

function priceFor(route: Route): number {
  const km = lookupRoute(route.o.nameRu, route.d.nameRu)?.distanceKm ?? haversineKm(route.o, route.d) * 1.4;
  const raw = route.kind === 'airport' ? Math.max(300, km * rand(12, 18)) : Math.max(100, km * rand(3, 4.5));
  return Math.min(10_000, Math.max(50, Math.round(raw / 50) * 50));
}

function parseArgs(args: string[]): { users?: number; days?: number; target?: number } {
  const num = (flag: string): number | undefined => {
    const i = args.indexOf(flag);
    if (i < 0) return undefined;
    const n = Number(args[i + 1]);
    if (!Number.isInteger(n) || n <= 0) throw new Error(`${flag} needs a positive integer`);
    return n;
  };
  return { users: num('--users'), days: num('--days'), target: num('--target') };
}

// ─── Seed ──────────────────────────────────────────────────────────────
async function seed(opts: { users?: number; days?: number; target?: number }): Promise<void> {
  const marker = await prisma.user.findUnique({ where: { phone: phoneFor(1) } });
  if (marker) {
    console.warn('[test-seed] marker user already exists — data looks seeded. Skipping.');
    console.warn('[test-seed] To re-seed: npm run db:seed:test -- --purge --yes  (then re-run).');
    return;
  }
  const started = Date.now();
  const days = opts.days ?? (opts.target ? 30 : 7);
  const nUsers = opts.users ?? (opts.target ? Math.max(20, Math.ceil(opts.target / 10)) : 20);
  if (nUsers >= 10 ** PHONE_DIGITS) throw new Error(`--users must be < ${10 ** PHONE_DIGITS}`);
  const perType = opts.target ? Math.ceil(opts.target / 2) : nUsers * days * 10;
  const driverShare = opts.target ? 0.4 : 1;

  const passwordHash = await bcrypt.hash('TestPass12', 4);
  const now = new Date();
  const places = await loadPlaces();
  const nextRoute = makeRoutePicker(places);
  const models = await prisma.carModel.findMany({
    where: { isActive: true, brand: { isActive: true }, bodyType: { in: Object.keys(SEATS_BY_BODY) } },
    select: { name: true, bodyType: true, brand: { select: { name: true } } },
  });
  const colors = (await prisma.carColor.findMany({ where: { isActive: true }, select: { nameRu: true } }))
    .map((c) => c.nameRu);
  if (models.length === 0) throw new Error('car catalog is empty — run the catalog seed/migrations first');

  // 1) Users; drivers also get a car + verified driver profile.
  const users: Prisma.UserCreateManyInput[] = [];
  const profiles: Prisma.DriverProfileCreateManyInput[] = [];
  const cars: Prisma.CarCreateManyInput[] = [];
  const drivers: Array<{ id: string; carId: string; seats: number }> = [];
  for (let i = 1; i <= nUsers; i++) {
    const id = randomUUID();
    const isDriver = i <= 20 || chance(driverShare);
    const rated = chance(0.8);
    users.push({
      id,
      phone: phoneFor(i),
      name: `${FIRST_NAMES[(i - 1) % FIRST_NAMES.length]}${NAME_SUFFIX}`,
      language: chance(0.8) ? 'ru' : 'kg',
      roles: isDriver ? ['passenger', 'driver'] : ['passenger'],
      preferredMode: isDriver ? 'driver' : 'passenger',
      rating: rated ? new Prisma.Decimal(rand(4.2, 5).toFixed(2)) : new Prisma.Decimal(0),
      ratingCount: rated ? randInt(3, 80) : 0,
      phoneVerifiedAt: now,
      passwordHash,
      lastPasswordChangedAt: now,
      termsAcceptedAt: now,
    });
    if (!isDriver) continue;
    const m = pick(models);
    const seats = SEATS_BY_BODY[m.bodyType ?? 'sedan'] ?? 4;
    const color = pick(colors.length > 0 ? colors : ['Белый']);
    const year = randInt(2005, 2023);
    const carId = randomUUID();
    cars.push({ id: carId, userId: id, make: m.brand.name, model: m.name, color, year, plate: plateFor(i), seatsCount: seats });
    profiles.push({
      userId: id,
      carMake: m.brand.name,
      carModel: m.name,
      carYear: year,
      carColor: color,
      carPlate: plateFor(i),
      seatsCount: seats,
      licensePhotoPath: `seed/test${i}/license.jpg`,
      carPassportPath: `seed/test${i}/passport.jpg`,
      carPhotoPath: `seed/test${i}/car.jpg`,
      selfiePath: `seed/test${i}/selfie.jpg`,
      verificationStatus: 'verified',
      verifiedAt: now,
      totalTrips: randInt(0, 120),
    });
    drivers.push({ id, carId, seats });
  }
  await chunkedCreateMany(users, (b) => prisma.user.createMany({ data: b }));
  await chunkedCreateMany(cars, (b) => prisma.car.createMany({ data: b }));
  await chunkedCreateMany(profiles, (b) => prisma.driverProfile.createMany({ data: b }));
  console.warn(`[test-seed] ${users.length} users (${drivers.length} drivers + cars + profiles) created`);

  // 2) Trips (drivers only) + requests (everyone), deduped per (user, route, KG-day).
  const trips: Prisma.TripCreateManyInput[] = [];
  const requests: Prisma.PassengerRequestCreateManyInput[] = [];
  const seen = new Set<string>();
  const routeKey = (prefix: string, userId: string, r: Route, at: Date) =>
    `${prefix}|${userId}|${r.o.id}|${r.d.id}|${kgDayKey(at)}`;
  let pins = 0;

  while (trips.length < perType) {
    const drv = pick(drivers);
    const route = nextRoute();
    const at = randomDeparture(days);
    const key = routeKey('t', drv.id, route, at);
    if (seen.has(key)) continue;
    seen.add(key);
    const op = chance(0.45) ? jitterPoint(route.o, places.areas) : null;
    const dp = chance(0.2) ? jitterPoint(route.d, places.areas) : null;
    if (op) pins++;
    const seatsTotal = Math.max(1, drv.seats - (chance(0.3) ? randInt(1, 2) : 0));
    trips.push({
      id: randomUUID(),
      driverId: drv.id,
      carId: drv.carId,
      kind: route.kind,
      originCityId: route.o.id,
      destinationCityId: route.d.id,
      originCity: route.o.nameRu,
      destinationCity: route.d.nameRu,
      ...pointColumns('origin', op),
      ...pointColumns('destination', dp),
      departureAt: at,
      departureFlexible: chance(0.15),
      departureWindowEnd: chance(0.1) ? new Date(at.getTime() + randInt(2, 4) * 60 * 60_000) : null,
      estimatedDurationMin: estimateDurationMin(route.o, route.d),
      seatsTotal,
      seatsAvailable: seatsTotal,
      pricePerSeat: priceFor(route),
      priceNegotiable: chance(0.2),
      luggage: pick(LUGGAGE),
      preferences: {
        clean: true, music: chance(0.6), smoking: chance(0.1), ac: chance(0.7),
        animals: chance(0.2), quiet: chance(0.3), chat: chance(0.5), women_only: chance(0.03),
      } as Prisma.InputJsonValue,
      comment: chance(0.25) ? pick(TRIP_COMMENTS) : null,
      status: 'active',
    });
  }

  while (requests.length < perType) {
    const u = pick(users);
    const route = nextRoute();
    const at = randomDeparture(days);
    const key = routeKey('r', u.id!, route, at);
    if (seen.has(key)) continue;
    seen.add(key);
    const op = chance(0.45) ? jitterPoint(route.o, places.areas) : null;
    const dp = chance(0.2) ? jitterPoint(route.d, places.areas) : null;
    if (op) pins++;
    const airport = route.kind === 'airport';
    requests.push({
      id: randomUUID(),
      passengerId: u.id!,
      kind: route.kind,
      flightNumber: airport && chance(0.7) ? `${pick(AIRLINES)} ${randInt(100, 9999)}` : null,
      ...(airport
        ? { meetWithSign: route.o.type === 'airport' && chance(0.5), luggageCount: chance(0.8) ? randInt(0, 5) : null }
        : {}),
      originCityId: route.o.id,
      destinationCityId: route.d.id,
      originCity: route.o.nameRu,
      destinationCity: route.d.nameRu,
      ...pointColumns('origin', op),
      ...pointColumns('destination', dp),
      seatsNeeded: pickWeighted([[1, 6], [2, 3], [3, 1]] as const),
      departureDate: at,
      flexible: chance(0.4),
      comment: chance(0.3) ? pick(REQUEST_COMMENTS) : null,
      status: 'open',
    });
  }

  // 3) ~5% trips: 1–2 accepted bookings (seats_available kept consistent);
  //    ~3% requests: 1–2 pending driver offers.
  const bookings: Prisma.BookingCreateManyInput[] = [];
  for (const t of trips) {
    if (!chance(0.05)) continue;
    const taken = new Set([t.driverId]);
    for (let k = randInt(1, 2); k > 0 && t.seatsAvailable > 0; k--) {
      const p = pick(users);
      if (taken.has(p.id!)) continue;
      taken.add(p.id!);
      const seatsCount = Math.min(t.seatsAvailable, randInt(1, 2));
      t.seatsAvailable -= seatsCount;
      bookings.push({ tripId: t.id!, passengerId: p.id!, seatsCount, pricePerSeatSnapshot: t.pricePerSeat, status: 'accepted' });
    }
  }
  const responses: Prisma.PassengerRequestResponseCreateManyInput[] = [];
  for (const r of requests) {
    if (!chance(0.03)) continue;
    const taken = new Set([r.passengerId]);
    for (let k = randInt(1, 2); k > 0; k--) {
      const d = pick(drivers);
      if (taken.has(d.id)) continue;
      taken.add(d.id);
      const at = new Date((r.departureDate as Date).getTime() + randInt(0, 4) * 15 * 60_000);
      responses.push({
        requestId: r.id!,
        driverId: d.id,
        price: Math.max(100, Math.round(rand(300, 2500) / 50) * 50),
        departureTime: at,
        message: chance(0.5) ? 'Могу забрать, есть место' : null,
        expiresAt: new Date(now.getTime() + 48 * 60 * 60_000),
      });
    }
  }

  const nTrips = await chunkedCreateMany(trips, (b) => prisma.trip.createMany({ data: b }));
  console.warn(`[test-seed] ${nTrips} trips created`);
  const nReq = await chunkedCreateMany(requests, (b) => prisma.passengerRequest.createMany({ data: b }));
  console.warn(`[test-seed] ${nReq} requests created`);
  await chunkedCreateMany(bookings, (b) => prisma.booking.createMany({ data: b }));
  await chunkedCreateMany(responses, (b) => prisma.passengerRequestResponse.createMany({ data: b }));

  const airportT = trips.filter((t) => t.kind === 'airport').length;
  const airportR = requests.filter((r) => r.kind === 'airport').length;
  console.warn('\n[test-seed] ✓ Done.');
  console.warn(`[test-seed] users ${users.length} (drivers ${drivers.length}), days ${days}`);
  console.warn(`[test-seed] trips ${nTrips} (airport ${airportT}), requests ${nReq} (airport ${airportR})`);
  console.warn(`[test-seed] with origin pin ${((100 * pins) / (nTrips + nReq)).toFixed(1)}%, bookings ${bookings.length}, offers ${responses.length}`);
  console.warn(`[test-seed] took ${((Date.now() - started) / 1000).toFixed(1)}s`);
  console.warn(`[test-seed] Users: ${phoneFor(1)} .. ${phoneFor(nUsers)} (password: TestPass12)`);
  console.warn('[test-seed] Mint a token: npm run dev:token -- <phone>');
}

// ─── Purge (removes exactly the tagged test block) ──────────────────────
async function chunked(ids: string[], fn: (part: string[]) => Promise<unknown>, size = 5000): Promise<void> {
  for (let i = 0; i < ids.length; i += size) await fn(ids.slice(i, i + size));
}

async function purge(): Promise<void> {
  const users = await prisma.user.findMany({
    where: { phone: { startsWith: PHONE_PREFIX }, name: { endsWith: NAME_SUFFIX } },
    select: { id: true, phone: true },
  });
  const userIds = users
    .filter((u) => u.phone.length === PHONE_PREFIX.length + PHONE_DIGITS)
    .map((u) => u.id);
  if (userIds.length === 0) {
    console.warn('[test-seed] no test users found — nothing to purge.');
    return;
  }
  const [trips, reqs] = await Promise.all([
    prisma.trip.findMany({ where: { driverId: { in: userIds } }, select: { id: true } }),
    prisma.passengerRequest.findMany({ where: { passengerId: { in: userIds } }, select: { id: true } }),
  ]);
  const tripIds = trips.map((t) => t.id);
  const reqIds = reqs.map((r) => r.id);
  const listingIds = [...tripIds, ...reqIds];

  // FK-safe order. User delete cascades driver_profiles / cars / refresh_tokens /
  // listing_likes / notifications / loyalty; everything below is NOT cascaded.
  await chunked(userIds, (part) => prisma.message.deleteMany({ where: { senderId: { in: part } } }));
  await chunked(userIds, (part) =>
    prisma.booking.deleteMany({
      where: { OR: [{ trip: { driverId: { in: part } } }, { passengerId: { in: part } }] },
    }),
  ); // messages cascade from booking
  await chunked(userIds, (part) =>
    prisma.rating.deleteMany({ where: { OR: [{ raterId: { in: part } }, { rateeId: { in: part } }] } }),
  );
  await chunked(userIds, (part) =>
    prisma.passengerRequestResponse.deleteMany({
      where: { OR: [{ driverId: { in: part } }, { request: { passengerId: { in: part } } }] },
    }),
  );
  await chunked(userIds, (part) => prisma.complaint.deleteMany({ where: { reporterId: { in: part } } }));
  await chunked(userIds, (part) => prisma.contactReveal.deleteMany({ where: { viewerId: { in: part } } }));
  await chunked(listingIds, (part) => prisma.contactReveal.deleteMany({ where: { contextId: { in: part } } }));
  await chunked(listingIds, (part) => prisma.listingView.deleteMany({ where: { targetId: { in: part } } }));
  await chunked(listingIds, (part) => prisma.listingLike.deleteMany({ where: { targetId: { in: part } } }));
  await chunked(userIds, (part) => prisma.trip.deleteMany({ where: { driverId: { in: part } } }));
  await chunked(userIds, (part) => prisma.passengerRequest.deleteMany({ where: { passengerId: { in: part } } }));
  let count = 0;
  await chunked(userIds, async (part) => {
    count += (await prisma.user.deleteMany({ where: { id: { in: part } } })).count;
  });

  console.warn(
    `[test-seed] purged ${count} users, ${tripIds.length} trips, ${reqIds.length} requests (+ dependents).`,
  );
}

// ─── Entry ─────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const confirmed = args.includes('--yes') || process.env.SEED_TEST_USERS === 'yes';
  const doPurge = args.includes('--purge');

  if (!confirmed) {
    console.error('[test-seed] Refusing without confirmation. This writes/removes test data.');
    console.error('[test-seed]   Seed:  npm run db:seed:test -- --yes [--target 20000] [--users N] [--days N]');
    console.error('[test-seed]   Purge: npm run db:seed:test -- --purge --yes');
    process.exit(1);
  }
  if (process.env.NODE_ENV === 'production') {
    console.warn('[test-seed] NODE_ENV=production — proceeding (explicitly confirmed).');
  }

  if (doPurge) await purge();
  else await seed(parseArgs(args));
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
