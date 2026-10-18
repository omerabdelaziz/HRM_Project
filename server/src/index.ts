import { env } from './config/env';
import { createApp } from './app';
import { logger } from './lib/logger';
import { prisma } from './lib/prisma';
import { startScheduler } from './jobs/scheduler';

const app = createApp();
const server = app.listen(env.PORT, () => {
  logger.info(`Aziz HRM API listening on http://localhost:${env.PORT} (docs at /api/docs)`);
});

if (env.ENABLE_SCHEDULER) startScheduler();

async function shutdown(signal: string) {
  logger.info({ signal }, 'Shutting down');
  server.close();
  await prisma.$disconnect();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('unhandledRejection', (err) => logger.error({ err }, 'Unhandled rejection'));
