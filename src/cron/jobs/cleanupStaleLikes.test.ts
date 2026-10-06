import { describe, expect, it } from 'vitest';
import { testPrisma } from '../../../tests/setup.js';
import { cleanupStaleLikesJob } from './cleanupStaleLikes.js';
import { createUser, createVerifiedDriver } from '../../../tests/factories.js';

describe('cleanup_stale_likes cron', () => {
  async function makeTrip(opts: { status?: string; departureAt: Date }): Promise<string> {
    const d = await createVerifiedDriver(testPrisma, { plate: `CL${Math.floor(Math.random() * 1e5)}` });
    const trip = await testPrisma.trip.create({
      data: {
        driverId: d.id,
        originCity: 'Бишкек',
        destinationCity: 'Ош',
        originAddress: 'x',
        departureAt: opts.departureAt,
        estimatedDurationMin: 600,
        seatsTotal: 3,
        seatsAvailable: 3,
        pricePerSeat: 800,
        luggage: 'no',
        status: opts.status ?? 'active',
      },
    });
    return trip.id;
  }

  it('keeps likes on live-and-upcoming listings, deletes the rest', async () => {
    const liker = await createUser(testPrisma);
    const passenger = await createUser(testPrisma);
    const future = new Date(Date.now() + 24 * 60 * 60_000);
    const past = new Date(Date.now() - 24 * 60 * 60_000);

    const tripKeep = await makeTrip({ departureAt: future, status: 'active' }); // live + upcoming → keep
    const tripDeparted = await makeTrip({ departureAt: past, status: 'active' }); // time passed → delete
    const tripDone = await makeTrip({ departureAt: future, status: 'completed' }); // terminal → delete

    const reqKeep = await testPrisma.passengerRequest.create({
      data: { passengerId: passenger.id, originCity: 'Бишкек', destinationCity: 'Ош', seatsNeeded: 1, departureDate: future, status: 'open' },
    });
    const reqExpired = await testPrisma.passengerRequest.create({
      data: { passengerId: passenger.id, originCity: 'Бишкек', destinationCity: 'Ош', seatsNeeded: 1, departureDate: future, status: 'expired' },
    });

    const orphan = '00000000-0000-0000-0000-0000000000aa'; // target row never existed

    await testPrisma.listingLike.createMany({
      data: [
        { targetType: 'trip', targetId: tripKeep, userId: liker.id },
        { targetType: 'trip', targetId: tripDeparted, userId: liker.id },
        { targetType: 'trip', targetId: tripDone, userId: liker.id },
        { targetType: 'passenger_request', targetId: reqKeep.id, userId: liker.id },
        { targetType: 'passenger_request', targetId: reqExpired.id, userId: liker.id },
        { targetType: 'trip', targetId: orphan, userId: liker.id },
      ],
    });

    await cleanupStaleLikesJob.run(testPrisma);

    const remaining = await testPrisma.listingLike.findMany();
    const keys = remaining.map((l) => `${l.targetType}:${l.targetId}`).sort();
    expect(keys).toEqual([`passenger_request:${reqKeep.id}`, `trip:${tripKeep}`].sort());
  });

  it('is a no-op with no stale likes', async () => {
    await expect(cleanupStaleLikesJob.run(testPrisma)).resolves.toBeUndefined();
    expect(await testPrisma.listingLike.count()).toBe(0);
  });
});
