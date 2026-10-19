import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import {
  DEFAULT_SUPERADMIN_EMAIL,
  DEFAULT_SUPERADMIN_TEMP_PASSWORD,
  superadminTempPasswordProblem,
} from '../src/config/superadmin.js';

// tsx does not auto-load .env the way the Prisma CLI does, so load it here.
// Node 20.12+ built-in; no dotenv dep needed.
process.loadEnvFile?.('.env');

/**
 * Seed the initial data required for a working system:
 *   • First superadmin (TZ §6.2 — email + temp password from env; must change
 *     on first login)
 *
 * Idempotent — safe to re-run.
 */

// The settlements directory is loaded by migrations (official SOATE, see
// scripts/cities) — nothing to seed here.

async function seedSuperadmin(prisma: PrismaClient): Promise<void> {
  const email = (process.env.SUPERADMIN_EMAIL ?? DEFAULT_SUPERADMIN_EMAIL).toLowerCase();
  // H3: production never seeds the public default / a weak temp password.
  if (process.env.NODE_ENV === 'production') {
    const problem = superadminTempPasswordProblem(process.env.SUPERADMIN_TEMP_PASSWORD);
    if (problem) throw new Error(`[seed] refusing to seed superadmin: ${problem}`);
  }
  const tempPassword = process.env.SUPERADMIN_TEMP_PASSWORD ?? DEFAULT_SUPERADMIN_TEMP_PASSWORD;

  const existing = await prisma.admin.findUnique({ where: { email } });
  if (existing) {
    // Re-force mustChangePassword ONLY while the account still holds the temp
    // password (requireAdmin then blocks every admin route until it's rotated).
    // A rotated password must never be flipped back to «must change».
    const stillTemp = await bcrypt.compare(tempPassword, existing.passwordHash);
    if (stillTemp && !existing.mustChangePassword) {
      await prisma.admin.update({
        where: { id: existing.id },
        data: { mustChangePassword: true },
      });
      console.warn(`[seed] superadmin ${email} still has the temp password — re-forced mustChangePassword`);
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
