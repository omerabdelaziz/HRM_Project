import { defineConfig } from 'vitest/config';
import { config } from 'dotenv';

config();

if (!process.env.TEST_DATABASE_URL) throw new Error('TEST_DATABASE_URL must be set to run the tests');
if (process.env.TEST_DATABASE_URL === process.env.DATABASE_URL) throw new Error('TEST_DATABASE_URL must differ from DATABASE_URL: the test database is wiped');

export default defineConfig({
  test: {
    environment: 'node',
    globalSetup: ['./tests/global-setup.ts'],
    env: { NODE_ENV: 'test', DATABASE_URL: process.env.TEST_DATABASE_URL, ENABLE_SCHEDULER: 'false', STORAGE_DIR: './storage-test' },
    // Integration tests share one database, so run files one at a time.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});
