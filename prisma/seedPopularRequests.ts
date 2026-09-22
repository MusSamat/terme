/**
 * Popular passenger-requests seed — fills a deployed test server with a BUSY
 * 20-day requests feed: popular KG routes, several requested departure times per
 * day, so the "requests" feed looks like a real, active marketplace.
 *
 * PassengerRequest has NO per-(passenger, route, day) unique index (unlike Trip),
 * so requests can stack freely — one passenger pool is reused across the feed.
 *
 * Volume with defaults: 18 routes × 20 days × 4 slots = 1 440 requests, spread
 * over 60 passengers. Slots already in the past (today) are skipped, so the
 * actual count is ≥ ~1 400 and always "более 1000". Every request is future +
 * status=open, so all show in the feed.
 *
 * Safe on a DEPLOYED (production) server: requires an explicit --yes flag, and
 * every row is tagged (phone block +996 70092 00xx, name suffix «Req») so
 * --purge removes exactly this data and nothing else. Independent of the
 * db:seed:test (+996 70090) and db:seed:popular (+996 70091) blocks — all coexist.
 *
 *   Seed:  npm run db:seed:requests -- --yes
 *   Purge: npm run db:seed:requests -- --purge --yes
 */

process.loadEnvFile?.('.env');

import { PrismaClient, Prisma } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

// ─── Config (tweak freely) ─────────────────────────────────────────────
const PHONE_PREFIX = '+99670092'; // +996 70092 00NN — reserved «requests» block
const NAME_SUFFIX = 'Req';
const DAYS = 20; // today .. +19 (KG calendar days)
const PASSENGERS = 60; // pool size — realism only (no per-passenger uniqueness)
const KG_OFFSET_MS = 6 * 60 * 60_000; // UTC+6, no DST

// Requested departure times per day, KG hours. 4 slots → 4 requests/route/day.
const SLOT_HOURS = [8, 11, 15, 19];

const FIRST_NAMES = [
  'Aizhan', 'Nurgul', 'Gulnara', 'Aida', 'Cholpon',
  'Meerim', 'Asel', 'Begimai', 'Jyldyz', 'Nazgul',
  'Aisuluu', 'Elnura', 'Kunduz', 'Saltanat', 'Venera',
  'Dinara', 'Ainura', 'Baktygul', 'Gulzat', 'Zarina',
];

// Popular KG routes — both directions are generated in code.
const BASE_ROUTES: Array<{ a: string; b: string }> = [
  { a: 'Бишкек', b: 'Ош' },
  { a: 'Бишкек', b: 'Каракол' },
  { a: 'Бишкек', b: 'Нарын' },
  { a: 'Бишкек', b: 'Талас' },
  { a: 'Бишкек', b: 'Манас' },
  { a: 'Бишкек', b: 'Токмок' },
  { a: 'Бишкек', b: 'Балыкчы' },
  { a: 'Ош', b: 'Манас' },
  { a: 'Ош', b: 'Баткен' },
];
const ROUTES = BASE_ROUTES.flatMap((r) => [
  { origin: r.a, destination: r.b },
  { origin: r.b, destination: r.a },
]);

const COMMENTS = [
  'Нужно доехать вовремя, встреча.',
  'Возьму небольшую сумку.',
  'Могу подстроиться по времени ±1 час.',
  'Еду с ребёнком, нужно детское кресло.',
  'Оплата наличными на месте.',
  null,
  null,
  null,
];

// ─── Helpers ───────────────────────────────────────────────────────────
const phoneFor = (i: number) => `${PHONE_PREFIX}${String(i).padStart(4, '0')}`;

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
  const marker = await prisma.user.findUnique({ where: { phone: phoneFor(1) } });
  if (marker) {
    console.warn('[req-seed] marker user already exists — data looks seeded. Skipping.');
    console.warn('[req-seed] To re-seed: npm run db:seed:requests -- --purge --yes  (then re-run).');
    return;
  }

  const passwordHash = await bcrypt.hash('TestPass12', 4);
  const now = new Date();

  // 1) Passenger pool: users + auth_providers (phone). No driver profile needed.
  const userIds: string[] = [];
  const authRows: Prisma.AuthProviderCreateManyInput[] = [];

  for (let i = 1; i <= PASSENGERS; i++) {
    const phone = phoneFor(i);
    const name = `${FIRST_NAMES[(i - 1) % FIRST_NAMES.length]}${NAME_SUFFIX}`;
    const user = await prisma.user.create({
      data: {
        phone,
        name,
        language: 'ru',
        roles: ['passenger'],
        phoneVerifiedAt: now,
        passwordHash,
        lastPasswordChangedAt: now,
        termsAcceptedAt: now,
      },
    });
    userIds.push(user.id);
    authRows.push({ userId: user.id, provider: 'phone', providerUserId: phone });
  }
  await prisma.authProvider.createMany({ data: authRows });
  console.warn(`[req-seed] ${userIds.length} passengers + auth providers created`);

  // 2) Requests: popular route × KG-day × time slot. Past slots (today) skipped
  //    so every seeded request is future + open (visible in the feed).
  const requests: Prisma.PassengerRequestCreateManyInput[] = [];
  let skippedPast = 0;

  for (let rIdx = 0; rIdx < ROUTES.length; rIdx++) {
    const r = ROUTES[rIdx]!;
    for (let d = 0; d < DAYS; d++) {
      const base = (rIdx * 5 + d * 11) % PASSENGERS; // rotates the pool per route-day
      for (let s = 0; s < SLOT_HOURS.length; s++) {
        const departure = kgDeparture(d, SLOT_HOURS[s]!);
        if (departure.getTime() <= now.getTime()) {
          skippedPast++;
          continue;
        }
        const passengerId = userIds[(base + s) % PASSENGERS]!;
        requests.push({
          passengerId,
          originCity: r.origin,
          destinationCity: r.destination,
          seatsNeeded: 1 + ((rIdx + d + s) % 3), // 1..3
          departureDate: departure,
          flexible: (rIdx + d + s) % 3 === 0, // ~1 in 3 flexible
          comment: COMMENTS[(rIdx + d + s) % COMMENTS.length]!,
          status: 'open',
          viewsCount: 3 + ((rIdx * 13 + d * 5 + s * 3) % 60),
          likesCount: (rIdx + d + s) % 8,
        });
      }
    }
  }

  const nReq = await chunkedCreateMany(requests, (b) =>
    prisma.passengerRequest.createMany({ data: b }),
  );
  console.warn(
    `[req-seed] ${nReq} requests created across ${ROUTES.length} routes × ${DAYS} days × ${SLOT_HOURS.length} slots (${skippedPast} past slots skipped)`,
  );

  console.warn('\n[req-seed] ✓ Done.');
  console.warn(`[req-seed] Passengers: ${phoneFor(1)} .. ${phoneFor(PASSENGERS)} (password: TestPass12)`);
}

// ─── Purge (removes exactly the tagged +996 70092 block) ────────────────
async function purge(): Promise<void> {
  const users = await prisma.user.findMany({
    where: { phone: { startsWith: PHONE_PREFIX } },
    select: { id: true },
  });
  if (users.length === 0) {
    console.warn('[req-seed] no requests-seed users found — nothing to purge.');
    return;
  }
  const userIds = users.map((u) => u.id);
  const reqs = await prisma.passengerRequest.findMany({
    where: { passengerId: { in: userIds } },
    select: { id: true },
  });
  const reqIds = reqs.map((r) => r.id);

  // FK-safe order (mirrors seedPopularTrips purge).
  await prisma.passengerRequestResponse.deleteMany({ where: { requestId: { in: reqIds } } });
  await prisma.contactReveal.deleteMany({
    where: {
      OR: [
        { contextId: { in: reqIds } },
        { viewerId: { in: userIds } },
        { targetUserId: { in: userIds } },
      ],
    },
  });
  await prisma.listingView.deleteMany({ where: { targetId: { in: reqIds } } });
  await prisma.listingLike.deleteMany({
    where: { OR: [{ targetId: { in: reqIds } }, { userId: { in: userIds } }] },
  });
  await prisma.passengerRequest.deleteMany({ where: { id: { in: reqIds } } });
  const { count } = await prisma.user.deleteMany({ where: { id: { in: userIds } } });

  console.warn(`[req-seed] purged ${count} passengers, ${reqIds.length} requests (+ dependents).`);
}

// ─── Entry ─────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const confirmed = args.includes('--yes') || process.env.SEED_REQUESTS === 'yes';
  const doPurge = args.includes('--purge');

  if (!confirmed) {
    console.error('[req-seed] Refusing without confirmation. This writes/removes test data.');
    console.error('[req-seed]   Seed:  npm run db:seed:requests -- --yes');
    console.error('[req-seed]   Purge: npm run db:seed:requests -- --purge --yes');
    process.exit(1);
  }
  if (process.env.NODE_ENV === 'production') {
    console.warn('[req-seed] NODE_ENV=production — proceeding (explicitly confirmed).');
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
