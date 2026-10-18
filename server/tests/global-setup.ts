import { execSync } from 'node:child_process';

/** Recreates the test database from the migrations before the run. */
export default function setup() {
  execSync('npx prisma migrate reset --force --skip-seed --skip-generate', {
    stdio: 'pipe',
    env: { ...process.env, DATABASE_URL: process.env.TEST_DATABASE_URL },
  });
}
