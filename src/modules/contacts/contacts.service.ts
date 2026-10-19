import type { Prisma, PrismaClient } from '@prisma/client';
import { env } from '@/config/env.js';
import { Errors, publicPhone } from '@/lib/errors.js';

/**
 * Phone reveal («Позвонить») — call-first marketplace flow. A logged-in user
 * taps the button and gets the counterparty's phone immediately, no booking
 * required. Every reveal is audited in contact_reveals; a daily cap on the
 * number of DISTINCT people revealed stops scrapers while never bothering real
 * users (re-revealing someone already shown today is free).
 */

export interface RevealedContact {
  phone: string;
  name: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export function createContactsService(prisma: PrismaClient) {
  // New (young or never travelled) accounts get the lower cap — fresh
  // throwaway accounts are the harvesting vector.
  async function dailyCap(tx: Prisma.TransactionClient, viewerId: string): Promise<number> {
    const viewer = await tx.user.findUnique({ where: { id: viewerId }, select: { createdAt: true } });
    const young =
      !viewer || Date.now() - viewer.createdAt.getTime() < env.CONTACT_NEW_ACCOUNT_DAYS * DAY_MS;
    if (young) return env.CONTACT_NEW_ACCOUNT_DAILY_CAP;
    const travelled = await tx.booking.findFirst({
      where: {
        status: 'completed',
        OR: [{ passengerId: viewerId }, { trip: { driverId: viewerId } }],
      },
      select: { id: true },
    });
    return travelled ? env.CONTACT_DAILY_CAP : env.CONTACT_NEW_ACCOUNT_DAILY_CAP;
  }

  // M4: check + insert under a per-viewer advisory lock so parallel taps can't
  // all slip under the cap (it used to be check-then-insert).
  async function auditWithinLimit(
    viewerId: string,
    targetUserId: string,
    contextType: 'trip' | 'passenger_request',
    contextId: string,
  ): Promise<void> {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${viewerId}))`;
      const since = new Date(Date.now() - DAY_MS);
      const seen = await tx.contactReveal.findMany({
        where: { viewerId, createdAt: { gte: since } },
        distinct: ['targetUserId'],
        select: { targetUserId: true },
      });
      const alreadyRevealed = seen.some((r) => r.targetUserId === targetUserId);
      if (!alreadyRevealed) {
        const cap = await dailyCap(tx, viewerId);
        if (seen.length >= cap) {
          throw Errors.contactLimit({ reason: 'contact_reveal_daily_limit', limit: cap });
        }
      }
      // Early stage: EVERY tap is a row — repeat reveals inflate the owner's
      // counter deliberately (only distinct people count toward the cap).
      await tx.contactReveal.create({ data: { viewerId, targetUserId, contextType, contextId } });
    });
  }

  /** Driver's phone for an active trip. */
  async function revealForTrip(tripId: string, viewerId: string): Promise<RevealedContact> {
    const trip = await prisma.trip.findUnique({
      where: { id: tripId },
      select: {
        status: true,
        driverId: true,
        driver: { select: { phone: true, name: true } },
      },
    });
    if (!trip) throw Errors.notFound('Trip');
    if (trip.driverId === viewerId) throw Errors.validation({ reason: 'own_trip' });
    if (trip.status !== 'active') throw Errors.tripNotActive();

    // Soft-deleted accounts carry a "+del:" tombstone — never leak it.
    const phone = publicPhone(trip.driver.phone);
    if (!phone) throw Errors.conflict('User has no public phone', { reason: 'no_phone' });

    await auditWithinLimit(viewerId, trip.driverId, 'trip', tripId);
    return { phone, name: trip.driver.name };
  }

  /** Passenger's phone for an open ride request. */
  async function revealForRequest(requestId: string, viewerId: string): Promise<RevealedContact> {
    const request = await prisma.passengerRequest.findUnique({
      where: { id: requestId },
      select: {
        status: true,
        passengerId: true,
        passenger: { select: { phone: true, name: true } },
      },
    });
    if (!request) throw Errors.notFound('Request');
    if (request.passengerId === viewerId) throw Errors.validation({ reason: 'own_request' });
    if (request.status !== 'open') {
      throw Errors.conflict('Request is not open', { current_status: request.status });
    }

    const phone = publicPhone(request.passenger.phone);
    if (!phone) throw Errors.conflict('User has no public phone', { reason: 'no_phone' });

    await auditWithinLimit(viewerId, request.passengerId, 'passenger_request', requestId);
    return { phone, name: request.passenger.name };
  }

  return { revealForTrip, revealForRequest };
}
