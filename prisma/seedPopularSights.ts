/**
 * Popular-sights seed — fills a deployed test server with a LARGE 20-day feed of
 * trips to Kyrgyzstan's tourist destinations (Issyk-Kul shore, Song-Köl gateway,
 * Karakol gorges, Naryn/Tash-Rabat, southern sights), so the feed looks like a
 * real, busy holiday-season marketplace.
 *
 * DB rule respected — idx_trips_route_day_unique: at most ONE active trip per
 * (driver, origin, destination, KG-day). Many times on the same route+day
 * therefore needs a DISTINCT driver per time slot (SLOT_HOURS.length ≤ DRIVERS);
 * the pool is assigned collision-free.
 *
 * Volume with defaults: 48 sight pairs × 2 directions = 96 routes × 20 days ×
 * 11 slots = 21 120 trips, spread over 200 drivers (~5 trips/driver/day).
 * Past-today slots are skipped, so the real count is ~21k and always «более 20000».
 *
 * Safe on a DEPLOYED (production) server: requires an explicit --yes flag, and
 * every row is tagged (phone block +996 70093 0xxx, name suffix «Tur») so
 * --purge removes exactly this data and nothing else. Independent of the
 * db:seed:test (+996 70090), db:seed:popular (+996 70091) and db:seed:requests
 * (+996 70092) blocks — all coexist.
 *
 *   Seed:  npm run db:seed:sights -- --yes
 *   Purge: npm run db:seed:sights -- --purge --yes
 */

process.loadEnvFile?.('.env');

import { PrismaClient, Prisma } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

// ─── Config (tweak freely) ─────────────────────────────────────────────
const PHONE_PREFIX = '+99670093'; // +996 70093 0NNN — reserved «sights» block
const NAME_SUFFIX = 'Tur';
const DAYS = 20; // today .. +19 (KG calendar days)
const DRIVERS = 200; // pool size — must be ≥ SLOT_HOURS.length
const KG_OFFSET_MS = 6 * 60 * 60_000; // UTC+6, no DST

// 11 departure times per day, KG hours (≈ every 1.5h across the day).
const SLOT_HOURS = [6, 7, 8, 9, 11, 13, 15, 17, 18, 20, 22];

const FIRST_NAMES = [
  'Almaz', 'Nurlan', 'Aziz', 'Bakyt', 'Ermek',
  'Timur', 'Ulan', 'Adil', 'Ruslan', 'Kanat',
  'Aibek', 'Daniyar', 'Emil', 'Marat', 'Sanjar',
  'Talant', 'Bekzat', 'Chyngyz', 'Iskender', 'Maksat',
];

const CARS = [
  { make: 'Toyota', model: 'Camry' }, { make: 'Honda', model: 'Fit' },
  { make: 'Nissan', model: 'Tiida' }, { make: 'Toyota', model: 'Corolla' },
  { make: 'Lexus', model: 'RX' }, { make: 'Hyundai', model: 'Sonata' },
  { make: 'Mercedes', model: 'Sprinter' }, { make: 'Toyota', model: 'Alphard' },
];

// Sight routes — city names verified against the active cities table. Both
// directions are generated in code.
const BASE_ROUTES: Array<{ a: string; b: string; price: number; dur: number }> = [
  // Bishkek → Issyk-Kul (north & south shore, Karakol)
  { a: 'Бишкек', b: 'Чолпон-Ата', price: 500, dur: 240 },
  { a: 'Бишкек', b: 'Бостери', price: 550, dur: 260 },
  { a: 'Бишкек', b: 'Тамчы', price: 450, dur: 210 },
  { a: 'Бишкек', b: 'Кара-Ой', price: 470, dur: 215 },
  { a: 'Бишкек', b: 'Сары-Ой', price: 480, dur: 220 },
  { a: 'Бишкек', b: 'Григорьевка', price: 490, dur: 230 },
  { a: 'Бишкек', b: 'Семёновка', price: 500, dur: 235 },
  { a: 'Бишкек', b: 'Балыкчы', price: 350, dur: 150 },
  { a: 'Бишкек', b: 'Каракол', price: 800, dur: 360 },
  { a: 'Бишкек', b: 'Боконбаево', price: 550, dur: 260 },
  { a: 'Бишкек', b: 'Кажы-Сай', price: 650, dur: 300 },
  { a: 'Бишкек', b: 'Тосор', price: 700, dur: 320 },
  { a: 'Бишкек', b: 'Барскоон', price: 750, dur: 340 },
  { a: 'Бишкек', b: 'Тамга', price: 720, dur: 330 },
  // Bishkek → Naryn / Song-Köl gateway / Talas / Chuy / South
  { a: 'Бишкек', b: 'Нарын', price: 700, dur: 300 },
  { a: 'Бишкек', b: 'Кочкор', price: 500, dur: 220 },
  { a: 'Бишкек', b: 'Ат-Башы', price: 850, dur: 360 },
  { a: 'Бишкек', b: 'Талас', price: 600, dur: 300 },
  { a: 'Бишкек', b: 'Манас', price: 650, dur: 320 },
  { a: 'Бишкек', b: 'Кызыл-Адыр', price: 650, dur: 320 },
  { a: 'Бишкек', b: 'Токмок', price: 150, dur: 70 },
  { a: 'Бишкек', b: 'Кант', price: 120, dur: 50 },
  { a: 'Бишкек', b: 'Кемин', price: 250, dur: 110 },
  { a: 'Бишкек', b: 'Орловка', price: 300, dur: 130 },
  { a: 'Бишкек', b: 'Кара-Балта', price: 200, dur: 90 },
  { a: 'Бишкек', b: 'Сокулук', price: 100, dur: 45 },
  { a: 'Бишкек', b: 'Беловодское', price: 130, dur: 60 },
  { a: 'Бишкек', b: 'Токтогул', price: 900, dur: 420 },
  { a: 'Бишкек', b: 'Кара-Куль', price: 1000, dur: 480 },
  { a: 'Бишкек', b: 'Ош', price: 1200, dur: 600 },
  // Karakol cluster (Issyk-Kul east)
  { a: 'Каракол', b: 'Жети-Өгүз', price: 150, dur: 60 },
  { a: 'Каракол', b: 'Ак-Суу', price: 120, dur: 45 },
  { a: 'Каракол', b: 'Ананьево', price: 250, dur: 110 },
  { a: 'Каракол', b: 'Барскоон', price: 300, dur: 130 },
  // Osh & southern sights
  { a: 'Ош', b: 'Кербен', price: 400, dur: 180 },
  { a: 'Ош', b: 'Кара-Суу', price: 100, dur: 45 },
  { a: 'Ош', b: 'Ноокат', price: 200, dur: 90 },
  { a: 'Ош', b: 'Кызыл-Кия', price: 250, dur: 110 },
  { a: 'Ош', b: 'Баткен', price: 500, dur: 240 },
  { a: 'Ош', b: 'Айдаркен', price: 550, dur: 260 },
  { a: 'Ош', b: 'Сулюкта', price: 600, dur: 280 },
  { a: 'Ош', b: 'Арсланбоб', price: 450, dur: 210 },
  { a: 'Ош', b: 'Базар-Коргон', price: 350, dur: 160 },
  { a: 'Ош', b: 'Таш-Кумыр', price: 400, dur: 190 },
  { a: 'Ош', b: 'Майлуу-Суу', price: 420, dur: 200 },
  { a: 'Ош', b: 'Кочкор-Ата', price: 380, dur: 170 },
  // Naryn cluster
  { a: 'Нарын', b: 'Ат-Башы', price: 200, dur: 90 },
  { a: 'Нарын', b: 'Кочкор', price: 250, dur: 110 },
];
const ROUTES = BASE_ROUTES.flatMap((r) => [
  { origin: r.a, destination: r.b, price: r.price, dur: r.dur },
  { origin: r.b, destination: r.a, price: r.price, dur: r.dur },
]);

const LUGGAGE: Array<'yes' | 'small' | 'no'> = ['yes', 'small', 'no'];
const STATIONS = ['Западный автовокзал', 'Восточный автовокзал', 'Ошский рынок', 'Центр'];
const COMMENTS = [
  'Кондиционер, музыка по желанию.',
  'Не курю, аккуратно вожу.',
  'Заеду за вами по городу.',
  'Есть место для багажа.',
  'Еду к озеру, возьму попутчиков.',
  null,
  null,
];

// ─── Helpers ───────────────────────────────────────────────────────────
const phoneFor = (i: number) => `${PHONE_PREFIX}${String(i).padStart(4, '0')}`;
// 01KGS = «sights» plate namespace. Distinct from 01KGP (popular) and 01KGT
// (test users, seedTestUsers.ts) — car_plate is globally UNIQUE, so seeds must
// not share a prefix.
const plateFor = (i: number) => `01KGS${String(i).padStart(3, '0')}`;

/** Instant that reads as KG hour `h` on KG-day (today + dayOffset). */
function kgDeparture(dayOffset: number, kgHour: number): Date {
  const kgNow = new Date(Date.now() + KG_OFFSET_MS);
  return new Date(
    Date.UTC(kgNow.getUTCFullYear(), kgNow.getUTCMonth(), kgNow.getUTCDate() + dayOffset, kgHour - 6, 0, 0),
  );
}

async function chunkedCreateMany<T>(
  rows: T[],
  create: (batch: T[]) => Promise<unknown>,
  size = 500,
): Promise<number> {
  for (let i = 0; i < rows.length; i += size) await create(rows.slice(i, i + size));
  return rows.length;
}

// ─── Seed ──────────────────────────────────────────────────────────────
async function seed(): Promise<void> {
  if (SLOT_HOURS.length > DRIVERS) {
    throw new Error(`SLOT_HOURS (${SLOT_HOURS.length}) must be ≤ DRIVERS (${DRIVERS}) — one distinct driver per slot per route-day.`);
  }

  const marker = await prisma.user.findUnique({ where: { phone: phoneFor(1) } });
  if (marker) {
    console.warn('[sights-seed] marker user already exists — data looks seeded. Skipping.');
    console.warn('[sights-seed] To re-seed: npm run db:seed:sights -- --purge --yes  (then re-run).');
    return;
  }

  const passwordHash = await bcrypt.hash('TestPass12', 4);
  const now = new Date();

  // 1) Driver pool: users + auth_providers + verified driver profiles.
  const userIds: string[] = [];
  const authRows: Prisma.AuthProviderCreateManyInput[] = [];
  const profileRows: Prisma.DriverProfileCreateManyInput[] = [];

  for (let i = 1; i <= DRIVERS; i++) {
    const phone = phoneFor(i);
    const name = `${FIRST_NAMES[(i - 1) % FIRST_NAMES.length]}${NAME_SUFFIX}`;
    const car = CARS[i % CARS.length]!;
    const user = await prisma.user.create({
      data: {
        phone,
        name,
        language: 'ru',
        roles: ['passenger', 'driver'],
        phoneVerifiedAt: now,
        passwordHash,
        lastPasswordChangedAt: now,
        termsAcceptedAt: now,
      },
    });
    userIds.push(user.id);
    authRows.push({ userId: user.id, provider: 'phone', providerUserId: phone });
    profileRows.push({
      userId: user.id,
      carMake: car.make,
      carModel: car.model,
      carYear: 2015 + (i % 9),
      carColor: 'Белый',
      carPlate: plateFor(i),
      seatsCount: 4,
      licensePhotoPath: `seed/tur${i}/license.jpg`,
      carPassportPath: `seed/tur${i}/passport.jpg`,
      carPhotoPath: `seed/tur${i}/car.jpg`,
      selfiePath: `seed/tur${i}/selfie.jpg`,
      verificationStatus: 'verified',
      verifiedAt: now,
      totalTrips: 0,
    });
  }
  await prisma.authProvider.createMany({ data: authRows });
  await prisma.driverProfile.createMany({ data: profileRows });
  console.warn(`[sights-seed] ${userIds.length} drivers + profiles created`);

  // 2) Trips: sight route × KG-day × time slot. Each slot → distinct driver so
  //    the (driver, route, KG-day) unique index never trips. Past-today slots
  //    are skipped so every seeded trip is future + active (visible in feed).
  const trips: Prisma.TripCreateManyInput[] = [];
  let skippedPast = 0;

  for (let rIdx = 0; rIdx < ROUTES.length; rIdx++) {
    const r = ROUTES[rIdx]!;
    for (let d = 0; d < DAYS; d++) {
      const base = (rIdx * 7 + d * 13) % DRIVERS; // rotates the pool per route-day
      for (let s = 0; s < SLOT_HOURS.length; s++) {
        const hour = SLOT_HOURS[s]!;
        const departure = kgDeparture(d, hour);
        if (departure.getTime() <= now.getTime()) {
          skippedPast++;
          continue;
        }
        const driverId = userIds[(base + s) % DRIVERS]!;
        const seatsTotal = 4 - (s % 2); // 4 or 3
        const soldOut = (rIdx * 31 + d * 7 + s) % 8 === 0; // ~1 in 8 fully booked
        const seatsAvailable = soldOut ? 0 : 1 + ((rIdx + d + s) % seatsTotal);
        const peak = hour <= 10 ? 50 : hour >= 18 ? 30 : 0; // morning/evening bump
        trips.push({
          driverId,
          originCity: r.origin,
          destinationCity: r.destination,
          originAddress: STATIONS[(rIdx + s) % STATIONS.length]!,
          departureAt: departure,
          estimatedDurationMin: r.dur,
          seatsTotal,
          seatsAvailable,
          pricePerSeat: r.price + peak + d * 10,
          luggage: LUGGAGE[(rIdx + s) % LUGGAGE.length]!,
          status: 'active',
          preferences: { no_smoking: true, music: s % 2 === 0 } as Prisma.InputJsonValue,
          comment: COMMENTS[(rIdx + d + s) % COMMENTS.length]!,
          viewsCount: 8 + ((rIdx * 13 + d * 5 + s * 3) % 120),
          likesCount: (rIdx + d + s) % 15,
        });
      }
    }
  }

  const nTrips = await chunkedCreateMany(trips, (b) => prisma.trip.createMany({ data: b }));
  console.warn(
    `[sights-seed] ${nTrips} trips created across ${ROUTES.length} routes × ${DAYS} days × ${SLOT_HOURS.length} slots (${skippedPast} past slots skipped)`,
  );

  console.warn('\n[sights-seed] ✓ Done.');
  console.warn(`[sights-seed] Drivers: ${phoneFor(1)} .. ${phoneFor(DRIVERS)} (password: TestPass12)`);
}

// ─── Purge (removes exactly the tagged +996 70093 block) ────────────────
async function purge(): Promise<void> {
  const users = await prisma.user.findMany({
    where: { phone: { startsWith: PHONE_PREFIX } },
    select: { id: true },
  });
  if (users.length === 0) {
    console.warn('[sights-seed] no sights-seed users found — nothing to purge.');
    return;
  }
  const userIds = users.map((u) => u.id);
  const trips = await prisma.trip.findMany({ where: { driverId: { in: userIds } }, select: { id: true } });
  const tripIds = trips.map((t) => t.id);

  // FK-safe order (mirrors seedPopularTrips purge).
  await prisma.booking.deleteMany({
    where: { OR: [{ tripId: { in: tripIds } }, { passengerId: { in: userIds } }] },
  });
  await prisma.rating.deleteMany({
    where: { OR: [{ raterId: { in: userIds } }, { rateeId: { in: userIds } }] },
  });
  await prisma.contactReveal.deleteMany({
    where: { OR: [{ contextId: { in: tripIds } }, { viewerId: { in: userIds } }] },
  });
  await prisma.listingView.deleteMany({ where: { targetId: { in: tripIds } } });
  await prisma.listingLike.deleteMany({ where: { targetId: { in: tripIds } } });
  await prisma.trip.deleteMany({ where: { id: { in: tripIds } } });
  const { count } = await prisma.user.deleteMany({ where: { id: { in: userIds } } });

  console.warn(`[sights-seed] purged ${count} drivers, ${tripIds.length} trips (+ dependents).`);
}

// ─── Entry ─────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const confirmed = args.includes('--yes') || process.env.SEED_SIGHTS === 'yes';
  const doPurge = args.includes('--purge');

  if (!confirmed) {
    console.error('[sights-seed] Refusing without confirmation. This writes/removes test data.');
    console.error('[sights-seed]   Seed:  npm run db:seed:sights -- --yes');
    console.error('[sights-seed]   Purge: npm run db:seed:sights -- --purge --yes');
    process.exit(1);
  }
  if (process.env.NODE_ENV === 'production') {
    console.warn('[sights-seed] NODE_ENV=production — proceeding (explicitly confirmed).');
  }

  if (doPurge) await purge();
  else await seed();
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
