import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

// tsx does not auto-load .env the way the Prisma CLI does, so load it here.
// Node 20.12+ built-in; no dotenv dep needed.
process.loadEnvFile?.('.env');

/**
 * Seed the initial data required for a working system:
 *   • Kyrgyzstan cities (TZ §1.4 launch routes + follow-ups)
 *   • First superadmin (TZ §6.2 — email + temp password from env; must change
 *     on first login)
 *
 * Idempotent — safe to re-run.
 */

// Cities are seeded separately via: npm run db:seed:cities (scripts/seed-cities.ts)
// which loads 624 cities from claude/locations.json. Nothing to do here.

async function seedSuperadmin(prisma: PrismaClient): Promise<void> {
  const email = (process.env.SUPERADMIN_EMAIL ?? 'superadmin@popytchik.kg').toLowerCase();
  const tempPassword =
    process.env.SUPERADMIN_TEMP_PASSWORD ?? 'change-on-first-login-please';

  const existing = await prisma.admin.findUnique({ where: { email } });
  if (existing) {
    // The temp password is a KNOWN literal — never leave the flag unset. If a
    // prior run (or a manual edit) cleared mustChangePassword while the account
    // still holds the seed password, re-force it so requireAdmin (M3) blocks all
    // admin routes until the password is rotated on first login.
    if (!existing.mustChangePassword) {
      await prisma.admin.update({
        where: { id: existing.id },
        data: { mustChangePassword: true },
      });
      console.warn(`[seed] superadmin ${email} exists — re-forced mustChangePassword`);
    } else {
      console.warn(`[seed] superadmin ${email} already exists — skipping`);
    }
    return;
  }

  const passwordHash = await bcrypt.hash(tempPassword, 12);
  await prisma.admin.create({
    data: {
      email,
      passwordHash,
      name: 'Super Admin',
      role: 'superadmin',
      mustChangePassword: true,
      isActive: true,
    },
  });
  console.warn(`[seed] superadmin ${email} created (must change password on first login)`);
}

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  try {
    await seedSuperadmin(prisma);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
