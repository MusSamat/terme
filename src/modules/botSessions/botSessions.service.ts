import type { Prisma, PrismaClient } from '@prisma/client';

/** Persistence for Telegram bot conversation state (bot_sessions rows). */
export function createBotSessionsService(prisma: PrismaClient) {
  async function load(telegramId: number): Promise<{ data: Prisma.JsonValue; updatedAt: Date } | null> {
    return prisma.botSession.findUnique({
      where: { telegramId: BigInt(telegramId) },
      select: { data: true, updatedAt: true },
    });
  }

  async function save(telegramId: number, data: Prisma.InputJsonValue, state: string | null): Promise<void> {
    await prisma.botSession.upsert({
      where: { telegramId: BigInt(telegramId) },
      update: { data, state },
      create: { telegramId: BigInt(telegramId), data, state },
    });
  }

  async function remove(telegramId: number): Promise<void> {
    await prisma.botSession.deleteMany({ where: { telegramId: BigInt(telegramId) } });
  }

  return { load, save, remove };
}
