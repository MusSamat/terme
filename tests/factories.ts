import bcrypt from 'bcryptjs';
import type { PrismaClient } from '@prisma/client';
import {
  signAccessToken,
  signAdminAccessToken,
  signRefreshToken,
  refreshTtlSeconds,
} from '@/lib/jwt.js';
import { generateUuid, sha256Hex } from '@/lib/random.js';
import { NoopNotifier, type Notifier } from '@/lib/notifier.js';
import { CITY } from './cities.js';

export { CITY };

/**
 * Lightweight factories for tests — bypass the public auth flow when we just
 * need a token. Each factory returns everything the caller might want so we
 * don't need mock-like helpers.
 */

export async function createUser(
  prisma: PrismaClient,
  overrides: Partial<{
    phone: string;
    name: string;
    roles: string[];
    language: 'ru' | 'kg';
    phoneVerified: boolean;
    telegramId: bigint;
  }> = {},
): Promise<{ id: string; accessToken: string; refreshToken: string; phone: string }> {
  const phone = overrides.phone ?? `+996700${Math.floor(Math.random() * 900_000 + 100_000)}`;
  const user = await prisma.user.create({
    data: {
      phone,
      name: overrides.name ?? 'Test User',
      language: overrides.language ?? 'ru',
      roles: overrides.roles ?? ['passenger'],
      phoneVerifiedAt: overrides.phoneVerified === false ? null : new Date(),
      telegramId: overrides.telegramId ?? null,
    },
  });
  const accessToken = signAccessToken({
    sub: user.id,
    phone: user.phone,
    roles: user.roles as ('passenger' | 'driver' | 'admin' | 'superadmin')[],
  });
  const ttl = refreshTtlSeconds();
  const tokenId = generateUuid();
  const refreshToken = signRefreshToken({ sub: user.id, tokenId }, ttl);
  await prisma.refreshToken.create({
    data: {
      id: tokenId,
      userId: user.id,
      tokenHash: sha256Hex(refreshToken),
      expiresAt: new Date(Date.now() + ttl * 1000),
    },
  });
  return { id: user.id, accessToken, refreshToken, phone };
}

export async function createAdmin(
  prisma: PrismaClient,
  overrides: Partial<{
    email: string;
    role: 'admin' | 'superadmin';
    password: string;
  }> = {},
): Promise<{ id: string; accessToken: string; email: string; role: 'admin' | 'superadmin' }> {
  const email = overrides.email ?? `admin_${Math.floor(Math.random() * 1e6)}@popytchik.kg`;
  const role = overrides.role ?? 'admin';
  const password = overrides.password ?? 'TestPass1234!';
  const admin = await prisma.admin.create({
    data: {
      email,
      name: 'Test Admin',
      role,
      isActive: true,
      passwordHash: await bcrypt.hash(password, 4),
    },
  });
  const accessToken = signAdminAccessToken({
    sub: admin.id,
    email: admin.email,
    role: admin.role as 'admin' | 'superadmin',
  });
  return { id: admin.id, accessToken, email, role };
}

/**
 * Minimal valid JPEG buffer — magic bytes plus a real SOF0 frame so the
 * dimension reader (TZ §9.1 min 800×600 check) can parse width/height.
 * Defaults to 1024×768 (passes the doc-photo minimum).
 */
export function jpegBuffer(width = 1024, height = 768): Buffer {
  const sof = Buffer.alloc(11);
  sof[0] = 0xff;
  sof[1] = 0xc0; // SOF0 marker
  sof.writeUInt16BE(0x0011, 2); // segment length (17)
  sof[4] = 0x08; // sample precision
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  sof[9] = 0x03; // component count (filler — enough for the header parser)
  // Bytes are FF D8 FF C0 … so the first three still match JPEG magic.
  return Buffer.concat([Buffer.from([0xff, 0xd8]), sof, Buffer.alloc(200)]);
}

/** Below the 800×600 document minimum — for negative verification tests. */
export function smallJpegBuffer(): Buffer {
  return jpegBuffer(320, 240);
}

/**
 * Create a verified driver — user with driver role + a verified driver_profile.
 * Skips the multipart upload flow that the real submit goes through.
 */
export async function createVerifiedDriver(
  prisma: PrismaClient,
  overrides: Partial<{
    plate: string;
    seatsCount: number;
    name: string;
  }> = {},
): Promise<{
  id: string;
  accessToken: string;
  refreshToken: string;
  phone: string;
  driverProfileId: string;
}> {
  const base = await createUser(prisma, {
    name: overrides.name ?? 'Test Driver',
    roles: ['passenger', 'driver'],
  });
  const dp = await prisma.driverProfile.create({
    data: {
      userId: base.id,
      carMake: 'Toyota',
      carModel: 'Camry',
      carYear: 2015,
      carColor: 'White',
      carPlate: overrides.plate ?? `D${Math.floor(Math.random() * 900_000 + 100_000)}`,
      seatsCount: overrides.seatsCount ?? 4,
      licensePhotoPath: 'seed/license.jpg',
      carPassportPath: 'seed/passport.jpg',
      carPhotoPath: 'seed/car.jpg',
      selfiePath: 'seed/selfie.jpg',
      verificationStatus: 'verified',
      verifiedAt: new Date(),
    },
  });
  // Phase 1: publishing is gated by a garage car (cars table), not the profile.
  await prisma.car.create({
    data: {
      userId: base.id,
      make: 'Toyota',
      model: 'Camry',
      color: 'White',
      plate: overrides.plate ?? `D${Math.floor(Math.random() * 900_000 + 100_000)}`,
      seatsCount: overrides.seatsCount ?? 4,
    },
  });
  return { ...base, driverProfileId: dp.id };
}

/**
 * Create an active trip owned by the given driver.
 */
export async function createTrip(
  prisma: PrismaClient,
  driverId: string,
  overrides: Partial<{
    seatsTotal: number;
    seatsAvailable: number;
    pricePerSeat: number;
    departureAt: Date;
    status: string;
  }> = {},
): Promise<{ id: string }> {
  const trip = await prisma.trip.create({
    data: {
      driverId,
      originCityId: CITY['Бишкек'],
      destinationCityId: CITY['Ош'],
      originCity: 'Бишкек',
      destinationCity: 'Ош',
      originAddress: 'Бишкек, Западный автовокзал',
      // Randomise day offset (1–365) to avoid idx_trips_one_active_per_day unique
      // constraint when a test creates multiple trips for the same driver.
      departureAt:
        overrides.departureAt ??
        new Date(Date.now() + (1 + Math.floor(Math.random() * 365)) * 24 * 60 * 60_000),
      estimatedDurationMin: 360,
      pricePerSeat: overrides.pricePerSeat ?? 1000,
      seatsTotal: overrides.seatsTotal ?? 3,
      seatsAvailable: overrides.seatsAvailable ?? overrides.seatsTotal ?? 3,
      status: overrides.status ?? 'active',
    },
  });
  return { id: trip.id };
}

/**
 * Create a booking in any status. Defaults to pending.
 */
export async function createBooking(
  prisma: PrismaClient,
  passengerId: string,
  tripId: string,
  overrides: Partial<{
    seatsCount: number;
    status: string;
    viewedAt: Date | null;
    expiresAt: Date;
  }> = {},
): Promise<{ id: string }> {
  const booking = await prisma.booking.create({
    data: {
      passengerId,
      tripId,
      seatsCount: overrides.seatsCount ?? 1,
      status: overrides.status ?? 'pending',
      viewedAt: overrides.viewedAt ?? null,
      expiresAt: overrides.expiresAt ?? new Date(Date.now() + 60 * 60_000),
    },
  });
  return { id: booking.id };
}

/**
 * Creates a Notifier with all methods noop-ed except those explicitly provided.
 * Avoids the class-spread pitfall (prototype methods don't copy via {...noop}).
 */
export function makeNotifier(overrides: Partial<Notifier> = {}): Notifier {
  const base = new NoopNotifier();
  return new Proxy(base, {
    get(target, prop) {
      const key = prop as keyof Notifier;
      if (key in overrides) return overrides[key];
      const val = target[key];
      return typeof val === 'function' ? val.bind(target) : val;
    },
  }) as unknown as Notifier;
}

/**
 * Kept for older tests: the directory is now loaded by migrations and never
 * truncated, so there is nothing to seed.
 */
export async function seedLaunchCities(_prisma: PrismaClient): Promise<void> {}
