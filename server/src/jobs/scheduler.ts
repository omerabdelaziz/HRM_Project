import cron from 'node-cron';
import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';
import { env } from '../config/env';
import { addDays, isoDate, localDateOf, toDateOnly } from '../lib/dates';
import { processEscalations, remindPendingApprovals } from '../modules/workflow/engine';
import { closePendingDays } from '../modules/attendance/service';
import { notify, userIdsWithRole } from '../modules/notifications/service';
import { deliverScheduledReports } from '../modules/reports/routes';
import { backupDatabase } from './backup';

async function tracked(type: string, fn: () => Promise<unknown>) {
  const job = await prisma.backgroundJob.create({ data: { type, status: 'RUNNING', startedAt: new Date() } });
  try {
    const result = await fn();
    await prisma.backgroundJob.update({ where: { id: job.id }, data: { status: 'DONE', progress: 100, finishedAt: new Date(), result: JSON.parse(JSON.stringify(result ?? null)) } });
  } catch (err) {
    logger.error({ err, type }, 'Scheduled job failed');
    await prisma.backgroundJob.update({ where: { id: job.id }, data: { status: 'FAILED', error: (err as Error).message, finishedAt: new Date() } });
  }
}

/** Closes every unclosed attendance day for every company (catches up after missed runs). */
export async function closePreviousDay(now = new Date()) {
  const companies = await prisma.company.findMany({ where: { isActive: true }, select: { id: true } });
  const out = [];
  for (const c of companies) out.push(await closePendingDays(c.id, now));
  return out;
}

/** Document, contract and probation reminders at fixed lead times. */
export async function sendExpiryReminders(now = new Date()) {
  const today = toDateOnly(now);
  const docLeads = [30, 14, 7, 1];
  const contractLeads = [60, 30, 7];
  let sent = 0;
  const companies = await prisma.company.findMany({ where: { isActive: true }, select: { id: true } });
  for (const company of companies) {
    const hr = await userIdsWithRole(['HR_ADMIN', 'HR_MANAGER'], company.id);
    for (const days of docLeads) {
      const docs = await prisma.employeeDocument.findMany({
        where: { deletedAt: null, expiryDate: addDays(today, days), employee: { companyId: company.id, deletedAt: null, status: { in: ['ACTIVE', 'PROBATION', 'SUSPENDED'] } } },
        include: { employee: { select: { firstName: true, lastName: true, id: true, user: { select: { id: true } } } } },
      });
      for (const d of docs) {
        const who = `${d.employee.firstName} ${d.employee.lastName}`;
        await notify(hr, { type: 'DOCUMENT_EXPIRY', title: `${d.title} of ${who} expires in ${days} day${days > 1 ? 's' : ''}`, body: `Expiry date: ${isoDate(d.expiryDate!)}`, link: `/employees/${d.employee.id}?tab=documents` });
        if (d.employee.user && !d.confidential) {
          await notify([d.employee.user.id], { type: 'DOCUMENT_EXPIRY', title: `Your ${d.title} expires in ${days} day${days > 1 ? 's' : ''}`, body: 'Please provide a renewed copy to HR.', link: '/me' });
        }
        sent++;
      }
    }
    for (const days of contractLeads) {
      const emps = await prisma.employee.findMany({
        where: { companyId: company.id, deletedAt: null, contractEndDate: addDays(today, days), status: { in: ['ACTIVE', 'PROBATION', 'SUSPENDED'] } },
        select: { id: true, firstName: true, lastName: true, contractEndDate: true, manager: { select: { user: { select: { id: true } } } } },
      });
      for (const e of emps) {
        const recipients = [...hr, e.manager?.user?.id].filter(Boolean) as string[];
        await notify(recipients, { type: 'CONTRACT_EXPIRY', title: `Contract of ${e.firstName} ${e.lastName} ends in ${days} days`, body: `End date: ${isoDate(e.contractEndDate!)}`, link: `/employees/${e.id}` });
        sent++;
      }
    }
    const probations = await prisma.employee.findMany({
      where: { companyId: company.id, deletedAt: null, status: 'PROBATION', probationEndDate: addDays(today, 14) },
      select: { id: true, firstName: true, lastName: true, probationEndDate: true, manager: { select: { user: { select: { id: true } } } } },
    });
    for (const e of probations) {
      const recipients = [...hr, e.manager?.user?.id].filter(Boolean) as string[];
      await notify(recipients, { type: 'CONTRACT_EXPIRY', title: `Probation of ${e.firstName} ${e.lastName} ends in 14 days`, body: 'Please complete the probation review.', link: `/employees/${e.id}` });
      sent++;
    }
  }
  return { sent };
}

/** Ends system access for employees whose future-dated separation has arrived. */
export async function applySeparations(now = new Date()) {
  const today = toDateOnly(now);
  const users = await prisma.user.findMany({
    where: { isActive: true, employee: { separationDate: { lte: today }, status: { in: ['RESIGNED', 'TERMINATED', 'RETIRED'] } } },
    select: { id: true },
  });
  for (const u of users) {
    await prisma.$transaction([
      prisma.user.update({ where: { id: u.id }, data: { isActive: false } }),
      prisma.session.updateMany({ where: { userId: u.id, revokedAt: null }, data: { revokedAt: new Date() } }),
    ]);
  }
  return { deactivated: users.length };
}

export async function purgeExpiredData() {
  const auditCutoff = new Date(Date.now() - env.AUDIT_RETENTION_DAYS * 86_400_000);
  const [audit, sessions, notifications, jobs] = await Promise.all([
    prisma.auditLog.deleteMany({ where: { createdAt: { lt: auditCutoff } } }),
    prisma.session.deleteMany({ where: { OR: [{ expiresAt: { lt: new Date() } }, { revokedAt: { lt: new Date(Date.now() - 30 * 86_400_000) } }] } }),
    prisma.notification.deleteMany({ where: { readAt: { lt: new Date(Date.now() - 180 * 86_400_000) } } }),
    prisma.backgroundJob.deleteMany({ where: { finishedAt: { lt: new Date(Date.now() - 90 * 86_400_000) } } }),
  ]);
  return { audit: audit.count, sessions: sessions.count, notifications: notifications.count, jobs: jobs.count };
}

export function startScheduler() {
  const opts = { timezone: 'UTC' };
  cron.schedule('*/15 * * * *', () => void tracked('APPROVAL_ESCALATIONS', processEscalations), opts);
  // Hourly, so overnight shifts are closed soon after they end; idempotent.
  cron.schedule('20 * * * *', () => void tracked('ATTENDANCE_CLOSE_DAY', () => closePreviousDay()), opts);
  cron.schedule('0 1 * * *', () => void tracked('APPLY_SEPARATIONS', applySeparations), opts);
  cron.schedule('0 2 * * *', () => void tracked('BACKUP', backupDatabase), opts);
  cron.schedule('30 2 * * *', () => void tracked('RETENTION_PURGE', purgeExpiredData), opts);
  cron.schedule('0 5 * * *', () => void tracked('EXPIRY_REMINDERS', sendExpiryReminders), opts);
  cron.schedule('0 6 * * 1-5', () => void tracked('APPROVAL_REMINDERS', remindPendingApprovals), opts);
  cron.schedule('0 6 * * *', () => void tracked('SCHEDULED_REPORTS', deliverScheduledReports), opts);
  logger.info('Scheduler started');
}
