/**
 * Demo seed — populates every content-bearing table with realistic data so a
 * freshly-booted dev/staging environment has something to look at. Safe to
 * re-run: everything is idempotent by checking for a known marker user.
 *
 * NEVER run in production (refuses if NODE_ENV=production). The production
 * baseline is `prisma/seed.ts` — that handles cities + the first superadmin
 * only. This file layers on top.
 *
 *   npm run db:seed:demo
 */

process.loadEnvFile?.('.env');

if (process.env.NODE_ENV === 'production') {
  console.error('seedDemo is disabled in production. Exiting.');
  process.exit(1);
}

import { PrismaClient, Prisma } from '@prisma/client';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';

const prisma = new PrismaClient();

// ─── Helpers ───────────────────────────────────────────────────────
const DEMO_PHONE_PREFIX = '+99670000';       // demo phones: +996700000001 .. +996700000099
const DEMO_MARKER_PHONE = `${DEMO_PHONE_PREFIX}0001`;

type Persona = {
  phone: string;
  name: string;
  roles: Array<'passenger' | 'driver' | 'both'>;
  language?: 'ru' | 'kg';
  blocked?: string; // reason if blocked
  hasPassword?: boolean;
  telegramId?: bigint;
};

const PERSONAS: Persona[] = [
  // Passengers
  { phone: `${DEMO_PHONE_PREFIX}0001`, name: 'Айбек Осмонов',    roles: ['passenger'], hasPassword: true },
  { phone: `${DEMO_PHONE_PREFIX}0002`, name: 'Бегимай Токтосунова', roles: ['passenger'], language: 'kg' },
  { phone: `${DEMO_PHONE_PREFIX}0003`, name: 'Нурдин Абдыраимов', roles: ['passenger'], hasPassword: true },
  { phone: `${DEMO_PHONE_PREFIX}0004`, name: 'Гулнара Садыкова',  roles: ['passenger'] },
  // Verified drivers
  { phone: `${DEMO_PHONE_PREFIX}0005`, name: 'Асан Турсунбеков',  roles: ['driver'], hasPassword: true, telegramId: 100000005n },
  { phone: `${DEMO_PHONE_PREFIX}0006`, name: 'Эркин Жумабаев',    roles: ['driver'], language: 'kg' },
  { phone: `${DEMO_PHONE_PREFIX}0007`, name: 'Мирлан Касымалиев', roles: ['driver'], hasPassword: true },
  // Both (passenger + verified driver)
  { phone: `${DEMO_PHONE_PREFIX}0008`, name: 'Чынара Муратбекова', roles: ['passenger', 'driver'], hasPassword: true, telegramId: 100000008n },
  // Driver with pending verification (roles still only passenger until approved)
  { phone: `${DEMO_PHONE_PREFIX}0009`, name: 'Бекмурат Исаев',    roles: ['passenger'] },
  // Driver whose profile was REJECTED
  { phone: `${DEMO_PHONE_PREFIX}0010`, name: 'Данияр Абдиев',     roles: ['passenger'] },
  // Blocked user
  { phone: `${DEMO_PHONE_PREFIX}0011`, name: 'Блокированный Пользователь', roles: ['passenger'], blocked: 'Verified complaint: rude behavior' },
];

async function ensureDemoNotYetSeeded(): Promise<boolean> {
  const existing = await prisma.user.findFirst({ where: { phone: DEMO_MARKER_PHONE } });
  if (existing) {
    console.warn('[demo] marker user already exists — demo data looks seeded. Skipping.');
    console.warn('[demo] To re-seed: manually TRUNCATE demo rows or reset the DB.');
    return false;
  }
  return true;
}

async function seedUsers(): Promise<Map<string, string>> {
  const idByPhone = new Map<string, string>();
  for (const p of PERSONAS) {
    const passwordHash = p.hasPassword ? await bcrypt.hash('DemoPass12', 4) : null;
    const user = await prisma.user.create({
      data: {
        phone: p.phone,
        name: p.name,
        language: p.language ?? 'ru',
        // "both" is written in users.roles as [passenger, driver] per TZ §8.9.
        roles: p.roles.includes('both') ? ['passenger', 'driver'] : p.roles,
        phoneVerifiedAt: new Date(),
        telegramId: p.telegramId ?? null,
        passwordHash,
        lastPasswordChangedAt: passwordHash ? new Date() : null,
        isBlocked: !!p.blocked,
        blockedReason: p.blocked ?? null,
        termsAcceptedAt: new Date(),
      },
    });
    idByPhone.set(p.phone, user.id);
  }
  console.warn(`[demo] ${PERSONAS.length} users created`);
  return idByPhone;
}

async function seedDriverProfiles(ids: Map<string, string>, adminId: string): Promise<void> {
  // (phone → car + status)
  const profiles: Array<[string, Prisma.DriverProfileUncheckedCreateInput & { trips: number }]> = [
    [
      `${DEMO_PHONE_PREFIX}0005`,
      {
        userId: ids.get(`${DEMO_PHONE_PREFIX}0005`)!,
        carMake: 'Toyota', carModel: 'Camry', carYear: 2018, carColor: 'Белый', carPlate: '01KG555AA',
        seatsCount: 4,
        licensePhotoPath: 'seed/driver5/license.jpg',
        carPassportPath: 'seed/driver5/passport.jpg',
        carPhotoPath: 'seed/driver5/car.jpg',
        selfiePath: 'seed/driver5/selfie.jpg',
        verificationStatus: 'verified',
        verifiedAt: new Date(),
        verifiedBy: adminId,
        totalTrips: 42,
        trips: 42,
      },
    ],
    [
      `${DEMO_PHONE_PREFIX}0006`,
      {
        userId: ids.get(`${DEMO_PHONE_PREFIX}0006`)!,
        carMake: 'Honda', carModel: 'Fit', carYear: 2016, carColor: 'Синий', carPlate: '01KG666BB',
        seatsCount: 4,
        licensePhotoPath: 'seed/driver6/license.jpg',
        carPassportPath: 'seed/driver6/passport.jpg',
        carPhotoPath: 'seed/driver6/car.jpg',
        selfiePath: 'seed/driver6/selfie.jpg',
        verificationStatus: 'verified',
        verifiedAt: new Date(),
        verifiedBy: adminId,
        totalTrips: 18,
        trips: 18,
      },
    ],
    [
      `${DEMO_PHONE_PREFIX}0007`,
      {
        userId: ids.get(`${DEMO_PHONE_PREFIX}0007`)!,
        carMake: 'Nissan', carModel: 'Tiida', carYear: 2014, carColor: 'Серебристый', carPlate: '01KG777CC',
        seatsCount: 4,
        licensePhotoPath: 'seed/driver7/license.jpg',
        carPassportPath: 'seed/driver7/passport.jpg',
        carPhotoPath: 'seed/driver7/car.jpg',
        selfiePath: 'seed/driver7/selfie.jpg',
        verificationStatus: 'verified',
        verifiedAt: new Date(),
        verifiedBy: adminId,
        totalTrips: 7,
        trips: 7,
      },
    ],
    [
      `${DEMO_PHONE_PREFIX}0008`,
      {
        userId: ids.get(`${DEMO_PHONE_PREFIX}0008`)!,
        carMake: 'Toyota', carModel: 'Corolla', carYear: 2020, carColor: 'Чёрный', carPlate: '01KG888DD',
        seatsCount: 4,
        licensePhotoPath: 'seed/driver8/license.jpg',
        carPassportPath: 'seed/driver8/passport.jpg',
        carPhotoPath: 'seed/driver8/car.jpg',
        selfiePath: 'seed/driver8/selfie.jpg',
        verificationStatus: 'verified',
        verifiedAt: new Date(),
        verifiedBy: adminId,
        totalTrips: 3,
        trips: 3,
      },
    ],
    // Pending verification — no role yet
    [
      `${DEMO_PHONE_PREFIX}0009`,
      {
        userId: ids.get(`${DEMO_PHONE_PREFIX}0009`)!,
        carMake: 'Lada', carModel: 'Granta', carYear: 2019, carColor: 'Красный', carPlate: '01KG999EE',
        seatsCount: 4,
        licensePhotoPath: 'seed/driver9/license.jpg',
        carPassportPath: 'seed/driver9/passport.jpg',
        carPhotoPath: 'seed/driver9/car.jpg',
        selfiePath: 'seed/driver9/selfie.jpg',
        verificationStatus: 'pending',
        // submittedAt is set by DB default; leave off verified_at/by
        trips: 0,
      },
    ],
    // Rejected — can resubmit
    [
      `${DEMO_PHONE_PREFIX}0010`,
      {
        userId: ids.get(`${DEMO_PHONE_PREFIX}0010`)!,
        carMake: 'Daewoo', carModel: 'Nexia', carYear: 2010, carColor: 'Белый', carPlate: '01KG101FF',
        seatsCount: 4,
        licensePhotoPath: 'seed/driver10/license.jpg',
        carPassportPath: 'seed/driver10/passport.jpg',
        carPhotoPath: 'seed/driver10/car.jpg',
        selfiePath: 'seed/driver10/selfie.jpg',
        verificationStatus: 'rejected',
        rejectionReason: 'Selfie does not match license photo',
        verifiedAt: new Date(),
        verifiedBy: adminId,
        trips: 0,
      },
    ],
  ];

  for (const [, p] of profiles) {
    const { trips: _trips, ...data } = p;
    void _trips;
    await prisma.driverProfile.create({ data });
  }
  console.warn(`[demo] ${profiles.length} driver profiles created`);
}

interface SeededTrip {
  id: string;
  driverId: string;
  origin: string;
  destination: string;
  status: 'active' | 'completed' | 'cancelled';
  price: number;
  seatsTotal: number;
  departureAt: Date;
}

async function seedTrips(ids: Map<string, string>): Promise<SeededTrip[]> {
  const now = Date.now();
  const day = 24 * 60 * 60_000;
  const driver5 = ids.get(`${DEMO_PHONE_PREFIX}0005`)!;
  const driver6 = ids.get(`${DEMO_PHONE_PREFIX}0006`)!;
  const driver7 = ids.get(`${DEMO_PHONE_PREFIX}0007`)!;
  const driver8 = ids.get(`${DEMO_PHONE_PREFIX}0008`)!;

  const rows: Array<Omit<SeededTrip, 'id'> & {
    seatsAvailable: number;
    duration: number;
    luggage: 'yes' | 'small' | 'no';
  }> = [
    // Driver 5 — active today + future + completed history
    { driverId: driver5, origin: 'Бишкек', destination: 'Ош',     status: 'active',   price: 1200, seatsTotal: 3, seatsAvailable: 2, departureAt: new Date(now + 2 * day), duration: 600, luggage: 'small' },
    { driverId: driver5, origin: 'Ош',      destination: 'Бишкек', status: 'completed', price: 1200, seatsTotal: 3, seatsAvailable: 0, departureAt: new Date(now - 5 * day), duration: 600, luggage: 'small' },
    { driverId: driver5, origin: 'Бишкек', destination: 'Ош',     status: 'completed', price: 1000, seatsTotal: 3, seatsAvailable: 0, departureAt: new Date(now - 14 * day), duration: 600, luggage: 'no'    },
    // Driver 6 — a Каракол route
    { driverId: driver6, origin: 'Бишкек', destination: 'Каракол', status: 'active',   price: 800,  seatsTotal: 4, seatsAvailable: 3, departureAt: new Date(now + day + 3 * 60 * 60_000), duration: 360, luggage: 'yes' },
    { driverId: driver6, origin: 'Каракол', destination: 'Бишкек', status: 'completed', price: 800,  seatsTotal: 4, seatsAvailable: 0, departureAt: new Date(now - 3 * day), duration: 360, luggage: 'no' },
    // Driver 7 — one cancelled
    { driverId: driver7, origin: 'Бишкек', destination: 'Нарын',  status: 'cancelled', price: 700,  seatsTotal: 3, seatsAvailable: 3, departureAt: new Date(now - 2 * day), duration: 300, luggage: 'no' },
    { driverId: driver7, origin: 'Бишкек', destination: 'Нарын',  status: 'active',   price: 700,  seatsTotal: 3, seatsAvailable: 2, departureAt: new Date(now + 3 * day), duration: 300, luggage: 'no' },
    // Driver 8 ("both") — one active, one completed
    { driverId: driver8, origin: 'Бишкек', destination: 'Чолпон-Ата', status: 'active', price: 600, seatsTotal: 4, seatsAvailable: 4, departureAt: new Date(now + 4 * day), duration: 240, luggage: 'small' },
    { driverId: driver8, origin: 'Чолпон-Ата', destination: 'Бишкек', status: 'completed', price: 600, seatsTotal: 4, seatsAvailable: 0, departureAt: new Date(now - 7 * day), duration: 240, luggage: 'small' },
  ];

  const created: SeededTrip[] = [];
  for (const r of rows) {
    const trip = await prisma.trip.create({
      data: {
        driverId: r.driverId,
        originCity: r.origin,
        destinationCity: r.destination,
        originAddress: 'Западный автовокзал',
        departureAt: r.departureAt,
        estimatedDurationMin: r.duration,
        seatsTotal: r.seatsTotal,
        seatsAvailable: r.seatsAvailable,
        pricePerSeat: r.price,
        luggage: r.luggage,
        status: r.status,
        preferences: { no_smoking: true } as Prisma.InputJsonValue,
        cancelledReason: r.status === 'cancelled' ? 'Driver changed plans' : null,
      },
    });
    created.push({
      id: trip.id,
      driverId: r.driverId,
      origin: r.origin,
      destination: r.destination,
      status: r.status,
      price: r.price,
      seatsTotal: r.seatsTotal,
      departureAt: r.departureAt,
    });
  }
  console.warn(`[demo] ${created.length} trips created`);
  return created;
}

async function seedBookingsAndChat(
  ids: Map<string, string>,
  trips: SeededTrip[],
): Promise<{ completedBookings: Array<{ tripId: string; passengerId: string; driverId: string }> }> {
  const p1 = ids.get(`${DEMO_PHONE_PREFIX}0001`)!;
  const p2 = ids.get(`${DEMO_PHONE_PREFIX}0002`)!;
  const p3 = ids.get(`${DEMO_PHONE_PREFIX}0003`)!;
  const p4 = ids.get(`${DEMO_PHONE_PREFIX}0004`)!;
  const pBoth = ids.get(`${DEMO_PHONE_PREFIX}0008`)!;

  const active = trips.filter((t) => t.status === 'active');
  const completed = trips.filter((t) => t.status === 'completed');

  const completedBookings: Array<{ tripId: string; passengerId: string; driverId: string }> = [];
  const now = new Date();

  // 1) A pending booking on the first active trip
  if (active[0]) {
    await prisma.booking.create({
      data: {
        tripId: active[0].id,
        passengerId: p1,
        seatsCount: 1,
        status: 'pending',
        comment: 'Поеду с одним небольшим рюкзаком',
        expiresAt: new Date(Date.now() + 45 * 60_000),
      },
    });
  }

  // 2) An accepted booking on the first active trip (with chat)
  if (active[0]) {
    const bk = await prisma.booking.create({
      data: {
        tripId: active[0].id,
        passengerId: p2,
        seatsCount: 1,
        status: 'accepted',
        comment: 'Встречусь у вокзала',
      },
    });
    const driver = active[0].driverId;
    await prisma.message.createMany({
      data: [
        { bookingId: bk.id, senderId: p2,     text: 'Здравствуйте! Где встречаемся?',       createdAt: new Date(now.getTime() - 60_000 * 30) },
        { bookingId: bk.id, senderId: driver, text: 'Привет! На западном вокзале, возле кассы № 3', createdAt: new Date(now.getTime() - 60_000 * 28) },
        { bookingId: bk.id, senderId: p2,     text: 'Понял, буду за 15 минут.',             createdAt: new Date(now.getTime() - 60_000 * 25) },
        { bookingId: bk.id, senderId: driver, text: 'Ок, поедем ровно в 09:00.',            createdAt: new Date(now.getTime() - 60_000 * 20), isRead: true, readAt: new Date(now.getTime() - 60_000 * 19) },
      ],
    });
  }

  // 3) A rejected booking
  if (active[1]) {
    await prisma.booking.create({
      data: {
        tripId: active[1].id,
        passengerId: p3,
        seatsCount: 3,
        status: 'rejected',
        comment: 'Семья с двумя детьми',
      },
    });
  }

  // 4) Accepted booking on Бишкек→Каракол
  if (active[1]) {
    await prisma.booking.create({
      data: {
        tripId: active[1].id,
        passengerId: p4,
        seatsCount: 1,
        status: 'accepted',
      },
    });
  }

  // 5) A booking by the "both" user as passenger
  if (active[2]) {
    await prisma.booking.create({
      data: {
        tripId: active[2].id,
        passengerId: pBoth,
        seatsCount: 1,
        status: 'pending',
        expiresAt: new Date(Date.now() + 15 * 60_000),
      },
    });
  }

  // 6) Completed bookings (with chat) → feed the ratings step
  for (const t of completed.slice(0, 3)) {
    // Two passengers on each completed trip
    for (const pid of [p1, p3]) {
      const bk = await prisma.booking.create({
        data: {
          tripId: t.id,
          passengerId: pid,
          seatsCount: 1,
          status: 'completed',
          createdAt: new Date(t.departureAt.getTime() - 24 * 60 * 60_000),
        },
      });
      await prisma.message.createMany({
        data: [
          { bookingId: bk.id, senderId: pid,       text: 'Привет! Всё в силе?', createdAt: new Date(t.departureAt.getTime() - 2 * 60 * 60_000) },
          { bookingId: bk.id, senderId: t.driverId, text: 'Да, встречаемся как договорились.', createdAt: new Date(t.departureAt.getTime() - 2 * 60 * 60_000 + 60_000) },
        ],
      });
      completedBookings.push({ tripId: t.id, passengerId: pid, driverId: t.driverId });
    }
  }

  // 7) A cancelled_late booking — passenger bailed <2h before
  if (active[0]) {
    await prisma.booking.create({
      data: {
        tripId: active[0].id,
        passengerId: p3,
        seatsCount: 1,
        status: 'cancelled_late',
        cancelledBy: 'passenger',
        cancelledAt: new Date(now.getTime() - 60 * 60_000),
        comment: 'Exit sample',
      },
    });
  }

  console.warn(
    `[demo] bookings seeded (pending, accepted+chat, rejected, completed+chat, cancelled_late)`,
  );
  return { completedBookings };
}

async function seedRatings(
  completed: Array<{ tripId: string; passengerId: string; driverId: string }>,
): Promise<void> {
  const now = new Date();
  // Drop one rating per (completedBooking) in each direction, with realistic
  // scores + tag mix. Updates users.rating + rating_count so "Новый" labels
  // disappear for the seeded drivers.
  type RatingRow = {
    tripId: string; raterId: string; rateeId: string;
    score: number; tags: string[]; comment?: string | null;
    createdAt?: Date;
  };
  const ratings: RatingRow[] = [];

  for (const b of completed) {
    // passenger → driver
    ratings.push({
      tripId: b.tripId,
      raterId: b.passengerId,
      rateeId: b.driverId,
      score: 4 + Math.floor(Math.random() * 2),
      tags: ['on_time', 'clean_car', 'pleasant_chat'],
      comment: 'Отличный водитель, поездка прошла комфортно.',
      createdAt: new Date(now.getTime() - Math.floor(Math.random() * 3 * 24 * 60 * 60_000)),
    });
    // driver → passenger
    ratings.push({
      tripId: b.tripId,
      raterId: b.driverId,
      rateeId: b.passengerId,
      score: 5,
      tags: ['arrived_on_time', 'polite'],
      comment: null,
      createdAt: new Date(now.getTime() - Math.floor(Math.random() * 3 * 24 * 60 * 60_000)),
    });
  }

  // Two low scores so the admin low-rating-review dashboard isn't empty.
  if (completed[0]) {
    ratings.push({
      tripId: completed[0].tripId,
      raterId: completed[0].passengerId,
      rateeId: completed[0].driverId,
      score: 2,
      tags: ['late', 'rudeness'],
      comment: 'Опоздал на 40 минут, был груб.',
      createdAt: new Date(now.getTime() - 2 * 24 * 60 * 60_000),
    });
  }

  for (const r of ratings) {
    try {
      await prisma.rating.create({ data: r });
    } catch {
      // Unique(trip,rater,ratee) — skip exact dup without noise.
    }
  }

  // Recompute every rated user's avg so the seeded ratings are visible.
  const rateeIds = Array.from(new Set(ratings.map((r) => r.rateeId)));
  for (const userId of rateeIds) {
    const all = await prisma.rating.findMany({
      where: { rateeId: userId },
      select: { score: true },
    });
    if (all.length === 0) continue;
    const avg = all.reduce((s, r) => s + r.score, 0) / all.length;
    await prisma.user.update({
      where: { id: userId },
      data: {
        rating: Math.round(avg * 100) / 100,
        ratingCount: all.length,
      },
    });
  }
  console.warn(`[demo] ${ratings.length} ratings seeded`);
}

async function seedComplaints(
  ids: Map<string, string>,
  adminId: string,
  trips: SeededTrip[],
): Promise<void> {
  const p1 = ids.get(`${DEMO_PHONE_PREFIX}0001`)!;
  const p4 = ids.get(`${DEMO_PHONE_PREFIX}0004`)!;
  const driver7 = ids.get(`${DEMO_PHONE_PREFIX}0007`)!;
  const blocked = ids.get(`${DEMO_PHONE_PREFIX}0011`)!;
  const cancelledTrip = trips.find((t) => t.status === 'cancelled');

  await prisma.complaint.createMany({
    data: [
      {
        reporterId: p1,
        targetUserId: driver7,
        category: 'safety',
        description: 'Водитель разговаривал по телефону за рулём на протяжении всей поездки.',
        status: 'new',
        createdAt: new Date(Date.now() - 2 * 60 * 60_000),
      },
      {
        reporterId: p4,
        targetTripId: cancelledTrip?.id ?? null,
        category: 'no_show',
        description: 'Водитель отменил поездку за 1 час до отправления без объяснения.',
        status: 'in_review',
      },
      {
        reporterId: p1,
        targetUserId: blocked,
        category: 'rudeness',
        description: 'Неуважительное общение во время поездки.',
        status: 'resolved',
        resolution: 'Пользователь предупреждён + оштрафован 7-дневным suspend',
        handledBy: adminId,
        resolvedAt: new Date(),
      },
    ],
  });
  console.warn('[demo] 3 complaints seeded (new / in_review / resolved)');
}

async function seedNotifications(ids: Map<string, string>): Promise<void> {
  const p1 = ids.get(`${DEMO_PHONE_PREFIX}0001`)!;
  const p2 = ids.get(`${DEMO_PHONE_PREFIX}0002`)!;
  const driver5 = ids.get(`${DEMO_PHONE_PREFIX}0005`)!;

  const now = Date.now();
  await prisma.notification.createMany({
    data: [
      {
        userId: p1,
        type: 'booking_accepted',
        channel: 'telegram',
        payload: { booking_preview: 'Бишкек → Ош, 20 апреля 09:00' },
        createdAt: new Date(now - 30 * 60_000),
      },
      {
        userId: p1,
        type: 'trip_reminder',
        channel: 'telegram',
        payload: { origin: 'Бишкек', destination: 'Ош', in_minutes: 120 },
        readAt: new Date(now - 20 * 60_000),
        delivered: true,
        createdAt: new Date(now - 2 * 60 * 60_000),
      },
      {
        userId: p2,
        type: 'new_message',
        channel: 'telegram',
        payload: { sender_name: 'Асан', preview: 'Привет! Где встречаемся?' },
        createdAt: new Date(now - 10 * 60_000),
      },
      {
        userId: driver5,
        type: 'new_booking_request',
        channel: 'telegram',
        payload: { passenger_name: 'Айбек', seats: 1 },
        createdAt: new Date(now - 15 * 60_000),
      },
      {
        userId: driver5,
        type: 'rating_received',
        channel: 'telegram',
        payload: { rater_name: 'Бегимай', score: 5 },
        createdAt: new Date(now - 3 * 24 * 60 * 60_000),
      },
    ],
  });
  console.warn('[demo] 5 notifications seeded');
}

async function seedAdminArtifacts(adminId: string): Promise<void> {
  // One extra regular admin so the Admin CRUD screen has more than just the
  // seeded superadmin. Email is deterministic — re-runs are idempotent via
  // findFirst guard.
  const email = 'ops@popytchik.kg';
  const existing = await prisma.admin.findUnique({ where: { email } });
  if (!existing) {
    await prisma.admin.create({
      data: {
        email,
        name: 'Дежурный администратор',
        role: 'admin',
        passwordHash: await bcrypt.hash('OpsPass12345', 4),
        mustChangePassword: false,
        isActive: true,
      },
    });
  }

  // A sample admin_actions row so the audit view isn't empty on first open.
  await prisma.adminAction.create({
    data: {
      adminId,
      action: 'verify_driver',
      targetType: 'driver',
      targetId: crypto.randomUUID(),
      details: { plate: '01KG555AA', note: 'Seeded sample audit entry' },
    },
  });
  console.warn('[demo] admin artifacts seeded');
}

// ─── Orchestration ─────────────────────────────────────────────────
async function main(): Promise<void> {
  if (!(await ensureDemoNotYetSeeded())) {
    await prisma.$disconnect();
    return;
  }

  // Pick an admin id for "verified_by" and audit rows — use the seeded
  // superadmin if present; otherwise any admin.
  const admin = await prisma.admin.findFirst({
    orderBy: { createdAt: 'asc' },
  });
  if (!admin) {
    console.error('[demo] No admin in DB. Run `npm run db:seed` first.');
    process.exit(1);
  }

  const userIds = await seedUsers();
  await seedDriverProfiles(userIds, admin.id);
  const trips = await seedTrips(userIds);
  const { completedBookings } = await seedBookingsAndChat(userIds, trips);
  await seedRatings(completedBookings);
  await seedComplaints(userIds, admin.id, trips);
  await seedNotifications(userIds);
  await seedAdminArtifacts(admin.id);

  console.warn('\n[demo] ✓ Done.');
  console.warn('[demo] Sample phone numbers (password: DemoPass12 when set):');
  for (const p of PERSONAS) {
    console.warn(
      `   ${p.phone}  ${p.name.padEnd(30)} ${p.roles.join('+').padEnd(16)}${p.hasPassword ? ' [has password]' : ''}${p.blocked ? ' [BLOCKED]' : ''}`,
    );
  }
  console.warn(
    '\n[demo] Tokens: `npm run dev:token -- <phone>` — minted exactly like OTP login.',
  );
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
