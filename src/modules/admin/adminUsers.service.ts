import type { Prisma, PrismaClient } from '@prisma/client';
import { Errors, publicPhone } from '@/lib/errors.js';
import { assertActiveUser } from '@/lib/assertUser.js';
import type { Notifier } from '@/lib/notifier.js';
import { cursorArgs, sliceAndNext, type CursorPaginationInput } from '@/lib/pagination.js';
import { writeAdminAction } from './admin.audit.js';
import { toFileUrl } from '@/lib/uploads.js';

export interface AdminUsersFilter extends CursorPaginationInput {
  q?: string;
  role?: 'passenger' | 'driver';
  blocked?: 'true' | 'false';
  sort: 'created_desc' | 'created_asc' | 'rating_desc' | 'rating_asc';
  registered_from?: string;
  registered_to?: string;
}

export interface AdminUserListItem {
  id: string;
  name: string;
  phone: string;
  roles: string[];
  language: string;
  phoneConfirmed: boolean;
  avatarUrl: string | null;
  rating: number | null;
  ratingCount: number;
  totalTrips: number | null;
  isBlocked: boolean;
  createdAt: Date;
  lastSeenAt: Date | null;
  complaintsCount: number;
}

export interface AdminUsersService {
  list(filter: AdminUsersFilter): Promise<{ data: AdminUserListItem[]; nextCursor: string | null }>;
  get(id: string): Promise<AdminUserDetail>;
  block(id: string, adminId: string, reason: string, ip?: string | null): Promise<AdminUserDetail>;
  unblock(id: string, adminId: string, ip?: string | null): Promise<AdminUserDetail>;
}

export interface AdminUserDetail extends AdminUserListItem {
  language: string;
  phoneVerifiedAt: Date | null;
  telegramId: string | null;
  blockedReason: string | null;
  deletedAt: Date | null;
  driverProfile: {
    verificationStatus: string;
    carPlate: string;
    totalTrips: number;
    cancellations30d: number;
  } | null;
  // Recent activity — the user's own trips (as driver) + requests (as passenger).
  trips: Array<{
    id: string;
    originCity: string;
    destinationCity: string;
    departureAt: Date;
    status: string;
    seatsAvailable: number;
    seatsTotal: number;
    pricePerSeat: number;
  }>;
  requests: Array<{
    id: string;
    originCity: string;
    destinationCity: string;
    departureDate: Date;
    status: string;
    seatsNeeded: number;
  }>;
}

export function createAdminUsersService(
  prisma: PrismaClient,
  notifier: Notifier,
): AdminUsersService {
  function orderBy(sort: AdminUsersFilter['sort']): Prisma.UserOrderByWithRelationInput {
    switch (sort) {
      case 'created_asc':
        return { createdAt: 'asc' };
      case 'rating_desc':
        return { rating: 'desc' };
      case 'rating_asc':
        return { rating: 'asc' };
      case 'created_desc':
      default:
        return { createdAt: 'desc' };
    }
  }

  async function list(
    filter: AdminUsersFilter,
  ): Promise<{ data: AdminUserListItem[]; nextCursor: string | null }> {
    const where: Prisma.UserWhereInput = { deletedAt: null };
    if (filter.q) {
      where.OR = [
        { name: { contains: filter.q, mode: 'insensitive' } },
        { phone: { contains: filter.q } },
      ];
    }
    if (filter.role) where.roles = { has: filter.role };
    if (filter.blocked === 'true') where.isBlocked = true;
    if (filter.blocked === 'false') where.isBlocked = false;
    if (filter.registered_from || filter.registered_to) {
      where.createdAt = {
        ...(filter.registered_from ? { gte: new Date(filter.registered_from) } : {}),
        ...(filter.registered_to ? { lte: new Date(filter.registered_to) } : {}),
      };
    }

    const rows = await prisma.user.findMany({
      where,
      orderBy: orderBy(filter.sort),
      ...cursorArgs(filter),
      include: {
        driverProfile: { select: { totalTrips: true } },
        _count: { select: { complaintsTargeting: true } },
      },
    });

    const mapped: AdminUserListItem[] = rows.map((u) => ({
      id: u.id,
      name: u.name,
      phone: publicPhone(u.phone),
      roles: u.roles,
      language: u.language,
      phoneConfirmed: u.phoneVerifiedAt !== null,
      avatarUrl: toFileUrl(u.avatarUrl),
      rating: u.ratingCount >= 3 ? Number(u.rating) : null,
      ratingCount: u.ratingCount,
      totalTrips: u.driverProfile?.totalTrips ?? null,
      isBlocked: u.isBlocked,
      createdAt: u.createdAt,
      lastSeenAt: u.lastSeenAt,
      complaintsCount: u._count.complaintsTargeting,
    }));

    return sliceAndNext(mapped, filter.limit);
  }

  async function get(id: string): Promise<AdminUserDetail> {
    const u = await prisma.user.findUnique({
      where: { id },
      include: {
        driverProfile: true,
        _count: { select: { complaintsTargeting: true } },
        tripsAsDriver: {
          orderBy: { createdAt: 'desc' },
          take: 10,
          select: {
            id: true, originCity: true, destinationCity: true, departureAt: true,
            status: true, seatsAvailable: true, seatsTotal: true, pricePerSeat: true,
          },
        },
        passengerRequests: {
          orderBy: { createdAt: 'desc' },
          take: 10,
          select: {
            id: true, originCity: true, destinationCity: true, departureDate: true,
            status: true, seatsNeeded: true,
          },
        },
      },
    });
    if (!u) throw Errors.notFound('User');
    return {
      id: u.id,
      name: u.name,
      phone: publicPhone(u.phone),
      roles: u.roles,
      rating: u.ratingCount >= 3 ? Number(u.rating) : null,
      ratingCount: u.ratingCount,
      totalTrips: u.driverProfile?.totalTrips ?? null,
      isBlocked: u.isBlocked,
      createdAt: u.createdAt,
      complaintsCount: u._count.complaintsTargeting,
      language: u.language,
      phoneConfirmed: u.phoneVerifiedAt !== null,
      avatarUrl: toFileUrl(u.avatarUrl),
      lastSeenAt: u.lastSeenAt,
      phoneVerifiedAt: u.phoneVerifiedAt,
      telegramId: u.telegramId ? u.telegramId.toString() : null,
      blockedReason: u.blockedReason,
      deletedAt: u.deletedAt,
      driverProfile: u.driverProfile
        ? {
            verificationStatus: u.driverProfile.verificationStatus,
            carPlate: u.driverProfile.carPlate,
            totalTrips: u.driverProfile.totalTrips,
            cancellations30d: u.driverProfile.cancellations30d,
          }
        : null,
      trips: u.tripsAsDriver,
      requests: u.passengerRequests,
    };
  }

  async function block(
    id: string,
    adminId: string,
    reason: string,
    ip?: string | null,
  ): Promise<AdminUserDetail> {
    const updated = await prisma.$transaction(async (tx) => {
      await assertActiveUser(id, tx);
      await tx.user.update({
        where: { id },
        data: { isBlocked: true, blockedReason: reason },
      });
      // Revoke any active refresh tokens — blocked user shouldn't keep sessions.
      await tx.refreshToken.updateMany({
        where: { userId: id, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      return id;
    });

    await writeAdminAction(prisma, {
      adminId,
      action: 'block_user',
      targetId: updated,
      targetType: 'user',
      details: { reason },
      ipAddress: ip ?? null,
    });

    await notifier.accountBlocked(id, { reason });

    return get(id);
  }

  async function unblock(
    id: string,
    adminId: string,
    ip?: string | null,
  ): Promise<AdminUserDetail> {
    const user = await prisma.user.findUnique({ where: { id } });
    if (!user || user.deletedAt) throw Errors.notFound('User');
    await prisma.user.update({
      where: { id },
      data: { isBlocked: false, blockedReason: null },
    });

    await writeAdminAction(prisma, {
      adminId,
      action: 'unblock_user',
      targetId: id,
      targetType: 'user',
      ipAddress: ip ?? null,
    });

    return get(id);
  }

  return { list, get, block, unblock };
}
