import { beforeEach, describe, expect, it } from 'vitest';
import { CITY } from '../../../tests/cities.js';
import { testPrisma } from '../../../tests/setup.js';
import { tripReminder2hJob } from './tripReminder2h.js';
import { createUser, createVerifiedDriver } from '../../../tests/factories.js';

describe('trip_reminder_2h cron', () => {
  beforeEach(() => {
    // setup.ts truncates between tests
  });

  async function seedTrip(opts: { whenMs: number }) {
    const d = await createVerifiedDriver(testPrisma, { plate: `R${Math.floor(Math.random() * 100000)}` });
    const p = await createUser(testPrisma);
    const t = await testPrisma.trip.create({
      data: {
        driverId: d.id,
        originCity: 'Бишкек', originCityId: CITY['Бишкек'],
        destinationCity: 'Ош', destinationCityId: CITY['Ош'],
        originAddress: 'x',
        departureAt: new Date(Date.now() + opts.whenMs),
        estimatedDurationMin: 600,
        seatsTotal: 3,
        seatsAvailable: 2,
        pricePerSeat: 800,
        luggage: 'no',
        status: 'active',
      },
    });
    await testPrisma.booking.create({
      data: { tripId: t.id, passengerId: p.id, seatsCount: 1, status: 'accepted' },
    });
    return { d, p, t };
  }

  it('emits one reminder per participant for trips departing within 2h', async () => {
    const { d, p, t } = await seedTrip({ whenMs: 60 * 60_000 });
    // Also seed a trip departing in 5h — should NOT trigger.
    await seedTrip({ whenMs: 5 * 60 * 60_000 });

    await tripReminder2hJob.run(testPrisma);

    const notifs = await testPrisma.notification.findMany({ where: { type: 'trip_reminder' } });
    const tripIds = notifs.map((n) => (n.payload as { trip_id: string }).trip_id);
    expect(new Set(tripIds)).toEqual(new Set([t.id]));

    const recipients = new Set(notifs.map((n) => n.userId));
    expect(recipients.has(d.id)).toBe(true);
    expect(recipients.has(p.id)).toBe(true);
  });

  it('does not double-emit when cron fires twice in the window', async () => {
    await seedTrip({ whenMs: 30 * 60_000 });
    await tripReminder2hJob.run(testPrisma);
    const after1 = await testPrisma.notification.count();
    await tripReminder2hJob.run(testPrisma);
    const after2 = await testPrisma.notification.count();
    expect(after2).toBe(after1);
  });

  it('does nothing if no trips are in window', async () => {
    await seedTrip({ whenMs: 6 * 60 * 60_000 });
    await tripReminder2hJob.run(testPrisma);
    expect(await testPrisma.notification.count()).toBe(0);
  });
});
