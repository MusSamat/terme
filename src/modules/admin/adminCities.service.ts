import type { Prisma, PrismaClient } from '@prisma/client';
import { Errors } from '@/lib/errors.js';
import { foldCyrillic } from '@/lib/translit.js';
import { writeAdminAction } from './admin.audit.js';
import type { z } from 'zod';
import type { CitiesAdminQuery, CityUpdateBody } from './admin.schemas.js';

// The directory itself comes from SOATE (scripts/cities). Admins search it and
// correct what the import got wrong: names, search aliases, the map point
// (approximate points are flagged), and visibility.
const citySelect = {
  id: true,
  soateCode: true,
  type: true,
  nameRu: true,
  nameKg: true,
  aliases: true,
  lat: true,
  lng: true,
  coordApprox: true,
  isActive: true,
  isSearchable: true,
  raion: { select: { nameRu: true } },
  oblast: { select: { nameRu: true } },
} satisfies Prisma.CitySelect;

export type AdminCity = Prisma.CityGetPayload<{ select: typeof citySelect }>;

export interface AdminCitiesService {
  list(query: z.infer<typeof CitiesAdminQuery>): Promise<{ data: AdminCity[]; nextCursor: string | null }>;
  update(
    id: number,
    patch: z.infer<typeof CityUpdateBody>,
    adminId: string,
    ip?: string | null,
  ): Promise<AdminCity>;
}

export function createAdminCitiesService(prisma: PrismaClient): AdminCitiesService {
  async function list(query: z.infer<typeof CitiesAdminQuery>) {
    const q = query.q ? foldCyrillic(query.q) : null;
    const ids = q
      ? (
          await prisma.$queryRaw<Array<{ id: number }>>`
            SELECT id FROM cities
            WHERE name_ru_folded LIKE ${`%${q}%`} OR name_kg_folded LIKE ${`%${q}%`}
               OR aliases_folded LIKE ${`%${q}%`} OR soate_code = ${query.q}
            LIMIT 500
          `
        ).map((r) => r.id)
      : null;
    const rows = await prisma.city.findMany({
      where: {
        ...(ids ? { id: { in: ids } } : {}),
        ...(query.type ? { type: query.type } : {}),
        ...(query.approx !== undefined ? { coordApprox: query.approx } : {}),
      },
      orderBy: [{ priority: 'desc' }, { nameRu: 'asc' }, { id: 'asc' }],
      take: query.limit + 1,
      ...(query.cursor ? { cursor: { id: Number(query.cursor) }, skip: 1 } : {}),
      select: citySelect,
    });
    const hasMore = rows.length > query.limit;
    const data = hasMore ? rows.slice(0, query.limit) : rows;
    return { data, nextCursor: hasMore ? String(data[data.length - 1]!.id) : null };
  }

  async function update(
    id: number,
    patch: z.infer<typeof CityUpdateBody>,
    adminId: string,
    ip?: string | null,
  ) {
    const existing = await prisma.city.findUnique({ where: { id } });
    if (!existing) throw Errors.notFound('City');
    const point = patch.lat !== undefined && patch.lng !== undefined;
    const updated = await prisma.city.update({
      where: { id },
      data: {
        ...(patch.nameRu !== undefined ? { nameRu: patch.nameRu } : {}),
        ...(patch.nameKg !== undefined ? { nameKg: patch.nameKg } : {}),
        ...(patch.aliases !== undefined ? { aliases: patch.aliases } : {}),
        ...(patch.isActive !== undefined ? { isActive: patch.isActive } : {}),
        // A hand-placed point is exact by definition.
        ...(point ? { lat: patch.lat, lng: patch.lng, coordApprox: false } : {}),
      },
      select: citySelect,
    });
    await writeAdminAction(prisma, {
      adminId,
      action: 'update_city',
      targetType: 'city',
      details: { city_id: id, patch },
      ipAddress: ip ?? null,
    });
    return updated;
  }

  return { list, update };
}
