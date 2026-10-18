import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { env } from '../config/env';
import { logger } from '../lib/logger';

const run = promisify(execFile);

/** Creates a compressed pg_dump of the database and removes backups older than the retention period. */
export async function backupDatabase() {
  const dir = path.resolve(env.BACKUP_DIR);
  fs.mkdirSync(dir, { recursive: true });
  const url = new URL(env.DATABASE_URL);
  const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 16);
  const file = path.join(dir, `hrms-${stamp}.dump`);
  const exe = env.PG_BIN_DIR ? path.join(env.PG_BIN_DIR, process.platform === 'win32' ? 'pg_dump.exe' : 'pg_dump') : 'pg_dump';
  await run(
    exe,
    ['-h', url.hostname, '-p', url.port || '5432', '-U', decodeURIComponent(url.username), '-d', url.pathname.slice(1), '-F', 'c', '-Z', '6', '-f', file],
    { env: { ...process.env, PGPASSWORD: decodeURIComponent(url.password) }, timeout: 30 * 60_000 },
  );
  const cutoff = Date.now() - env.BACKUP_RETENTION_DAYS * 86_400_000;
  let removed = 0;
  for (const f of fs.readdirSync(dir)) {
    if (!/^hrms-.*\.dump$/.test(f)) continue;
    const full = path.join(dir, f);
    if (fs.statSync(full).mtimeMs < cutoff) {
      fs.unlinkSync(full);
      removed++;
    }
  }
  const size = fs.statSync(file).size;
  logger.info({ file, size, removed }, 'Database backup complete');
  return { file, size, removed };
}
