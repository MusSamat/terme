import type { PrismaClient, Prisma } from '@prisma/client';
import { Errors, publicPhone } from '@/lib/errors.js';
import { cursorArgs, sliceAndNext } from '@/lib/pagination.js';
import type { CursorPaginationInput } from '@/lib/pagination.js';
import { writeAdminAction } from './admin.audit.js';
import type { Notifier } from '@/lib/notifier.js';

export interface AdminTripItem {
  id: string;
  originCity: string;
  destinationCity: string;
  departureAt: Date;
  status: string;
  pricePerSeat: number;
  seatsTotal: number;
  seatsAvailable: number;
  bookingsCount: number;
  cancelledReason: string | null;
  driver: { id: string; name: string; phone: string };
  createdAt: Date;
}

export interface AdminTripDetail extends AdminTripItem {
  originAddress: string | null;
  comment: string | null;
  driverProfile: {
    verificationStatus: string;
    carPlate: string;
    carMake: string;
    carModel: string;
    carYear: number;
    carColor: string;
  } | null;
  bookings: Array<{
    id: string;
    passengerId: string;
    passengerName: string;
    passengerPhone: string;
    status: string;
    seatsCount: number;
    createdAt: Date;
  }>;
}

export interface AdminTripsService {
  listTrips(
    filter: CursorPaginationInput & { status?: string; from?: string; to?: string },
  ): Promise<{ data: AdminTripItem[]; nextCursor: string | null }>;
  getTripDetail(id: string): Promise<AdminTripDetail>;
  forceCancel(
    tripId: string,
    adminId: string,
    reason: string,
    ip?: string | null,
  ): Promise<{ status: 'cancelled'; affectedPassengers: number }>;
}

export function createAdminTripsService(
  prisma: PrismaClient,
  notifier: Notifier,
): AdminTripsService {
  async function listTrips(
    filter: CursorPaginationInput & { status?: string; from?: string; to?: string },
  ): Promise<{ data: AdminTripItem[]; nextCursor: string | null }> {
    const where: Prisma.TripWhereInput = {};
    if (filter.status && filter.status !== 'all') where.status = filter.status;
    if (filter.from) where.originCity = { contains: filter.from, mode: 'insensitive' };
    if (filter.to) where.destinationCity = { contains: filter.to, mode: 'insensitive' };

    const rows = await prisma.trip.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      ...cursorArgs(filter),
      include: {
        driver: { select: { id: true, name: true, phone: true } },
        _count: {
          select: {
            bookings: { where: { status: { in: ['pending', 'accepted'] } } },
          },
        },
      },
    });

    const mapped: AdminTripItem[] = rows.map((t) => ({
      id: t.id,
      originCity: t.originCity,
      destinationCity: t.destinationCity,
      departureAt: t.departureAt,
      status: t.status,
      pricePerSeat: t.pricePerSeat,
      seatsTotal: t.seatsTotal,
      seatsAvailable: t.seatsAvailable,
      bookingsCount: t._count.bookings,
      cancelledReason: t.cancelledReason,
      driver: { id: t.driver.id, name: t.driver.name, phone: publicPhone(t.driver.phone) },
      createdAt: t.createdAt,
    }));

    return sliceAndNext(mapped, filter.limit);
  }

  async function getTripDetail(id: string): Promise<AdminTripDetail> {
    const trip = await prisma.trip.findUnique({
      where: { id },
      include: {
        driver: {
          select: {
            id: true,
            name: true,
            phone: true,
            driverProfile: {
              select: {
                verificationStatus: true,
                carPlate: true,
                carMake: true,
                carModel: true,
                carYear: true,
                carColor: true,
              },
            },
          },
        },
        bookings: {
          include: {
            passenger: { select: { id: true, name: true, phone: true } },
          },
          orderBy: { createdAt: 'desc' },
        },
      },
    });

    if (!trip) throw Errors.notFound('Trip');

    return {
      id: trip.id,
      originCity: trip.originCity,
      destinationCity: trip.destinationCity,
      originAddress: trip.originAddress,
      departureAt: trip.departureAt,
      status: trip.status,
      pricePerSeat: trip.pricePerSeat,
      seatsTotal: trip.seatsTotal,
      seatsAvailable: trip.seatsAvailable,
      comment: trip.comment,
      bookingsCount: trip.bookings.filter((b) =>
        ['pending', 'accepted'].includes(b.status),
      ).length,
      cancelledReason: trip.cancelledReason,
      driver: {
        id: trip.driver.id,
        name: trip.driver.name,
        phone: publicPhone(trip.driver.phone),
      },
      driverProfile: trip.driver.driverProfile ?? null,
      bookings: trip.bookings.map((b) => ({
        id: b.id,
        passengerId: b.passengerId,
        passengerName: b.passenger.name,
        passengerPhone: publicPhone(b.passenger.phone),
        status: b.status,
        seatsCount: b.seatsCount,
        createdAt: b.createdAt,
      })),
      createdAt: trip.createdAt,
    };
  }

  async function forceCancel(
    tripId: string,
    adminId: string,
    reason: string,
    ip?: string | null,
  ): Promise<{ status: 'cancelled'; affectedPassengers: number }> {
    const trip = await prisma.trip.findUnique({ where: { id: tripId } });
    if (!trip) throw Errors.notFound('Trip');
    if (trip.status !== 'active') {
      throw Errors.conflict('Trip not active', { current_status: trip.status });
    }

    const passengerIds = await prisma.$transaction(async (tx) => {
      await tx.trip.update({
        where: { id: tripId },
        data: {
          status: 'cancelled',
          cancelledReason: `[ADMIN] ${reason}`,
          version: { increment: 1 },
        },
      });
      const affected = await tx.booking.findMany({
        where: { tripId, status: { in: ['pending', 'accepted'] } },
        select: { passengerId: true },
      });
      await tx.booking.updateMany({
        where: { tripId, status: { in: ['pending', 'accepted'] } },
        data: {
          status: 'cancelled_by_driver', // closest match — admin cancel counts as driver-side
          cancelledBy: 'driver',
          cancelledAt: new Date(),
        },
      });
      return affected.map((a) => a.passengerId);
    });

    const publicTrip = {
      id: trip.id,
      driverId: trip.driverId,
      originCity: trip.originCity,
      destinationCity: trip.destinationCity,
      departureAt: trip.departureAt,
    };
    await Promise.all(
      passengerIds.map((pid) => notifier.tripCancelled(pid, { trip: publicTrip })),
    );

    await writeAdminAction(prisma, {
      adminId,
      action: 'force_cancel_trip',
      targetId: tripId,
      targetType: 'trip',
      details: { reason, affected: passengerIds.length },
      ipAddress: ip ?? null,
    });

    return { status: 'cancelled', affectedPassengers: passengerIds.length };
  }

  return { listTrips, getTripDetail, forceCancel };
}
