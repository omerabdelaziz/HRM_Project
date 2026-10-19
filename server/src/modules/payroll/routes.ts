import { z } from 'zod';
import { createRouter, dateString, idParam, paged, pageQuery, paging, sortBy } from '../../lib/http';
import { prisma, Prisma } from '../../lib/prisma';
import { assertCompanyAccess, assertEmployeeInScope, employeeScope, resolveCompanyId } from '../../auth/scope';
import { hasPermission } from '../../auth/context';
import { badRequest, forbidden, notFound } from '../../lib/errors';
import { audit, diff, ipOf } from '../../lib/audit';
import { toDateOnly } from '../../lib/dates';
import {
  addAdjustment, calculateRun, cancelRun, createRun, markPaid, payrollSettings, proposeSalary, reconcile, removeAdjustment, reopenRun, submitRun, withdrawRun,
} from './service';
import { bankFileCsv, payrollRegisterXlsx, payslipPdf } from './documents';
import { pensionRulesSchema, resolvePensionRules } from './pension';

const r = createRouter('/api/payroll', 'Payroll');
export default r;

async function runInScope(user: Parameters<typeof assertCompanyAccess>[0], runId: string) {
  const run = await prisma.payrollRun.findUnique({ where: { id: runId } });
  if (!run) throw notFound('Payroll run');
  await assertCompanyAccess(user, run.companyId);
  return run;
}

// ── Pay components ──

const bracketSchema = z.array(z.object({ upTo: z.number().positive().nullable(), rate: z.number().min(0).max(100) })).min(1);
const componentSchema = z
  .object({
    code: z.string().trim().min(1).max(20).regex(/^[A-Z0-9_]+$/),
    name: z.string().trim().min(1).max(100),
    nameAr: z.string().max(100).nullish(),
    type: z.enum(['EARNING', 'DEDUCTION', 'EMPLOYER_CONTRIBUTION']),
    calcType: z.enum(['FIXED', 'PERCENT_OF_BASIC', 'PERCENT_OF_GROSS', 'BRACKET']),
    defaultValue: z.coerce.number().nullish(),
    brackets: bracketSchema.nullish(),
    bracketBase: z.enum(['BASIC', 'GROSS', 'TAXABLE']).nullish(),
    minAmount: z.coerce.number().nonnegative().nullish(),
    maxAmount: z.coerce.number().nonnegative().nullish(),
    baseCap: z.coerce.number().positive().nullish(),
    isTaxable: z.boolean().default(true),
    pensionable: z.boolean().default(false),
    includeInRateBase: z.boolean().default(false),
    isRecurring: z.boolean().default(true),
    appliesToAll: z.boolean().default(false),
    eligibility: z.object({ categoryCodes: z.array(z.string()).optional(), nationalities: z.array(z.string()).optional(), excludeNationalities: z.array(z.string()).optional(), employmentTypeCodes: z.array(z.string()).optional() }).nullish(),
    sortOrder: z.number().int().default(100),
    isActive: z.boolean().default(true),
  });

function checkComponent(c: Partial<z.infer<typeof componentSchema>>) {
  if (c.calcType === 'BRACKET' && (!c.brackets?.length || !c.bracketBase)) throw badRequest('Bracket components need a bracket table and a base');
  if (c.calcType === 'BRACKET' && c.type === 'EARNING') throw badRequest('Earnings cannot use bracket calculation');
  if (c.calcType === 'PERCENT_OF_GROSS' && c.type === 'EARNING') throw badRequest('Earnings cannot be a percentage of gross');
  if (c.minAmount != null && c.maxAmount != null && c.minAmount > c.maxAmount) throw badRequest('Minimum amount cannot exceed maximum amount');
}

r.get('/components', { summary: 'List pay components', permission: ['payroll.read', 'paycomponent.manage', 'employee.salary.read'], query: z.object({ companyId: z.string().uuid().optional() }) }, async ({ user, query }) =>
  prisma.payComponent.findMany({ where: { companyId: await resolveCompanyId(user, query.companyId) }, orderBy: [{ type: 'asc' }, { sortOrder: 'asc' }] }),
);

r.post('/components', { summary: 'Create a pay component', permission: 'paycomponent.manage', body: componentSchema.extend({ companyId: z.string().uuid().optional() }), status: 201 }, async ({ req, user, body }) => {
  checkComponent(body);
  const companyId = await resolveCompanyId(user, body.companyId);
  const c = await prisma.payComponent.create({ data: { ...body, companyId, brackets: body.brackets ?? Prisma.JsonNull, eligibility: body.eligibility ?? Prisma.JsonNull } });
  await audit({ userId: user.id, action: 'CREATE', entity: 'PayComponent', entityId: c.id, after: c, ip: ipOf(req) });
  return c;
});

r.put('/components/:id', { summary: 'Update a pay component (affects future calculations only)', permission: 'paycomponent.manage', params: idParam, body: componentSchema.partial().omit({ code: true }) }, async ({ req, user, params, body }) => {
  const before = await prisma.payComponent.findUnique({ where: { id: params.id } });
  if (!before) throw notFound('Pay component');
  await assertCompanyAccess(user, before.companyId);
  checkComponent({ ...before, ...body } as z.infer<typeof componentSchema>);
  const after = await prisma.payComponent.update({
    where: { id: params.id },
    data: {
      ...body,
      brackets: body.brackets === undefined ? undefined : body.brackets ?? Prisma.JsonNull,
      eligibility: body.eligibility === undefined ? undefined : body.eligibility ?? Prisma.JsonNull,
    },
  });
  const d = diff(before, after);
  if (d.changed) await audit({ userId: user.id, action: 'UPDATE', entity: 'PayComponent', entityId: params.id, before: d.before, after: d.after, ip: ipOf(req) });
  return after;
});

// ── Settings, currencies ──

const settingsSchema = z.object({
  dailyRateBasis: z.enum(['CALENDAR_DAYS', 'FIXED_30', 'WORKING_DAYS']),
  rateBase: z.enum(['BASIC', 'GROSS']),
  standardHoursPerDay: z.coerce.number().positive().max(24),
  overtimeMultiplier: z.coerce.number().min(0).max(10),
  weekendOvertimeMultiplier: z.coerce.number().min(0).max(10),
  holidayOvertimeMultiplier: z.coerce.number().min(0).max(10),
  nightOvertimeMultiplier: z.coerce.number().min(0).max(10),
  nightOvertimeStart: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:mm'),
  nightOvertimeEnd: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:mm'),
  pensionRules: pensionRulesSchema,
  deductUnpaidLeave: z.boolean(),
  deductAbsence: z.boolean(),
  deductLateMinutes: z.boolean(),
  lateDeductionGraceMinutesPerMonth: z.number().int().min(0),
  prorateNewJoiners: z.boolean(),
  roundingDecimals: z.number().int().min(0).max(3),
  paymentDay: z.number().int().min(1).max(31),
  bankFileFormat: z.enum(['GENERIC_CSV']),
  companyBankAccount: z.string().max(60).nullish(),
}).partial();

r.get('/settings', { summary: 'Payroll calculation rules', permission: ['payroll.read', 'paycomponent.manage'], query: z.object({ companyId: z.string().uuid().optional() }) }, async ({ user, query }) => {
  const s = await payrollSettings(prisma, await resolveCompanyId(user, query.companyId));
  // Always return the effective pension rules (stored values over the UAE defaults).
  return { ...s, pensionRules: resolvePensionRules(s.pensionRules) };
});

r.put('/settings', { summary: 'Update payroll calculation rules', permission: 'paycomponent.manage', body: settingsSchema.extend({ companyId: z.string().uuid().optional() }) }, async ({ req, user, body }) => {
  const { companyId: requested, ...data } = body;
  const companyId = await resolveCompanyId(user, requested);
  const before = await payrollSettings(prisma, companyId);
  if (data.pensionRules && data.pensionRules.minBase > Math.min(...Object.values(data.pensionRules.schemes).map((sc) => sc.cap ?? Infinity))) {
    throw badRequest('The pension minimum base cannot exceed a scheme cap');
  }
  const after = await prisma.payrollSettings.update({ where: { companyId }, data });
  const d = diff(before, after);
  if (d.changed) await audit({ userId: user.id, action: 'UPDATE', entity: 'PayrollSettings', entityId: after.id, before: d.before, after: d.after, ip: ipOf(req) });
  return after;
});

r.get('/currencies', { summary: 'Currencies' }, async () => prisma.currency.findMany({ orderBy: { code: 'asc' } }));

r.post(
  '/currencies',
  { summary: 'Add or update a currency', permission: 'paycomponent.manage', body: z.object({ code: z.string().length(3).toUpperCase(), name: z.string().min(1).max(60), symbol: z.string().min(1).max(8), decimals: z.number().int().min(0).max(4).default(2) }) },
  async ({ body }) => prisma.currency.upsert({ where: { code: body.code }, create: body, update: body }),
);

r.get('/exchange-rates', { summary: 'Exchange rates', permission: ['payroll.read', 'paycomponent.manage'] }, async () => prisma.exchangeRate.findMany({ orderBy: [{ date: 'desc' }], take: 200 }));

r.post(
  '/exchange-rates',
  { summary: 'Record an exchange rate', permission: 'paycomponent.manage', body: z.object({ fromCurrency: z.string().length(3).toUpperCase(), toCurrency: z.string().length(3).toUpperCase(), rate: z.coerce.number().positive(), date: dateString }) },
  async ({ req, user, body }) => {
    if (body.fromCurrency === body.toCurrency) throw badRequest('Currencies must differ');
    const rate = await prisma.exchangeRate.upsert({
      where: { fromCurrency_toCurrency_date: { fromCurrency: body.fromCurrency, toCurrency: body.toCurrency, date: toDateOnly(body.date) } },
      create: { ...body, date: toDateOnly(body.date) },
      update: { rate: body.rate },
    });
    await audit({ userId: user.id, action: 'UPSERT', entity: 'ExchangeRate', entityId: rate.id, after: rate, ip: ipOf(req) });
    return rate;
  },
);

// ── Salary structures ──

r.get('/salaries/:employeeId', { summary: 'Salary structure history of an employee', params: z.object({ employeeId: z.string().uuid() }) }, async ({ user, params }) => {
  const own = params.employeeId === user.employeeId;
  if (!own && !hasPermission(user, 'employee.salary.read')) throw forbidden();
  await assertEmployeeInScope(user, params.employeeId);
  return prisma.salaryStructure.findMany({
    where: { employeeId: params.employeeId, ...(own && !hasPermission(user, 'employee.salary.read') ? { status: 'ACTIVE' } : {}) },
    include: { items: { include: { component: { select: { id: true, code: true, name: true, nameAr: true, type: true, calcType: true } } } } },
    orderBy: { effectiveFrom: 'desc' },
  });
});

r.post(
  '/salaries',
  {
    summary: 'Propose a new salary structure (routes through the SALARY_CHANGE workflow when configured)',
    permission: 'employee.salary.manage',
    status: 201,
    body: z.object({
      employeeId: z.string().uuid(),
      effectiveFrom: dateString,
      basicSalary: z.coerce.number().positive(),
      currency: z.string().length(3).toUpperCase(),
      items: z.array(z.object({ componentId: z.string().uuid(), amount: z.coerce.number().min(0) })).default([]),
      reason: z.string().trim().max(500).optional(),
    }),
  },
  async ({ user, body }) => {
    await assertEmployeeInScope(user, body.employeeId);
    return proposeSalary(body, user.id);
  },
);

// ── Runs ──

r.get(
  '/runs',
  { summary: 'Payroll runs', permission: 'payroll.read', query: pageQuery.extend({ companyId: z.string().uuid().optional(), year: z.coerce.number().int().optional(), status: z.string().optional() }) },
  async ({ user, query }) => {
    const companyId = await resolveCompanyId(user, query.companyId);
    const where: Prisma.PayrollRunWhereInput = { companyId, ...(query.year ? { year: query.year } : {}), ...(query.status ? { status: query.status as Prisma.EnumPayrollStatusFilter['equals'] } : {}) };
    const [items, total] = await Promise.all([
      prisma.payrollRun.findMany({ where, orderBy: [{ year: 'desc' }, { month: 'desc' }], ...paging(query) }),
      prisma.payrollRun.count({ where }),
    ]);
    return paged(items, total, query);
  },
);

r.post(
  '/runs',
  { summary: 'Create a payroll run for a month', permission: 'payroll.run', status: 201, body: z.object({ companyId: z.string().uuid().optional(), year: z.number().int().min(2000).max(2100), month: z.number().int().min(1).max(12), branchId: z.string().uuid().nullish(), notes: z.string().max(1000).optional() }) },
  async ({ user, body }) => createRun({ ...body, companyId: await resolveCompanyId(user, body.companyId) }, user.id),
);

r.get('/runs/:id', { summary: 'Payroll run with events', permission: 'payroll.read', params: idParam }, async ({ user, params }) => {
  await runInScope(user, params.id);
  const run = await prisma.payrollRun.findUniqueOrThrow({
    where: { id: params.id },
    include: { events: { orderBy: { createdAt: 'asc' } }, adjustments: { include: { employee: { select: { employeeNo: true, firstName: true, lastName: true } } }, orderBy: { createdAt: 'asc' } } },
  });
  const actorIds = [...new Set(run.events.map((e) => e.actorId).filter(Boolean))] as string[];
  const actors = await prisma.user.findMany({ where: { id: { in: actorIds } }, select: { id: true, displayName: true } });
  const approval = await prisma.approvalRequest.findUnique({ where: { requestType_entityId: { requestType: 'PAYROLL', entityId: `${run.id}#${run.reopenCount}` } }, select: { id: true, status: true, currentStep: true } });
  return { ...run, approval, events: run.events.map((e) => ({ ...e, actor: actors.find((a) => a.id === e.actorId)?.displayName ?? null })) };
});

r.get(
  '/runs/:id/payslips',
  { summary: 'Payslips of a run', permission: 'payroll.read', params: idParam, query: pageQuery.extend({ departmentId: z.string().uuid().optional() }) },
  async ({ user, params, query }) => {
    await runInScope(user, params.id);
    const where: Prisma.PayslipWhereInput = {
      runId: params.id,
      ...(query.departmentId ? { employee: { departmentId: query.departmentId } } : {}),
      ...(query.search ? { employee: { OR: [{ firstName: { contains: query.search, mode: 'insensitive' } }, { lastName: { contains: query.search, mode: 'insensitive' } }, { employeeNo: { contains: query.search, mode: 'insensitive' } }] } } : {}),
    };
    const [items, total] = await Promise.all([
      prisma.payslip.findMany({ where, include: { lines: { orderBy: { sortOrder: 'asc' } } }, orderBy: sortBy(query.sort, ['netPay', 'grossEarnings', 'totalDeductions'], { createdAt: 'asc' }), ...paging(query) }),
      prisma.payslip.count({ where }),
    ]);
    return paged(items.map((p) => ({ ...p, snapshot: { ...(p.snapshot as object), ibanEnc: undefined, bankAccountEnc: undefined } })), total, query);
  },
);

r.get('/runs/:id/summary', { summary: 'Run totals by department and branch', permission: 'payroll.read', params: idParam }, async ({ user, params }) => {
  const run = await runInScope(user, params.id);
  const slips = await prisma.payslip.findMany({ where: { runId: params.id }, select: { snapshot: true, grossEarnings: true, totalDeductions: true, netPay: true, employerCost: true, currency: true } });
  const group = (key: 'department' | 'branch') => {
    const m = new Map<string, { name: string; employees: number; gross: number; deductions: number; net: number; employerCost: number }>();
    for (const s of slips) {
      const name = ((s.snapshot as Record<string, string | null>)[key] ?? 'Unassigned') as string;
      const g = m.get(name) ?? { name, employees: 0, gross: 0, deductions: 0, net: 0, employerCost: 0 };
      g.employees++;
      g.gross += Number(s.grossEarnings);
      g.deductions += Number(s.totalDeductions);
      g.net += Number(s.netPay);
      g.employerCost += Number(s.employerCost);
      m.set(name, g);
    }
    return [...m.values()].sort((a, b) => b.net - a.net);
  };
  const lines = await prisma.payslipLine.groupBy({ by: ['componentCode', 'name', 'type'], where: { payslip: { runId: params.id } }, _sum: { amount: true } });
  return {
    run,
    byDepartment: group('department'),
    byBranch: group('branch'),
    byComponent: lines.map((l) => ({ code: l.componentCode, name: l.name, type: l.type, amount: Number(l._sum.amount ?? 0) })).sort((a, b) => b.amount - a.amount),
    currencies: [...new Set(slips.map((s) => s.currency))],
  };
});

r.get('/runs/:id/reconcile', { summary: 'Re-sum payslips and check them against run totals', permission: 'payroll.read', params: idParam }, async ({ user, params }) => {
  await runInScope(user, params.id);
  return reconcile(prisma, params.id);
});

const comment = z.object({ comment: z.string().trim().max(1000).optional() });

r.post('/runs/:id/calculate', { summary: 'Calculate (or recalculate) all payslips of the run', permission: 'payroll.run', params: idParam }, async ({ user, params }) => {
  await runInScope(user, params.id);
  return calculateRun(params.id, user.id);
});

r.post('/runs/:id/submit', { summary: 'Submit a calculated run for approval', permission: 'payroll.run', params: idParam, body: comment }, async ({ user, params, body }) => {
  await runInScope(user, params.id);
  return submitRun(params.id, user.id, body.comment);
});

r.post('/runs/:id/withdraw', { summary: 'Withdraw a run from approval', permission: 'payroll.run', params: idParam }, async ({ user, params }) => {
  await runInScope(user, params.id);
  return withdrawRun(params.id, user.id);
});

r.post('/runs/:id/pay', { summary: 'Mark an approved run as paid', permission: 'payroll.pay', params: idParam, body: z.object({ paidAt: z.string().datetime({ offset: true }).optional(), reference: z.string().max(200).optional() }) }, async ({ user, params, body }) => {
  await runInScope(user, params.id);
  return markPaid(params.id, user.id, body);
});

r.post('/runs/:id/reopen', { summary: 'Reopen an approved (unpaid) run for correction', permission: 'payroll.reopen', params: idParam, body: z.object({ reason: z.string().trim().min(5).max(1000) }) }, async ({ user, params, body }) => {
  await runInScope(user, params.id);
  return reopenRun(params.id, user.id, body.reason);
});

r.post('/runs/:id/cancel', { summary: 'Cancel a draft or calculated run', permission: 'payroll.run', params: idParam, body: z.object({ reason: z.string().max(1000).optional() }) }, async ({ user, params, body }) => {
  await runInScope(user, params.id);
  return cancelRun(params.id, user.id, body.reason);
});

r.post(
  '/runs/:id/adjustments',
  { summary: 'Add a one-off earning or deduction to an employee in this run', permission: 'payroll.run', params: idParam, status: 201, body: z.object({ employeeId: z.string().uuid(), type: z.enum(['EARNING', 'DEDUCTION']), code: z.string().max(20).optional(), description: z.string().trim().min(2).max(200), amount: z.coerce.number().positive() }) },
  async ({ user, params, body }) => {
    await runInScope(user, params.id);
    await assertEmployeeInScope(user, body.employeeId);
    return addAdjustment(params.id, body, user.id);
  },
);

r.delete('/runs/:id/adjustments/:adjustmentId', { summary: 'Remove an adjustment', permission: 'payroll.run', params: z.object({ id: z.string().uuid(), adjustmentId: z.string().uuid() }) }, async ({ user, params }) => {
  await runInScope(user, params.id);
  await removeAdjustment(params.id, params.adjustmentId, user.id);
});

r.get('/runs/:id/bank-file', { summary: 'Download the bank salary transfer file (CSV)', permission: 'payroll.pay', params: idParam, raw: true }, async ({ req, res, user, params }) => {
  const run = await runInScope(user, params.id);
  if (!['APPROVED', 'PAID'].includes(run.status)) throw badRequest('Bank files are only available for approved runs');
  const company = await prisma.company.findUniqueOrThrow({ where: { id: run.companyId } });
  const slips = await prisma.payslip.findMany({ where: { runId: run.id }, orderBy: { createdAt: 'asc' } });
  const { csv, missing } = bankFileCsv(run, company, slips);
  await audit({ userId: user.id, action: 'EXPORT_BANK_FILE', entity: 'PayrollRun', entityId: run.id, after: { missingBankDetails: missing }, ip: ipOf(req) });
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="salary-transfer-${run.year}-${String(run.month).padStart(2, '0')}.csv"`);
  if (missing.length) res.setHeader('X-Missing-Bank-Details', missing.join(','));
  res.send(`﻿${csv}`);
});

r.get('/runs/:id/register', { summary: 'Download the payroll register (Excel)', permission: 'payroll.read', params: idParam, raw: true }, async ({ res, user, params }) => {
  const run = await runInScope(user, params.id);
  const slips = await prisma.payslip.findMany({ where: { runId: run.id }, include: { lines: true }, orderBy: { createdAt: 'asc' } });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="payroll-register-${run.year}-${String(run.month).padStart(2, '0')}.xlsx"`);
  res.send(await payrollRegisterXlsx(run, slips));
});

// ── Payslips ──

async function payslipFor(user: Parameters<typeof assertCompanyAccess>[0], id: string) {
  const slip = await prisma.payslip.findUnique({ where: { id }, include: { lines: { orderBy: { sortOrder: 'asc' } }, run: true } });
  if (!slip) throw notFound('Payslip');
  const own = slip.employeeId === user.employeeId;
  if (own) {
    // Employees only see payslips once the payroll is approved.
    if (!['APPROVED', 'PAID'].includes(slip.run.status)) throw notFound('Payslip');
  } else {
    if (!hasPermission(user, 'payroll.read')) throw notFound('Payslip');
    await assertCompanyAccess(user, slip.run.companyId);
  }
  return slip;
}

r.get('/my-payslips', { summary: 'My payslips from approved payroll runs', permission: 'payslip.self' }, async ({ user }) => {
  if (!user.employeeId) return [];
  return prisma.payslip.findMany({
    where: { employeeId: user.employeeId, run: { status: { in: ['APPROVED', 'PAID'] } } },
    select: { id: true, currency: true, grossEarnings: true, totalDeductions: true, netPay: true, paymentStatus: true, paidAt: true, run: { select: { year: true, month: true, periodStart: true, periodEnd: true, status: true } } },
    orderBy: [{ run: { year: 'desc' } }, { run: { month: 'desc' } }],
  });
});

r.get('/payslips/:id', { summary: 'Payslip detail', params: idParam }, async ({ user, params }) => {
  const slip = await payslipFor(user, params.id);
  return { ...slip, snapshot: { ...(slip.snapshot as object), ibanEnc: undefined, bankAccountEnc: undefined } };
});

r.get('/payslips/:id/pdf', { summary: 'Payslip as PDF', params: idParam, raw: true }, async ({ req, res, user, params }) => {
  const slip = await payslipFor(user, params.id);
  const company = await prisma.company.findUniqueOrThrow({ where: { id: slip.run.companyId } });
  const pdf = await payslipPdf(slip, slip.run, company);
  if (slip.employeeId !== user.employeeId) await audit({ userId: user.id, action: 'DOWNLOAD', entity: 'Payslip', entityId: slip.id, ip: ipOf(req) });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="payslip-${slip.run.year}-${String(slip.run.month).padStart(2, '0')}.pdf"`);
  res.send(pdf);
});

r.put('/payslips/:id/hold', { summary: 'Put a payslip on hold or release it (before payment)', permission: 'payroll.pay', params: idParam, body: z.object({ hold: z.boolean() }) }, async ({ req, user, params, body }) => {
  const slip = await payslipFor(user, params.id);
  if (slip.run.status !== 'APPROVED') throw badRequest('Payments can only be held on approved, unpaid runs');
  const updated = await prisma.payslip.update({ where: { id: slip.id }, data: { paymentStatus: body.hold ? 'ON_HOLD' : 'UNPAID' }, select: { id: true, paymentStatus: true } });
  await audit({ userId: user.id, action: body.hold ? 'HOLD' : 'RELEASE', entity: 'Payslip', entityId: slip.id, ip: ipOf(req) });
  return updated;
});

r.get(
  '/history',
  { summary: 'Payroll cost per month (for trend charts)', permission: 'payroll.read', query: z.object({ companyId: z.string().uuid().optional(), months: z.coerce.number().int().min(1).max(36).default(12) }) },
  async ({ user, query }) => {
    const companyId = await resolveCompanyId(user, query.companyId);
    const runs = await prisma.payrollRun.findMany({
      where: { companyId, status: { in: ['APPROVED', 'PAID'] } },
      orderBy: [{ year: 'desc' }, { month: 'desc' }],
      take: query.months,
      select: { year: true, month: true, employeeCount: true, totalGross: true, totalNet: true, totalDeductions: true, totalEmployerCost: true, currency: true },
    });
    return runs.reverse();
  },
);

// Employees in scope with salary info — used by the payroll UI for picking employees.
r.get('/employees', { summary: 'Employees with their current basic salary', permission: 'employee.salary.read', query: pageQuery }, async ({ user, query }) => {
  const scope = await employeeScope(user);
  const where: Prisma.EmployeeWhereInput = { AND: [scope, { deletedAt: null }, query.search ? { OR: [{ firstName: { contains: query.search, mode: 'insensitive' } }, { lastName: { contains: query.search, mode: 'insensitive' } }, { employeeNo: { contains: query.search, mode: 'insensitive' } }] } : {}] };
  const [items, total] = await Promise.all([
    prisma.employee.findMany({
      where,
      select: {
        id: true, employeeNo: true, firstName: true, lastName: true, status: true, department: { select: { name: true } },
        salaryStructures: { where: { status: { in: ['ACTIVE', 'PENDING'] } }, orderBy: { effectiveFrom: 'desc' }, take: 2, select: { basicSalary: true, currency: true, effectiveFrom: true, status: true } },
      },
      orderBy: { employeeNo: 'asc' },
      ...paging(query),
    }),
    prisma.employee.count({ where }),
  ]);
  return paged(items, total, query);
});
