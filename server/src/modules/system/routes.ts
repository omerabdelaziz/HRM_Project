import { z } from 'zod';
import { createRouter, paged, pageQuery, paging } from '../../lib/http';
import { prisma } from '../../lib/prisma';
import { audit, ipOf } from '../../lib/audit';
import { backupDatabase } from '../../jobs/backup';
import { closePreviousDay, purgeExpiredData, sendExpiryReminders } from '../../jobs/scheduler';
import { processEscalations } from '../workflow/engine';
import { deliverScheduledReports } from '../reports/routes';

const r = createRouter('/api/system', 'System');
export default r;

r.get('/health', { summary: 'Liveness and database connectivity', public: true }, async () => {
  const started = Date.now();
  await prisma.$queryRaw`SELECT 1`;
  return { status: 'ok', db: 'ok', dbLatencyMs: Date.now() - started, uptimeSec: Math.round(process.uptime()), version: process.env.npm_package_version ?? '0.1.0' };
});

r.get('/jobs', { summary: 'Background job history', permission: 'settings.manage', query: pageQuery.extend({ type: z.string().optional() }) }, async ({ query }) => {
  const where = query.type ? { type: query.type } : {};
  const [items, total] = await Promise.all([
    prisma.backgroundJob.findMany({ where, orderBy: { createdAt: 'desc' }, ...paging(query) }),
    prisma.backgroundJob.count({ where }),
  ]);
  return paged(items, total, query);
});

const JOBS = {
  backup: backupDatabase,
  'close-day': closePreviousDay,
  'expiry-reminders': sendExpiryReminders,
  escalations: processEscalations,
  'scheduled-reports': deliverScheduledReports,
  retention: purgeExpiredData,
} as const;

r.post('/jobs/:name/run', { summary: 'Run a maintenance job now', permission: 'settings.manage', params: z.object({ name: z.enum(Object.keys(JOBS) as [keyof typeof JOBS, ...(keyof typeof JOBS)[]]) }) }, async ({ req, user, params }) => {
  const job = await prisma.backgroundJob.create({ data: { type: params.name.toUpperCase(), status: 'RUNNING', startedAt: new Date(), createdById: user.id } });
  try {
    const result = await JOBS[params.name]();
    await prisma.backgroundJob.update({ where: { id: job.id }, data: { status: 'DONE', progress: 100, finishedAt: new Date(), result: JSON.parse(JSON.stringify(result ?? null)) } });
    await audit({ userId: user.id, action: 'RUN_JOB', entity: 'BackgroundJob', entityId: job.id, after: { name: params.name }, ip: ipOf(req) });
    return { jobId: job.id, result };
  } catch (e) {
    await prisma.backgroundJob.update({ where: { id: job.id }, data: { status: 'FAILED', error: (e as Error).message, finishedAt: new Date() } });
    throw e;
  }
});
