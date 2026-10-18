import { backupDatabase } from '../jobs/backup';

backupDatabase()
  .then((r) => {
    console.log(`Backup written to ${r.file} (${(r.size / 1024).toFixed(0)} KB), ${r.removed} old backup(s) removed`);
    process.exit(0);
  })
  .catch((e) => {
    console.error('Backup failed:', e.message);
    process.exit(1);
  });
