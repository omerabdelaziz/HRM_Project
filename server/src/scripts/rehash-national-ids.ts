/**
 * Recomputes Employee.nationalIdHash (HMAC-SHA256 keyed with DATA_HASH_KEY) from the encrypted national ID.
 * Run after rotating DATA_HASH_KEY so duplicate detection keeps working:
 *   npm run rehash:national-ids -w server            (apply)
 *   npm run rehash:national-ids -w server -- --dry   (report only)
 * The encrypted values (DATA_ENCRYPTION_KEY) are not touched.
 */
import { prisma } from '../lib/prisma';
import { decrypt, keyedHash } from '../lib/crypto';

async function main() {
  const dry = process.argv.includes('--dry');
  const employees = await prisma.employee.findMany({ where: { nationalIdEnc: { not: null } }, select: { id: true, nationalIdEnc: true, nationalIdHash: true } });
  let changed = 0;
  let failed = 0;
  for (const e of employees) {
    let hash: string | null;
    try {
      hash = keyedHash(decrypt(e.nationalIdEnc));
    } catch {
      failed++;
      console.error(`Could not decrypt the national ID of employee ${e.id}; left unchanged`);
      continue;
    }
    if (hash === e.nationalIdHash) continue;
    changed++;
    if (!dry) await prisma.employee.update({ where: { id: e.id }, data: { nationalIdHash: hash } });
  }
  console.log(`${employees.length} employees checked, ${changed} hashes ${dry ? 'would change' : 'updated'}, ${failed} failed`);
  if (failed) process.exitCode = 1;
}

main().finally(() => prisma.$disconnect());
