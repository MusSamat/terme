import type { PrismaClient } from '@prisma/client';

/**
 * Seeds describe routes by name; trips / requests store directory ids. Resolves
 * every name once (exact name → alias, most prominent place first — same rule
 * as the API's name search) and returns a strict lookup.
 */
export async function placeResolver(
  prisma: PrismaClient,
  names: Iterable<string>,
): Promise<(name: string) => number> {
  const ids = new Map<string, number>();
  for (const name of new Set(names)) {
    const rows = await prisma.$queryRaw<Array<{ id: number }>>`
      SELECT id FROM cities
      WHERE is_active AND is_searchable
        AND (name_ru_folded = kg_fold(${name}) OR name_kg_folded = kg_fold(${name})
             OR kg_fold(${name}) = ANY (SELECT kg_fold(a) FROM unnest(aliases) a))
      ORDER BY (name_ru_folded = kg_fold(${name})) DESC, priority DESC, id
      LIMIT 1
    `;
    if (rows[0]) ids.set(name, rows[0].id);
  }
  return (name) => {
    const id = ids.get(name);
    if (id === undefined) throw new Error(`seed place not in directory: ${name}`);
    return id;
  };
}
