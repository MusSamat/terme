/**
 * Popular-trips seed — fills a deployed test server with a BUSY 2-week feed:
 * popular KG routes, each running MANY departure times per day (06:00–22:00),
 * so the feed looks like a real, active marketplace.
 *
 * DB rule respected — idx_trips_route_day_unique: at most ONE active trip per
 * (driver, route, KG-day). "Many times on the same route+day" therefore needs a
 * DIFFERENT driver per time slot — the driver pool is assigned collision-free
 * (each slot on a route-day gets a distinct driver; SLOTS ≤ DRIVERS).
 *
 * Volume with defaults: 18 routes × 14 days × 9 slots ≈ 2 268 trips, spread over
 * 40 drivers (≈57 trips each over the fortnight).
 *
 * Safe on a DEPLOYED (production) server: requires an explicit --yes flag, and
 * every row is tagged (phone block +996 70091 00xx, name suffix «Pop») so
 * --purge removes exactly this data and nothing else. Independent of the
 * db:seed:test block (+996 70090) — both can coexist.
 *
 *   Seed:  npm run db:seed:popular -- --yes
 *   Purge: npm run db:seed:popular -- --purge --yes
 */

process.loadEnvFile?.('.env');

import { PrismaClient, Prisma } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

// ─── Config (tweak freely) ─────────────────────────────────────────────
const PHONE_PREFIX = '+99670091'; // +996 70091 00NN — reserved «popular» block
const NAME_SUFFIX = 'Pop';
const DAYS = 14; // today .. +13 (KG calendar days)
const DRIVERS = 40; // pool size — must be ≥ SLOT_HOURS.length
const KG_OFFSET_MS = 6 * 60 * 60_000; // UTC+6, no DST

// Departure times per day, KG hours. "Every time" across the day.
const SLOT_HOURS = [6, 8, 10, 12, 14, 16, 18, 20, 22];

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

// Popular KG routes — both directions are generated in code.
const BASE_ROUTES: Array<{ a: string; b: string; price: number; dur: number }> = [
  { a: 'Бишкек', b: 'Ош',          price: 1200, dur: 600 },
  { a: 'Бишкек', b: 'Каракол',     price: 800,  dur: 360 },
  { a: 'Бишкек', b: 'Нарын',       price: 700,  dur: 300 },
  { a: 'Бишкек', b: 'Талас',       price: 600,  dur: 300 },
  { a: 'Бишкек', b: 'Манас', price: 1100, dur: 560 },
  { a: 'Бишкек', b: 'Токмок',      price: 200,  dur: 70 },
  { a: 'Бишкек', b: 'Балыкчы',     price: 350,  dur: 150 },
  { a: 'Ош',     b: 'Манас', price: 300,  dur: 120 },
  { a: 'Ош',     b: 'Баткен',      price: 500,  dur: 240 },
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
  null,
  null,
];

// ─── Helpers ───────────────────────────────────────────────────────────
const phoneFor = (i: number) => `${PHONE_PREFIX}${String(i).padStart(4, '0')}`;
const plateFor = (i: number) => `01KGP${String(i).padStart(3, '0')}`;

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
    console.warn('[pop-seed] marker user already exists — data looks seeded. Skipping.');
    console.warn('[pop-seed] To re-seed: npm run db:seed:popular -- --purge --yes  (then re-run).');
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
      licensePhotoPath: `seed/pop${i}/license.jpg`,
      carPassportPath: `seed/pop${i}/passport.jpg`,
      carPhotoPath: `seed/pop${i}/car.jpg`,
      selfiePath: `seed/pop${i}/selfie.jpg`,
      verificationStatus: 'verified',
      verifiedAt: now,
      totalTrips: 0,
    });
  }
  await prisma.authProvider.createMany({ data: authRows });
  await prisma.driverProfile.createMany({ data: profileRows });
  console.warn(`[pop-seed] ${userIds.length} drivers + profiles created`);

  // 2) Trips: popular route × KG-day × time slot. Each slot → distinct driver so
  //    the (driver, route, KG-day) unique index never trips.
  const trips: Prisma.TripCreateManyInput[] = [];

  for (let rIdx = 0; rIdx < ROUTES.length; rIdx++) {
    const r = ROUTES[rIdx]!;
    for (let d = 0; d < DAYS; d++) {
      const base = (rIdx * 7 + d * 13) % DRIVERS; // rotates the pool per route-day
      for (let s = 0; s < SLOT_HOURS.length; s++) {
        const driverId = userIds[(base + s) % DRIVERS]!;
        const hour = SLOT_HOURS[s]!;
        const seatsTotal = 4 - (s % 2); // 4 or 3
        const soldOut = (rIdx * 31 + d * 7 + s) % 8 === 0; // ~1 in 8 fully booked
        const seatsAvailable = soldOut ? 0 : 1 + ((rIdx + d + s) % seatsTotal);
        const peak = hour <= 10 ? 50 : hour >= 18 ? 30 : 0; // morning/evening bump
        trips.push({
          driverId,
          originCity: r.origin,
          destinationCity: r.destination,
          originAddress: STATIONS[(rIdx + s) % STATIONS.length]!,
          departureAt: kgDeparture(d, hour),
          estimatedDurationMin: r.dur,
          seatsTotal,
          seatsAvailable,
          pricePerSeat: r.price + peak + d * 10,
          luggage: LUGGAGE[(rIdx + s) % LUGGAGE.length]!,
          status: 'active',
          preferences: { no_smoking: true, music: s % 2 === 0 } as Prisma.InputJsonValue,
          comment: COMMENTS[(rIdx + d + s) % COMMENTS.length]!,
          // "Popular" flavour — some views/likes so the feed feels alive.
          viewsCount: 8 + ((rIdx * 13 + d * 5 + s * 3) % 90),
          likesCount: (rIdx + d + s) % 12,
        });
      }
    }
  }

  const nTrips = await chunkedCreateMany(trips, (b) => prisma.trip.createMany({ data: b }));
  console.warn(`[pop-seed] ${nTrips} trips created across ${ROUTES.length} routes × ${DAYS} days × ${SLOT_HOURS.length} slots`);

  console.warn('\n[pop-seed] ✓ Done.');
  console.warn(`[pop-seed] Drivers: ${phoneFor(1)} .. ${phoneFor(DRIVERS)} (password: TestPass12)`);
}

// ─── Purge (removes exactly the tagged +996 70091 block) ────────────────
async function purge(): Promise<void> {
  const users = await prisma.user.findMany({
    where: { phone: { startsWith: PHONE_PREFIX } },
    select: { id: true },
  });
  if (users.length === 0) {
    console.warn('[pop-seed] no popular-seed users found — nothing to purge.');
    return;
  }
  const userIds = users.map((u) => u.id);
  const trips = await prisma.trip.findMany({ where: { driverId: { in: userIds } }, select: { id: true } });
  const tripIds = trips.map((t) => t.id);

  // FK-safe order (mirrors seedTestUsers purge).
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

  console.warn(`[pop-seed] purged ${count} drivers, ${tripIds.length} trips (+ dependents).`);
}

// ─── Entry ─────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const confirmed = args.includes('--yes') || process.env.SEED_POPULAR === 'yes';
  const doPurge = args.includes('--purge');

  if (!confirmed) {
    console.error('[pop-seed] Refusing without confirmation. This writes/removes test data.');
    console.error('[pop-seed]   Seed:  npm run db:seed:popular -- --yes');
    console.error('[pop-seed]   Purge: npm run db:seed:popular -- --purge --yes');
    process.exit(1);
  }
  if (process.env.NODE_ENV === 'production') {
    console.warn('[pop-seed] NODE_ENV=production — proceeding (explicitly confirmed).');
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
