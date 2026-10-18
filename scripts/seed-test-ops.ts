import { PrismaClient, Prisma } from '@prisma/client';
import { placeResolver } from '../prisma/seedPlaces.js';

const prisma = new PrismaClient();
const DAY = 86_400_000;

async function userId(phone: string): Promise<string> {
  const u = await prisma.user.findUniqueOrThrow({ where: { phone }, select: { id: true } });
  return u.id;
}

async function main(): Promise<void> {
  const now = Date.now();
  const drivers = await Promise.all(
    ['+996700000005', '+996700000006', '+996700000007', '+996700000008'].map(userId),
  );
  const passengers = await Promise.all(
    ['+996700000001', '+996700000002', '+996700000003', '+996700000004'].map(userId),
  );

  const routes: Array<[string, string, number]> = [
    ['Бишкек', 'Ош', 1200],
    ['Ош', 'Бишкек', 1200],
    ['Бишкек', 'Каракол', 800],
    ['Бишкек', 'Нарын', 700],
    ['Каракол', 'Бишкек', 800],
    ['Бишкек', 'Талас', 600],
    ['Ош', 'Джалал-Абад', 300],
    ['Бишкек', 'Кара-Балта', 200],
    ['Нарын', 'Бишкек', 700],
    ['Бишкек', 'Чолпон-Ата', 500],
  ];

  const place = await placeResolver(prisma, routes.flatMap(([o, d]) => [o, d]));
  let trips = 0;
  for (let i = 0; i < 10; i++) {
    const [o, d, price] = routes[i]!;
    const seats = 2 + (i % 3);
    await prisma.trip.create({
      data: {
        driverId: drivers[i % drivers.length]!,
        originCityId: place(o),
        destinationCityId: place(d),
        originCity: o,
        destinationCity: d,
        originAddress: `Автовокзал ${o}`,
        departureAt: new Date(now + (i + 20) * DAY),
        estimatedDurationMin: 240 + i * 30,
        seatsTotal: seats,
        seatsAvailable: seats,
        pricePerSeat: price,
        luggage: 'small',
        status: 'active',
        preferences: { smoking: false } as Prisma.InputJsonValue,
      },
    });
    trips++;
  }

  let reqs = 0;
  for (let i = 0; i < 10; i++) {
    const [o, d] = routes[i]!;
    await prisma.passengerRequest.create({
      data: {
        passengerId: passengers[i % passengers.length]!,
        originCityId: place(d), // reversed direction from the trips
        destinationCityId: place(o),
        originCity: d,
        destinationCity: o,
        seatsNeeded: 1 + (i % 3),
        departureDate: new Date(now + (i + 3) * DAY),
        flexible: i % 2 === 0,
        comment: `Тестовая заявка №${i + 1}`,
        status: 'open',
      },
    });
    reqs++;
  }

  console.warn(`[test-ops] created ${trips} trips + ${reqs} passenger requests`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => void prisma.$disconnect());
