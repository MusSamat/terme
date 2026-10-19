import type { PrismaClient } from '@prisma/client';
import crypto from 'node:crypto';
import { Errors, publicPhone } from '@/lib/errors.js';
import { persistImage, removeImage, toFileUrl } from '@/lib/uploads.js';

/**
 * Users service — /users/me and /users/:id logic. Keeps presentation logic
 * (what to expose publicly vs to self) centralized.
 */

export interface DriverCarPublic {
  make: string;
  model: string;
  year: number;
  color: string;
  plate: string;
  seats: number;
  carPhotoUrl: string | null;
  totalTrips: number;
}

export interface PublicUser {
  id: string;
  name: string;
  avatarUrl: string | null;
  roles: string[];
  rating: number | null;
  ratingCount: number;
  loyaltyTier: string;
  createdAt: Date;
  // Only present for verified drivers — undefined for passengers
  driverCar: DriverCarPublic | null;
}

export interface SelfUser extends PublicUser {
  surname: string | null;
  preferredMode: 'passenger' | 'driver';
  // Web sign-in uses a password; false → offer «set a password» (WhatsApp code).
  hasPassword: boolean;
  phone: string;
  phoneVerified: boolean;
  telegramLinked: boolean;
  language: string;
  notificationsEnabled: boolean;
  termsAcceptedAt: Date | null;
  loyaltyPoints: number;
  bio: string | null;
  lastSeenAt: Date | null;
}

export interface UpdateSelfPatch {
  name?: string;
  surname?: string;
  language?: 'ru' | 'kg';
  bio?: string;
  termsAccepted?: true;
  preferredMode?: 'passenger' | 'driver';
  notificationsEnabled?: boolean;
}

export interface UsersService {
  getSelf(userId: string): Promise<SelfUser>;
  updateSelf(
    userId: string,
    patch: UpdateSelfPatch,
  ): Promise<SelfUser>;
  deleteSelf(userId: string): Promise<void>;
  getPublicProfile(userId: string): Promise<PublicUser>;
  listRatings(
    userId: string,
    limit: number,
    cursor?: string,
  ): Promise<{ data: RatingPublic[]; nextCursor: string | null }>;
  setAvatar(userId: string, file: Express.Multer.File): Promise<{ avatarUrl: string }>;
  exportData(userId: string): Promise<DataExport>;
}

// TZ §24.4 "Право на портабельность". A single JSON blob the user can download
// and take anywhere.
export interface DataExport {
  generated_at: string;
  user: Record<string, unknown>;
  trips: Array<Record<string, unknown>>;
  bookings: Array<Record<string, unknown>>;
  ratings_given: Array<Record<string, unknown>>;
  ratings_received: Array<Record<string, unknown>>;
  messages: Array<Record<string, unknown>>;
  complaints_filed: Array<Record<string, unknown>>;
}

export interface RatingPublic {
  id: string;
  score: number;
  tags: string[];
  comment: string | null;
  createdAt: Date;
  rater: { id: string; name: string; avatarUrl: string | null };
}

export function createUsersService(prisma: PrismaClient): UsersService {
  async function findActiveUser(userId: string) {
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user || user.deletedAt) throw Errors.notFound('User');
    if (user.isBlocked) throw Errors.forbidden({ reason: 'blocked' });
    return user;
  }

  function toSelf(
    user: Awaited<ReturnType<typeof findActiveUser>>,
  ): SelfUser {
    return {
      id: user.id,
      name: user.name,
      avatarUrl: toFileUrl(user.avatarUrl),
      roles: user.roles,
      rating: user.ratingCount >= 3 ? Number(user.rating) : null,
      ratingCount: user.ratingCount,
      loyaltyTier: user.loyaltyTier,
      loyaltyPoints: user.loyaltyPoints,
      createdAt: user.createdAt,
      driverCar: null, // not needed for self view; use GET /users/:id for full profile
      surname: user.surname,
      preferredMode: user.preferredMode === 'driver' ? 'driver' : 'passenger',
      hasPassword: user.passwordHash !== null,
      phone: publicPhone(user.phone),
      phoneVerified: user.phoneVerifiedAt !== null,
      telegramLinked: user.telegramId !== null,
      language: user.language,
      notificationsEnabled: user.notificationsEnabled,
      termsAcceptedAt: user.termsAcceptedAt,
      bio: user.bio,
      lastSeenAt: user.lastSeenAt,
    };
  }

  async function getSelf(userId: string): Promise<SelfUser> {
    const user = await findActiveUser(userId);
    return toSelf(user);
  }

  async function updateSelf(userId: string, patch: UpdateSelfPatch): Promise<SelfUser> {
    await findActiveUser(userId);
    const data: Parameters<typeof prisma.user.update>[0]['data'] = {};
    if (patch.name !== undefined) data.name = patch.name;
    if (patch.surname !== undefined) data.surname = patch.surname.length > 0 ? patch.surname : null;
    if (patch.preferredMode !== undefined) data.preferredMode = patch.preferredMode;
    if (patch.language !== undefined) data.language = patch.language;
    if (patch.bio !== undefined) data.bio = patch.bio.length > 0 ? patch.bio : null;
    if (patch.termsAccepted === true) data.termsAcceptedAt = new Date();
    if (patch.notificationsEnabled !== undefined) data.notificationsEnabled = patch.notificationsEnabled;
    const updated = await prisma.user.update({ where: { id: userId }, data });
    return toSelf(updated);
  }

  /**
   * Soft delete per TZ §24.3: nullify PII, keep the row for 30 days so cron
   * can hard-delete. Preserves chat history / trip stats (obfuscated by name
   * swap). Revokes all refresh tokens immediately so the client can't continue
   * using the account.
   */
  async function deleteSelf(userId: string): Promise<void> {
    const user = await findActiveUser(userId);
    const now = new Date();

    // `phone` is VARCHAR(20) + UNIQUE, so we pack the tombstone into ≤20 chars:
    // "+del:" (5) + 12 hex = 17 chars. 2^48 space is ample for collision safety
    // against every soft-deleted user ever.
    const tombstonePhone = `+del:${crypto.randomBytes(6).toString('hex')}`;

    await prisma.$transaction([
      prisma.user.update({
        where: { id: userId },
        data: {
          name: 'Удалённый пользователь',
          phone: tombstonePhone,
          telegramId: null,
          avatarUrl: null,
          deletedAt: now,
        },
      }),
      prisma.refreshToken.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: now },
      }),
    ]);

    if (user.avatarUrl) await removeImage(user.avatarUrl);
  }

  async function getPublicProfile(userId: string): Promise<PublicUser> {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: {
        driverProfile: {
          select: {
            verificationStatus: true,
            carMake: true,
            carModel: true,
            carYear: true,
            carColor: true,
            carPlate: true,
            seatsCount: true,
            carPhotoPath: true,
            totalTrips: true,
          },
        },
      },
    });
    if (!user || user.deletedAt) throw Errors.notFound('User'); // public profile — blocked users still visible

    const dp = user.driverProfile;
    const driverCar =
      dp && dp.verificationStatus === 'verified'
        ? {
            make: dp.carMake,
            model: dp.carModel,
            year: dp.carYear,
            color: dp.carColor,
            plate: dp.carPlate,
            seats: dp.seatsCount,
            carPhotoUrl: toFileUrl(dp.carPhotoPath),
            totalTrips: dp.totalTrips,
          }
        : null;

    return {
      id: user.id,
      name: user.name,
      avatarUrl: toFileUrl(user.avatarUrl),
      roles: user.roles,
      // TZ §14.3 — hide rating until ≥3 ratings collected (show "Новый" on client).
      rating: user.ratingCount >= 3 ? Number(user.rating) : null,
      ratingCount: user.ratingCount,
      loyaltyTier: user.loyaltyTier,
      createdAt: user.createdAt,
      driverCar,
    };
  }

  async function listRatings(
    userId: string,
    limit: number,
    cursor?: string,
  ): Promise<{ data: RatingPublic[]; nextCursor: string | null }> {
    const take = limit + 1; // fetch one extra to know if there's a next page
    const rows = await prisma.rating.findMany({
      where: { rateeId: userId },
      orderBy: { createdAt: 'desc' },
      take,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      include: {
        rater: { select: { id: true, name: true, avatarUrl: true, deletedAt: true } },
      },
    });
    const hasMore = rows.length > limit;
    const slice = hasMore ? rows.slice(0, limit) : rows;
    return {
      data: slice.map((r) => ({
        id: r.id,
        score: r.score,
        tags: r.tags,
        comment: r.comment,
        createdAt: r.createdAt,
        rater: {
          id: r.rater.id,
          name: r.rater.deletedAt ? 'Удалённый пользователь' : r.rater.name,
          avatarUrl: r.rater.deletedAt ? null : toFileUrl(r.rater.avatarUrl),
        },
      })),
      nextCursor: hasMore ? slice[slice.length - 1]!.id : null,
    };
  }

  async function setAvatar(
    userId: string,
    file: Express.Multer.File,
  ): Promise<{ avatarUrl: string }> {
    const user = await findActiveUser(userId);
    const stored = await persistImage(file, 'avatars');
    await prisma.user.update({
      where: { id: userId },
      data: { avatarUrl: stored.path },
    });
    // Remove the old avatar file after the new one is safely persisted.
    if (user.avatarUrl && user.avatarUrl !== stored.path) {
      await removeImage(user.avatarUrl);
    }
    return { avatarUrl: toFileUrl(stored.path)! };
  }

  // ─── GDPR export (TZ §24.4) ─────────────────────────────────────────
  async function exportData(userId: string): Promise<DataExport> {
    const user = await findActiveUser(userId);

    // The user's own doc photos, license plate, and selfies aren't included —
    // they belong to their driver_profile which is sensitive per Law 58 and
    // also exists primarily for admin verification. Business data (trips,
    // bookings, ratings, chats, complaints) is fair game.
    const [trips, bookings, ratingsGiven, ratingsReceived, messages, complaints] =
      await Promise.all([
        prisma.trip.findMany({ where: { driverId: userId } }),
        prisma.booking.findMany({ where: { passengerId: userId } }),
        prisma.rating.findMany({ where: { raterId: userId } }),
        prisma.rating.findMany({ where: { rateeId: userId } }),
        prisma.message.findMany({ where: { senderId: userId } }),
        prisma.complaint.findMany({ where: { reporterId: userId } }),
      ]);

    return {
      generated_at: new Date().toISOString(),
      user: {
        id: user.id,
        phone: publicPhone(user.phone),
        name: user.name,
        language: user.language,
        roles: user.roles,
        rating: user.ratingCount >= 3 ? Number(user.rating) : null,
        rating_count: user.ratingCount,
        terms_accepted_at: user.termsAcceptedAt,
        created_at: user.createdAt,
      },
      trips: trips.map((t) => ({
        id: t.id,
        origin_city: t.originCity,
        destination_city: t.destinationCity,
        departure_at: t.departureAt,
        status: t.status,
        price_per_seat: t.pricePerSeat,
        seats_total: t.seatsTotal,
      })),
      bookings: bookings.map((b) => ({
        id: b.id,
        trip_id: b.tripId,
        seats_count: b.seatsCount,
        status: b.status,
        created_at: b.createdAt,
      })),
      ratings_given: ratingsGiven.map((r) => ({
        trip_id: r.tripId,
        ratee_id: r.rateeId,
        score: r.score,
        tags: r.tags,
        comment: r.comment,
        created_at: r.createdAt,
      })),
      ratings_received: ratingsReceived.map((r) => ({
        trip_id: r.tripId,
        score: r.score,
        tags: r.tags,
        comment: r.comment,
        created_at: r.createdAt,
      })),
      messages: messages.map((m) => ({
        booking_id: m.bookingId,
        text: m.text,
        created_at: m.createdAt,
      })),
      complaints_filed: complaints.map((c) => ({
        id: c.id,
        category: c.category,
        description: c.description,
        status: c.status,
        created_at: c.createdAt,
        resolved_at: c.resolvedAt,
      })),
    };
  }

  return {
    getSelf,
    updateSelf,
    deleteSelf,
    getPublicProfile,
    listRatings,
    setAvatar,
    exportData,
  };
}
