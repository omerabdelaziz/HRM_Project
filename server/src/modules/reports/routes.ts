import { z } from 'zod';
import { createRouter, idParam } from '../../lib/http';
import { prisma, Prisma } from '../../lib/prisma';
import { AuthUser, hasPermission, loadAuthUser } from '../../auth/context';
import { resolveCompanyId } from '../../auth/scope';
import { badRequest, forbidden, notFound } from '../../lib/errors';
import { audit, ipOf } from '../../lib/audit';
import { sendMail } from '../../lib/mailer';
import { logger } from '../../lib/logger';
import { findReport, REPORTS } from './definitions';
import { MIME, toCsv, toPdf, toXlsx } from './export';
import { emailHtml } from '../../lib/brand';

const r = createRouter('/api/reports', 'Reports');
export default r;

function visible(user: AuthUser) {
  return REPORTS.filter((rep) => hasPermission(user, 'report.read') && hasPermission(user, ...rep.permission));
}

r.get('/', { summary: 'Reports available to me', permission: 'report.read' }, async ({ user }) =>
  visible(user).map((rep) => ({ key: rep.key, title: rep.title, description: rep.description, category: rep.category, filters: Object.keys((rep.filters as z.AnyZodObject).shape ?? {}) })),
);

async function runReport(user: AuthUser, key: string, rawFilters: Record<string, unknown>) {
  const rep = findReport(key);
  if (!rep) throw notFound('Report');
  if (!hasPermission(user, 'report.read') || !hasPermission(user, ...rep.permission)) throw forbidden();
  const companyId = await resolveCompanyId(user, (rawFilters.companyId as string) || undefined);
  const parsed = rep.filters.safeParse(rawFilters);
  if (!parsed.success) throw badRequest('Invalid report filters', parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
  const result = await rep.run(user, companyId, parsed.data);
  return { result, companyId };
}

async function render(format: 'xlsx' | 'csv' | 'pdf', result: Awaited<ReturnType<typeof runReport>>['result'], companyId: string) {
  if (format === 'xlsx') return toXlsx(result);
  if (format === 'csv') return toCsv(result);
  const company = await prisma.company.findUniqueOrThrow({ where: { id: companyId }, select: { name: true } });
  return toPdf(result, company.name);
}

r.get(
  '/:key',
  { summary: 'Run a report (JSON) or export it with format=xlsx|csv|pdf', permission: 'report.read', params: z.object({ key: z.string() }), raw: true },
  async ({ req, res, user, params }) => {
    const { format = 'json', ...filters } = req.query as Record<string, string>;
    const { result, companyId } = await runReport(user, params.key, filters);
    if (format === 'json') {
      res.json(result);
      return;
    }
    if (!['xlsx', 'csv', 'pdf'].includes(format)) throw badRequest('format must be json, xlsx, csv or pdf');
    const f = format as keyof typeof MIME;
    const buf = await render(f, result, companyId);
    await audit({ userId: user.id, action: 'EXPORT_REPORT', entity: 'Report', entityId: params.key, after: { format, filters }, ip: ipOf(req) });
    res.setHeader('Content-Type', MIME[f]);
    res.setHeader('Content-Disposition', `attachment; filename="${params.key}-${new Date().toISOString().slice(0, 10)}.${f}"`);
    res.send(buf);
  },
);

// ── Saved & scheduled reports ──

export const savedReportsRouter = createRouter('/api/saved-reports', 'Reports');
const s = savedReportsRouter;

const savedBody = z.object({
  name: z.string().trim().min(1).max(150),
  reportKey: z.string(),
  filters: z.record(z.unknown()).default({}),
  format: z.enum(['xlsx', 'csv', 'pdf']).default('xlsx'),
  schedule: z.enum(['DAILY', 'WEEKLY', 'MONTHLY']).nullish(),
  recipients: z.array(z.string().email()).max(20).default([]),
});

s.get('/', { summary: 'My saved report configurations', permission: 'report.read' }, async ({ user }) =>
  prisma.savedReport.findMany({ where: { userId: user.id }, orderBy: { name: 'asc' } }),
);

s.post('/', { summary: 'Save a report configuration (optionally scheduled for email delivery)', permission: 'report.read', body: savedBody, status: 201 }, async ({ user, body }) => {
  const rep = findReport(body.reportKey);
  if (!rep || !hasPermission(user, ...rep.permission)) throw badRequest('Unknown or unavailable report');
  const companyId = await resolveCompanyId(user, (body.filters.companyId as string) || undefined);
  return prisma.savedReport.create({ data: { ...body, filters: body.filters as Prisma.InputJsonValue, schedule: body.schedule ?? null, userId: user.id, companyId } });
});

s.put('/:id', { summary: 'Update a saved report', permission: 'report.read', params: idParam, body: savedBody.partial() }, async ({ user, params, body }) => {
  const row = await prisma.savedReport.findUnique({ where: { id: params.id } });
  if (!row || row.userId !== user.id) throw notFound('Saved report');
  return prisma.savedReport.update({ where: { id: params.id }, data: { ...body, filters: body.filters as Prisma.InputJsonValue | undefined } });
});

s.delete('/:id', { summary: 'Delete a saved report', permission: 'report.read', params: idParam }, async ({ user, params }) => {
  const row = await prisma.savedReport.findUnique({ where: { id: params.id } });
  if (!row || row.userId !== user.id) throw notFound('Saved report');
  await prisma.savedReport.delete({ where: { id: params.id } });
});

/** Resolves relative date filters ("@monthStart", "@today", "@prevMonthStart", "@prevMonthEnd") at delivery time. */
function resolveRelative(filters: Record<string, unknown>, now = new Date()) {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  const map: Record<string, string> = {
    '@today': iso(now),
    '@monthStart': iso(new Date(Date.UTC(y, m, 1))),
    '@prevMonthStart': iso(new Date(Date.UTC(y, m - 1, 1))),
    '@prevMonthEnd': iso(new Date(Date.UTC(y, m, 0))),
    '@yearStart': iso(new Date(Date.UTC(y, 0, 1))),
    '@year': String(y),
  };
  return Object.fromEntries(Object.entries(filters).map(([k, v]) => [k, typeof v === 'string' && map[v] ? map[v] : v]));
}

/** Emails due scheduled reports. Called by the scheduler once a day. */
export async function deliverScheduledReports(now = new Date()) {
  const due = await prisma.savedReport.findMany({ where: { schedule: { not: null } } });
  let sent = 0;
  for (const rep of due) {
    const isDue = rep.schedule === 'DAILY' || (rep.schedule === 'WEEKLY' && now.getUTCDay() === 1) || (rep.schedule === 'MONTHLY' && now.getUTCDate() === 1);
    if (!isDue) continue;
    if (rep.lastRunAt && rep.lastRunAt.toISOString().slice(0, 10) === now.toISOString().slice(0, 10)) continue;
    try {
      // Run with the owner's current permissions; a deactivated owner stops delivery.
      const owner = await loadAuthUser(rep.userId, 'scheduler');
      if (!owner) continue;
      const { result, companyId } = await runReport(owner, rep.reportKey, { ...resolveRelative(rep.filters as Record<string, unknown>, now), companyId: rep.companyId });
      const buf = await render(rep.format as 'xlsx' | 'csv' | 'pdf', result, companyId);
      const to = rep.recipients.length ? rep.recipients : [owner.email];
      await sendMail({ to, subject: `Aziz HRM report: ${rep.name}`, html: emailHtml(result.title, `Your scheduled report is attached (${result.rows.length} rows).`), text: `${result.title}\n${result.rows.length} rows attached.`, attachments: [{ filename: `${rep.reportKey}.${rep.format}`, content: buf }] });
      await prisma.savedReport.update({ where: { id: rep.id }, data: { lastRunAt: now } });
      sent++;
    } catch (err) {
      logger.error({ err, savedReportId: rep.id }, 'Scheduled report failed');
    }
  }
  return sent;
}
