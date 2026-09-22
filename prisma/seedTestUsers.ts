/**
 * Test-load seed — 20 marked users («<Имя>Test», e.g. AlmazTest), each a
 * driver+passenger, filled with a WEEK of trips and ride-requests so a deployed
 * test server has a realistically busy feed.
 *
 * Volume (see DB constraints below): 5 routes × 2 directions × 7 KG-days
 *   → 70 trips + 70 requests per user → ≈1400 trips + 1400 requests total.
 *
 * DB rules this respects:
 *   • idx_trips_route_day_unique   — 1 active trip  per (driver, route, KG-day)
 *   • idx_requests_route_day_unique — 1 open request per (passenger, route, KG-day)
 *   So a day carries at most ONE trip/request per distinct route → we spread
 *   across 10 distinct routes (both directions) per day.
 *
 * Safe on a DEPLOYED server: unlike seedDemo it does NOT refuse on
 * NODE_ENV=production — the test server runs as production — but it REQUIRES an
 * explicit confirmation flag so it can never fire by accident, and every row it
 * writes is tagged (phone block +99670090xxxx, name suffix «Test») so --purge
 * removes exactly this data and nothing else.
 *
 *   Seed:  npm run db:seed:test -- --yes
 *   Purge: npm run db:seed:test -- --purge --yes
 */

process.loadEnvFile?.('.env');

import { PrismaClient, Prisma } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

// ─── Config ────────────────────────────────────────────────────────────
const PHONE_PREFIX = '+99670090'; // +996 70090 00NN — reserved test block
const NAME_SUFFIX = 'Test';
const DAYS = 7;                    // today .. +6 (KG calendar days)
const KG_OFFSET_MS = 6 * 60 * 60_000; // UTC+6, no DST

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
];

// 5 base pairs; both directions are generated in code → 10 routes / day.
const BASE_ROUTES: Array<{ a: string; b: string; price: number; dur: number }> = [
  { a: 'Бишкек', b: 'Ош',           price: 1200, dur: 600 },
  { a: 'Бишкек', b: 'Каракол',      price: 800,  dur: 360 },
  { a: 'Бишкек', b: 'Нарын',        price: 700,  dur: 300 },
  { a: 'Бишкек', b: 'Талас',        price: 600,  dur: 300 },
  { a: 'Бишкек', b: 'Манас',  price: 1100, dur: 560 },
];
const ROUTES = BASE_ROUTES.flatMap((r) => [
  { origin: r.a, destination: r.b, price: r.price, dur: r.dur },
  { origin: r.b, destination: r.a, price: r.price, dur: r.dur },
]);

const LUGGAGE: Array<'yes' | 'small' | 'no'> = ['yes', 'small', 'no'];

// ─── Helpers ───────────────────────────────────────────────────────────
const phoneFor = (i: number) => `${PHONE_PREFIX}${String(i).padStart(4, '0')}`;
const plateFor = (i: number) => `01KGT${String(i).padStart(3, '0')}`;

/**
 * Instant that reads as KG hour `h` on KG-day (today + dayOffset). KG date is
 * derived from now+6h; UTC hour = h-6 (Date.UTC handles the day rollover, and
 * `AT TIME ZONE 'Asia/Bishkek'` reverses it back to the intended KG date).
 */
function kgDeparture(dayOffset: number, kgHour: number): Date {
  const kgNow = new Date(Date.now() + KG_OFFSET_MS);
  return new Date(
    Date.UTC(
      kgNow.getUTCFullYear(),
      kgNow.getUTCMonth(),
      kgNow.getUTCDate() + dayOffset,
      kgHour - 6,
      0,
      0,
    ),
  );
}

async function chunkedCreateMany<T>(
  rows: T[],
  create: (batch: T[]) => Promise<unknown>,
  size = 500,
): Promise<number> {
  for (let i = 0; i < rows.length; i += size) {
    await create(rows.slice(i, i + size));
  }
  return rows.length;
}

// ─── Seed ──────────────────────────────────────────────────────────────
async function seed(): Promise<void> {
  const marker = await prisma.user.findUnique({ where: { phone: phoneFor(1) } });
  if (marker) {
    console.warn('[test-seed] marker user already exists — data looks seeded. Skipping.');
    console.warn('[test-seed] To re-seed: npm run db:seed:test -- --purge --yes  (then re-run).');
    return;
  }

  const passwordHash = await bcrypt.hash('TestPass12', 4);
  const now = new Date();

  // 1) Users + auth_providers + verified driver profiles
  const userIds: string[] = [];
  const authRows: Prisma.AuthProviderCreateManyInput[] = [];
  const profileRows: Prisma.DriverProfileCreateManyInput[] = [];

  for (let i = 1; i <= FIRST_NAMES.length; i++) {
    const phone = phoneFor(i);
    const name = `${FIRST_NAMES[i - 1]}${NAME_SUFFIX}`;
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
      carYear: 2015 + (i % 8),
      carColor: 'Белый',
      carPlate: plateFor(i),
      seatsCount: 4,
      licensePhotoPath: `seed/test${i}/license.jpg`,
      carPassportPath: `seed/test${i}/passport.jpg`,
      carPhotoPath: `seed/test${i}/car.jpg`,
      selfiePath: `seed/test${i}/selfie.jpg`,
      verificationStatus: 'verified',
      verifiedAt: now,
      totalTrips: 0,
    });
  }
  await prisma.authProvider.createMany({ data: authRows });
  await prisma.driverProfile.createMany({ data: profileRows });
  console.warn(`[test-seed] ${userIds.length} users + profiles created`);

  // 2) Trips + requests: per user, per KG-day, per route.
  const trips: Prisma.TripCreateManyInput[] = [];
  const requests: Prisma.PassengerRequestCreateManyInput[] = [];

  userIds.forEach((userId, uIdx) => {
    for (let d = 0; d < DAYS; d++) {
      ROUTES.forEach((r, rIdx) => {
        const kgHour = 7 + rIdx;                 // 07:00 .. 16:00 KG — all same KG day
        const seatsTotal = 3 + (rIdx % 2);       // 3 or 4
        // Realistic sold-out on INDIVIDUAL trips, keyed on the user so it
        // spreads across the 20 drivers: ~1 in 6 (≈3 of 20) on any given
        // route-day sells out, the rest stay bookable — the list is never
        // empty. (The earlier all-users formula zeroed a whole route-day.)
        const soldOut = (uIdx * 31 + d * 7 + rIdx) % 6 === 0;
        const seatsAvailable = soldOut ? 0 : 1 + ((uIdx + d + rIdx) % seatsTotal);
        trips.push({
          driverId: userId,
          originCity: r.origin,
          destinationCity: r.destination,
          originAddress: 'Западный автовокзал',
          departureAt: kgDeparture(d, kgHour),
          estimatedDurationMin: r.dur,
          seatsTotal,
          seatsAvailable,
          pricePerSeat: r.price + d * 20,
          luggage: LUGGAGE[rIdx % LUGGAGE.length]!,
          status: 'active',
          preferences: { no_smoking: true } as Prisma.InputJsonValue,
        });
        requests.push({
          passengerId: userId,
          originCity: r.origin,
          destinationCity: r.destination,
          seatsNeeded: 1 + (rIdx % 3),
          departureDate: kgDeparture(d, 9),
          flexible: rIdx % 2 === 0,
          status: 'open',
          comment: rIdx % 3 === 0 ? 'Нужно доехать, гибок по времени.' : null,
        });
      });
    }
  });

  const nTrips = await chunkedCreateMany(trips, (b) =>
    prisma.trip.createMany({ data: b }),
  );
  const nReq = await chunkedCreateMany(requests, (b) =>
    prisma.passengerRequest.createMany({ data: b }),
  );
  console.warn(`[test-seed] ${nTrips} trips + ${nReq} requests created`);

  console.warn('\n[test-seed] ✓ Done.');
  console.warn(`[test-seed] Users: ${phoneFor(1)} .. ${phoneFor(FIRST_NAMES.length)} (password: TestPass12)`);
  console.warn('[test-seed] Mint a token: npm run dev:token -- <phone>');
}

// ─── Purge (removes exactly the tagged test block) ──────────────────────
async function purge(): Promise<void> {
  const users = await prisma.user.findMany({
    where: { phone: { startsWith: PHONE_PREFIX } },
    select: { id: true },
  });
  if (users.length === 0) {
    console.warn('[test-seed] no test users found — nothing to purge.');
    return;
  }
  const userIds = users.map((u) => u.id);
  const [trips, reqs] = await Promise.all([
    prisma.trip.findMany({ where: { driverId: { in: userIds } }, select: { id: true } }),
    prisma.passengerRequest.findMany({ where: { passengerId: { in: userIds } }, select: { id: true } }),
  ]);
  const tripIds = trips.map((t) => t.id);
  const reqIds = reqs.map((r) => r.id);
  const listingIds = [...tripIds, ...reqIds];

  // FK-safe order. User delete cascades auth_providers / driver_profiles /
  // listing_likes / notifications; everything below is NOT cascaded from user.
  await prisma.booking.deleteMany({
    where: { OR: [{ tripId: { in: tripIds } }, { passengerId: { in: userIds } }] },
  }); // messages cascade from booking
  await prisma.rating.deleteMany({
    where: { OR: [{ raterId: { in: userIds } }, { rateeId: { in: userIds } }] },
  });
  await prisma.passengerRequestResponse.deleteMany({
    where: { OR: [{ driverId: { in: userIds } }, { requestId: { in: reqIds } }] },
  });
  await prisma.contactReveal.deleteMany({
    where: { OR: [{ contextId: { in: listingIds } }, { viewerId: { in: userIds } }] },
  });
  await prisma.listingView.deleteMany({ where: { targetId: { in: listingIds } } });
  await prisma.listingLike.deleteMany({ where: { targetId: { in: listingIds } } });
  await prisma.trip.deleteMany({ where: { id: { in: tripIds } } });
  await prisma.passengerRequest.deleteMany({ where: { id: { in: reqIds } } });
  const { count } = await prisma.user.deleteMany({ where: { id: { in: userIds } } });

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
    console.error('[test-seed]   Seed:  npm run db:seed:test -- --yes');
    console.error('[test-seed]   Purge: npm run db:seed:test -- --purge --yes');
    process.exit(1);
  }
  if (process.env.NODE_ENV === 'production') {
    console.warn('[test-seed] NODE_ENV=production — proceeding (explicitly confirmed).');
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
