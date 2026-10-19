/**
 * Seeds reference data (permissions, roles, currencies) and the first administrator.
 * With --demo (or SEED_DEMO=true) it also creates a fully populated demo company through the real
 * business services: employees, salaries, attendance, leave, approvals and an approved payroll.
 *
 *   npm run db:seed               # reference data + admin
 *   npm run db:seed -- --demo     # plus demo company
 */
import { PrismaClient, Prisma } from '@prisma/client';
import { PERMISSIONS, ALL_PERMISSIONS, SYSTEM_ROLES } from '../src/auth/permissions';
import { hashPassword } from '../src/auth/passwords';
import { randomToken } from '../src/lib/crypto';

const prisma = new PrismaClient();
const DEMO = process.argv.includes('--demo') || process.env.SEED_DEMO === 'true';
// Demo data signs in with published passwords; never allow it next to real data.
if (DEMO && process.env.NODE_ENV === 'production') {
  console.error('Refusing to seed demo data with NODE_ENV=production (demo accounts use well-known passwords).');
  process.exit(1);
}

const CURRENCIES = [
  ['USD', 'US Dollar', '$', 2], ['EUR', 'Euro', '€', 2], ['GBP', 'Pound Sterling', '£', 2], ['AED', 'UAE Dirham', 'AED', 2],
  ['SAR', 'Saudi Riyal', 'SAR', 2], ['QAR', 'Qatari Riyal', 'QAR', 2], ['KWD', 'Kuwaiti Dinar', 'KWD', 3], ['BHD', 'Bahraini Dinar', 'BHD', 3],
  ['OMR', 'Omani Rial', 'OMR', 3], ['EGP', 'Egyptian Pound', 'EGP', 2], ['JOD', 'Jordanian Dinar', 'JOD', 3], ['INR', 'Indian Rupee', '₹', 2],
] as const;

export async function seedReference() {
  for (const code of ALL_PERMISSIONS) {
    const [module, description] = PERMISSIONS[code];
    await prisma.permission.upsert({ where: { code }, create: { code, module, description }, update: { module, description } });
  }
  const perms = await prisma.permission.findMany();
  const permId = (c: string) => perms.find((p) => p.code === c)!.id;
  for (const [code, def] of Object.entries(SYSTEM_ROLES)) {
    const existing = await prisma.role.findUnique({ where: { code } });
    if (!existing) {
      await prisma.role.create({
        data: { code, name: def.name, description: def.description, dataScope: def.dataScope, isSystem: true, requireMfa: !!def.requireMfa, permissions: { create: def.permissions.map((p) => ({ permissionId: permId(p) })) } },
      });
    } else if (code === 'SUPER_ADMIN') {
      // Super admin always holds every permission, including ones added by upgrades.
      await prisma.rolePermission.createMany({ data: perms.map((p) => ({ roleId: existing.id, permissionId: p.id })), skipDuplicates: true });
    }
  }
  for (const [code, name, symbol, decimals] of CURRENCIES) {
    await prisma.currency.upsert({ where: { code }, create: { code, name, symbol, decimals }, update: {} });
  }
}

async function seedAdmin() {
  const email = (process.env.SEED_ADMIN_EMAIL ?? 'admin@hrms.local').toLowerCase();
  if (await prisma.user.findUnique({ where: { email } })) return null;
  const password = process.env.SEED_ADMIN_PASSWORD ?? (DEMO ? 'Admin@12345' : `${randomToken(10)}9a`);
  const role = await prisma.role.findUniqueOrThrow({ where: { code: 'SUPER_ADMIN' } });
  await prisma.user.create({
    data: { email, displayName: 'System Administrator', passwordHash: await hashPassword(password), mustChangePassword: !DEMO, roles: { create: [{ roleId: role.id }] } },
  });
  return { email, password };
}

async function main() {
  await seedReference();
  const admin = await seedAdmin();
  console.log('✔ Reference data (permissions, roles, currencies)');
  if (admin) console.log(`✔ Administrator: ${admin.email} / ${admin.password}${DEMO ? '' : '  (must be changed at first sign-in)'}`);
  if (DEMO) {
    const { seedDemo } = await import('./demo');
    await seedDemo(prisma);
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());

export { Prisma };
