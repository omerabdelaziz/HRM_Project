import type { PayComponent, PayrollRun } from '@prisma/client';
import { prisma, Prisma, Tx } from '../../lib/prisma';
import { badRequest, conflict, notFound, unprocessable } from '../../lib/errors';
import { addDays, daysBetweenInclusive, isoDate, monthRange, toDateOnly } from '../../lib/dates';
import { audit } from '../../lib/audit';
import { decrypt } from '../../lib/crypto';
import { employeeCalendar } from '../attendance/calendar';
import { registerWorkflowHandler, submitForApproval, cancelRequest } from '../workflow/engine';
import { notify, userIdsWithRole } from '../notifications/service';
import { calculatePayslip, isEligible, PayrollInput, StructureSegment } from './calc';
import { resolvePensionRules } from './pension';
import { isOvertimeEligible } from '../attendance/service';
import { assertPayrollOpen } from './locks';

const D = (v: Prisma.Decimal.Value | null | undefined) => new Prisma.Decimal(v ?? 0);

export async function payrollSettings(db: Tx | typeof prisma, companyId: string) {
  return db.payrollSettings.upsert({ where: { companyId }, create: { companyId }, update: {} });
}

/** Converts an amount between currencies with the latest rate on or before the date. */
export async function convert(db: Tx | typeof prisma, amount: Prisma.Decimal, from: string, to: string, date: Date) {
  if (from === to) return amount;
  const direct = await db.exchangeRate.findFirst({ where: { fromCurrency: from, toCurrency: to, date: { lte: date } }, orderBy: { date: 'desc' } });
  if (direct) return amount.times(direct.rate);
  const inverse = await db.exchangeRate.findFirst({ where: { fromCurrency: to, toCurrency: from, date: { lte: date } }, orderBy: { date: 'desc' } });
  if (inverse) return amount.div(inverse.rate);
  throw unprocessable(`No exchange rate from ${from} to ${to} on or before ${isoDate(date)}`);
}

// ── Inputs ──

interface EmployeePayrollContext {
  employee: Prisma.EmployeeGetPayload<{ include: typeof empInclude }>;
  input: PayrollInput;
  currency: string;
  periodDays: number;
  metrics: { unpaidLeaveDays: number; absentDays: number; lateMinutes: number; overtimeMinutes: number };
}

const empInclude = {
  department: { select: { id: true, name: true, code: true } },
  grade: { select: { overtimeEligible: true } },
  branch: { select: { id: true, name: true } },
  position: { select: { title: true } },
  category: { select: { code: true } },
  employmentType: { select: { code: true } },
  costCenter: { select: { code: true, name: true } },
} satisfies Prisma.EmployeeInclude;

async function buildContext(tx: Tx, run: PayrollRun, employeeId: string, components: PayComponent[]): Promise<EmployeePayrollContext | { skip: string }> {
  const employee = await tx.employee.findUniqueOrThrow({ where: { id: employeeId }, include: empInclude });
  const settings = await payrollSettings(tx, run.companyId);
  const pStart = run.periodStart;
  const pEnd = run.periodEnd;
  const periodDays = daysBetweenInclusive(pStart, pEnd);

  // Employment window inside the period.
  const empStart = employee.hireDate > pStart ? employee.hireDate : pStart;
  const empEnd = employee.separationDate && employee.separationDate < pEnd ? employee.separationDate : pEnd;
  if (empEnd < empStart) return { skip: 'Not employed during the period' };

  const structures = await tx.salaryStructure.findMany({
    where: { employeeId, status: 'ACTIVE', effectiveFrom: { lte: empEnd }, OR: [{ effectiveTo: null }, { effectiveTo: { gte: empStart } }] },
    include: { items: { include: { component: true } } },
    orderBy: { effectiveFrom: 'asc' },
  });
  if (!structures.length) return { skip: 'No active salary structure' };

  const calendar = await employeeCalendar(employeeId, pStart, pEnd, tx);
  const workingIn = (a: Date, b: Date) => calendar.filter((d) => d.date >= a && d.date <= b && d.isWorkingDay).length;
  const periodWorkingDays = workingIn(pStart, pEnd);

  const segments: StructureSegment[] = [];
  structures.forEach((st, i) => {
    const segStart = st.effectiveFrom > empStart ? st.effectiveFrom : empStart;
    const nextStart = structures[i + 1]?.effectiveFrom;
    let segEnd = st.effectiveTo && st.effectiveTo < empEnd ? st.effectiveTo : empEnd;
    if (nextStart && addDays(nextStart, -1) < segEnd) segEnd = addDays(nextStart, -1);
    if (segEnd < segStart) return;
    segments.push({
      days: daysBetweenInclusive(segStart, segEnd),
      workingDays: workingIn(segStart, segEnd),
      basicSalary: st.basicSalary,
      items: st.items
        .filter((it) => isEligible(it.component, { categoryCode: employee.category?.code, nationality: employee.nationality, employmentTypeCode: employee.employmentType?.code }))
        .map((it) => ({ component: it.component, amount: it.amount })),
    });
  });
  if (!segments.length) return { skip: 'No salary structure covers the employment days in this period' };
  const currency = structures[structures.length - 1].currency;

  // Unpaid leave days inside the period.
  const leaves = await tx.leaveRequest.findMany({
    where: { employeeId, status: 'APPROVED', startDate: { lte: pEnd }, endDate: { gte: pStart }, leaveType: { isPaid: false } },
    include: { leaveType: true },
  });
  let unpaidLeaveDays = 0;
  for (const l of leaves) {
    if (l.halfDay) {
      unpaidLeaveDays += 0.5;
      continue;
    }
    for (const d of calendar) {
      if (d.date < l.startDate || d.date > l.endDate || d.date < empStart || d.date > empEnd) continue;
      if (l.leaveType.countWeekendsAndHolidays || d.isWorkingDay) unpaidLeaveDays += 1;
    }
  }

  const records = await tx.attendanceRecord.findMany({ where: { employeeId, date: { gte: empStart, lte: empEnd } } });
  const policy = await tx.attendancePolicy.findUnique({ where: { companyId: run.companyId } });
  const otRequiresApproval = policy?.overtimeRequiresApproval ?? true;
  let absentDays = 0;
  let lateMinutes = 0;
  const overtime = { normalMinutes: 0, weekendMinutes: 0, holidayMinutes: 0, nightMinutes: 0 };
  // Managerial grades (and employees overridden as ineligible) are never paid overtime.
  const overtimeEligible = isOvertimeEligible(employee);
  for (const rec of records) {
    if (rec.status === 'ABSENT') absentDays += 1;
    lateMinutes += rec.lateMinutes;
    const ot = overtimeEligible ? (otRequiresApproval ? rec.approvedOvertimeMinutes : rec.overtimeMinutes) : 0;
    if (ot > 0) {
      const day = calendar.find((d) => d.date.getTime() === rec.date.getTime());
      if (day?.holiday) overtime.holidayMinutes += ot;
      else if (day?.isWeekend) overtime.weekendMinutes += ot;
      else {
        // Weekend and holiday rates take precedence; on working days the night part is paid at the night rate.
        // Approved minutes are allocated to the night window first.
        const night = Math.min(rec.nightOvertimeMinutes, ot);
        overtime.nightMinutes += night;
        overtime.normalMinutes += ot - night;
      }
    }
  }

  const adjustments = await tx.payrollAdjustment.findMany({ where: { runId: run.id, employeeId } });
  const globalComponents = components.filter(
    (c) => c.appliesToAll && c.isActive && isEligible(c, { categoryCode: employee.category?.code, nationality: employee.nationality, employmentTypeCode: employee.employmentType?.code }),
  );

  return {
    employee,
    currency,
    periodDays,
    metrics: { unpaidLeaveDays, absentDays, lateMinutes, overtimeMinutes: overtime.normalMinutes + overtime.weekendMinutes + overtime.holidayMinutes + overtime.nightMinutes },
    input: {
      settings,
      periodDays,
      periodWorkingDays,
      segments,
      globalComponents,
      unpaidLeaveDays,
      absentDays,
      lateMinutes,
      overtime,
      adjustments: adjustments.map((a) => ({ type: a.type, code: a.code, description: a.description, amount: a.amount })),
      pension: { scheme: employee.pensionScheme, rules: resolvePensionRules(settings.pensionRules) },
    },
  };
}

function assertStatus(run: PayrollRun, allowed: PayrollRun['status'][], action: string) {
  if (!allowed.includes(run.status)) throw unprocessable(`Cannot ${action} a payroll run that is ${run.status.replace('_', ' ').toLowerCase()}`);
}

async function lockRun(tx: Tx, runId: string) {
  await tx.$queryRaw`SELECT id FROM "PayrollRun" WHERE id = ${runId} FOR UPDATE`;
  const run = await tx.payrollRun.findUnique({ where: { id: runId } });
  if (!run) throw notFound('Payroll run');
  return run;
}

async function event(tx: Tx, runId: string, action: string, actorId: string | null, comment?: string, totals?: Record<string, unknown>) {
  await tx.payrollRunEvent.create({ data: { runId, action, actorId, comment, totals: totals as Prisma.InputJsonValue | undefined } });
}

// ── Lifecycle ──

export async function createRun(input: { companyId: string; year: number; month: number; branchId?: string | null; notes?: string }, actorId: string) {
  const { start, end } = monthRange(input.year, input.month);
  const company = await prisma.company.findUniqueOrThrow({ where: { id: input.companyId } });
  const existing = await prisma.payrollRun.findFirst({
    where: {
      companyId: input.companyId, year: input.year, month: input.month, status: { not: 'CANCELLED' },
      // A company-wide run conflicts with any branch run of the same month and vice versa.
      ...(input.branchId ? { OR: [{ branchId: input.branchId }, { branchId: null }] } : {}),
    },
  });
  if (existing) throw conflict(`A payroll run for ${input.year}-${String(input.month).padStart(2, '0')} already exists for this scope`, { runId: existing.id });
  // A partial unique index (see migration) guarantees one non-cancelled run per company/month/branch
  // even under concurrent requests; cancelled runs stay for the audit trail.
  return prisma.$transaction(async (tx) => {
    const run = await tx.payrollRun.create({
      data: { companyId: input.companyId, year: input.year, month: input.month, periodStart: start, periodEnd: end, branchId: input.branchId ?? null, currency: company.baseCurrency, notes: input.notes, createdById: actorId },
    });
    await event(tx, run.id, 'CREATED', actorId);
    await audit({ userId: actorId, action: 'CREATE', entity: 'PayrollRun', entityId: run.id, after: run }, tx);
    return run;
  });
}

export async function calculateRun(runId: string, actorId: string) {
  return prisma.$transaction(
    async (tx) => {
      const run = await lockRun(tx, runId);
      assertStatus(run, ['DRAFT', 'CALCULATED'], 'calculate');
      const components = await tx.payComponent.findMany({ where: { companyId: run.companyId } });
      const employees = await tx.employee.findMany({
        where: {
          companyId: run.companyId,
          deletedAt: null,
          ...(run.branchId ? { branchId: run.branchId } : {}),
          hireDate: { lte: run.periodEnd },
          OR: [{ separationDate: null }, { separationDate: { gte: run.periodStart } }],
        },
        select: { id: true, employeeNo: true, firstName: true, lastName: true },
        orderBy: { employeeNo: 'asc' },
      });

      await tx.payslip.deleteMany({ where: { runId } });
      const skipped: { employeeNo: string; name: string; reason: string }[] = [];
      const warnings: { employeeNo: string; name: string; warning: string }[] = [];
      let totalGross = D(0);
      let totalDeductions = D(0);
      let totalNet = D(0);
      let totalEmployerCost = D(0);
      let count = 0;

      for (const e of employees) {
        const name = `${e.firstName} ${e.lastName}`;
        const ctx = await buildContext(tx, run, e.id, components);
        if ('skip' in ctx) {
          skipped.push({ employeeNo: e.employeeNo, name, reason: ctx.skip });
          continue;
        }
        let result;
        try {
          result = calculatePayslip(ctx.input);
        } catch (err) {
          skipped.push({ employeeNo: e.employeeNo, name, reason: (err as Error).message });
          continue;
        }
        result.warnings.forEach((w) => warnings.push({ employeeNo: e.employeeNo, name, warning: w }));
        const emp = ctx.employee;
        await tx.payslip.create({
          data: {
            runId,
            employeeId: e.id,
            currency: ctx.currency,
            basicSalary: result.basicSalary,
            grossEarnings: result.grossEarnings,
            totalDeductions: result.totalDeductions,
            netPay: result.netPay,
            employerCost: result.employerCost,
            periodDays: ctx.periodDays,
            payableDays: result.payableDays,
            unpaidLeaveDays: ctx.metrics.unpaidLeaveDays,
            absentDays: ctx.metrics.absentDays,
            overtimeMinutes: ctx.metrics.overtimeMinutes,
            lateMinutes: ctx.metrics.lateMinutes,
            snapshot: {
              employeeNo: emp.employeeNo,
              name: `${emp.firstName} ${emp.lastName}`,
              nameAr: emp.firstNameAr ? `${emp.firstNameAr} ${emp.lastNameAr ?? ''}`.trim() : null,
              department: emp.department?.name ?? null,
              departmentId: emp.departmentId,
              branch: emp.branch?.name ?? null,
              branchId: emp.branchId,
              position: emp.position?.title ?? null,
              costCenter: emp.costCenter?.code ?? null,
              hireDate: isoDate(emp.hireDate),
              bankName: emp.bankName,
              // Bank details are kept encrypted inside the snapshot.
              ibanEnc: emp.ibanEnc,
              bankAccountEnc: emp.bankAccountEnc,
              dailyRate: result.dailyRate.toString(),
              hourlyRate: result.hourlyRate.toString(),
              warnings: result.warnings,
            },
            lines: {
              create: result.lines.map((l) => ({
                componentCode: l.componentCode, name: l.name, nameAr: l.nameAr, type: l.type, source: l.source,
                quantity: l.quantity, rate: l.rate, amount: l.amount, sortOrder: l.sortOrder,
              })),
            },
          },
        });
        const conv = (v: Prisma.Decimal) => convert(tx, v, ctx.currency, run.currency, run.periodEnd);
        totalGross = totalGross.plus(await conv(result.grossEarnings));
        totalDeductions = totalDeductions.plus(await conv(result.totalDeductions));
        totalNet = totalNet.plus(await conv(result.netPay));
        totalEmployerCost = totalEmployerCost.plus(await conv(result.employerCost));
        count++;
      }

      const totals = {
        employeeCount: count,
        totalGross: totalGross.toDecimalPlaces(2),
        totalDeductions: totalDeductions.toDecimalPlaces(2),
        totalNet: totalNet.toDecimalPlaces(2),
        totalEmployerCost: totalEmployerCost.toDecimalPlaces(2),
      };
      const updated = await tx.payrollRun.update({ where: { id: runId }, data: { ...totals, status: 'CALCULATED', calculatedAt: new Date() } });
      await event(tx, runId, 'CALCULATED', actorId, undefined, { ...totals, skipped: skipped.length, warnings: warnings.length });
      await audit({ userId: actorId, action: 'CALCULATE', entity: 'PayrollRun', entityId: runId, after: totals }, tx);
      return { run: updated, skipped, warnings };
    },
    { timeout: 600_000, maxWait: 30_000 },
  );
}

/** Independent re-summation of payslips; used before submission and approval. */
export async function reconcile(db: Tx | typeof prisma, runId: string) {
  const run = await db.payrollRun.findUniqueOrThrow({ where: { id: runId } });
  const slips = await db.payslip.findMany({ where: { runId }, include: { lines: true } });
  const issues: string[] = [];
  let gross = D(0);
  let net = D(0);
  let deductions = D(0);
  for (const p of slips) {
    const earn = p.lines.filter((l) => l.type === 'EARNING').reduce((a, l) => a.plus(l.amount), D(0));
    const ded = p.lines.filter((l) => l.type === 'DEDUCTION').reduce((a, l) => a.plus(l.amount), D(0));
    const no = (p.snapshot as { employeeNo?: string }).employeeNo;
    if (!earn.eq(p.grossEarnings)) issues.push(`${no}: earnings lines (${earn}) differ from gross (${p.grossEarnings})`);
    if (!ded.eq(p.totalDeductions)) issues.push(`${no}: deduction lines (${ded}) differ from total deductions (${p.totalDeductions})`);
    if (!p.grossEarnings.minus(p.totalDeductions).eq(p.netPay)) issues.push(`${no}: gross minus deductions does not equal net`);
    if (p.netPay.lt(0)) issues.push(`${no}: negative net pay (${p.netPay})`);
    gross = gross.plus(await convert(db, p.grossEarnings, p.currency, run.currency, run.periodEnd));
    deductions = deductions.plus(await convert(db, p.totalDeductions, p.currency, run.currency, run.periodEnd));
    net = net.plus(await convert(db, p.netPay, p.currency, run.currency, run.periodEnd));
  }
  if (slips.length !== run.employeeCount) issues.push(`Run lists ${run.employeeCount} employees but has ${slips.length} payslips`);
  if (!gross.toDecimalPlaces(2).eq(run.totalGross)) issues.push(`Payslip gross total ${gross.toDecimalPlaces(2)} differs from run total ${run.totalGross}`);
  if (!deductions.toDecimalPlaces(2).eq(run.totalDeductions)) issues.push(`Payslip deductions total ${deductions.toDecimalPlaces(2)} differs from run total ${run.totalDeductions}`);
  if (!net.toDecimalPlaces(2).eq(run.totalNet)) issues.push(`Payslip net total ${net.toDecimalPlaces(2)} differs from run total ${run.totalNet}`);
  return { ok: issues.length === 0, issues, totals: { gross: gross.toDecimalPlaces(2), deductions: deductions.toDecimalPlaces(2), net: net.toDecimalPlaces(2), payslips: slips.length } };
}

const approvalEntityId = (run: PayrollRun) => `${run.id}#${run.reopenCount}`;

export async function submitRun(runId: string, actorId: string, comment?: string) {
  return prisma.$transaction(async (tx) => {
    const run = await lockRun(tx, runId);
    assertStatus(run, ['CALCULATED'], 'submit');
    if (run.employeeCount === 0) throw unprocessable('The run has no payslips');
    const rec = await reconcile(tx, runId);
    if (!rec.ok) throw unprocessable('Payroll does not reconcile; recalculate before submitting', { issues: rec.issues });
    await tx.payrollRun.update({ where: { id: runId }, data: { status: 'PENDING_APPROVAL' } });
    await event(tx, runId, 'SUBMITTED', actorId, comment);
    await submitForApproval(tx, {
      companyId: run.companyId,
      requestType: 'PAYROLL',
      entityId: approvalEntityId(run),
      requesterId: actorId,
      title: `Payroll ${run.year}-${String(run.month).padStart(2, '0')}: ${run.employeeCount} employees, net ${run.totalNet} ${run.currency}`,
      summary: { runId, year: run.year, month: run.month, employees: run.employeeCount, totalGross: run.totalGross, totalNet: run.totalNet, currency: run.currency, comment },
      amount: Number(run.totalNet),
      context: { branchId: run.branchId },
    });
    return tx.payrollRun.findUniqueOrThrow({ where: { id: runId } });
  });
}

registerWorkflowHandler('PAYROLL', {
  async onApproved(tx, r, actorId) {
    const runId = r.entityId.split('#')[0];
    const run = await lockRun(tx, runId);
    if (run.status !== 'PENDING_APPROVAL') return;
    const rec = await reconcile(tx, runId);
    if (!rec.ok) throw unprocessable('Payroll does not reconcile; it cannot be approved', { issues: rec.issues });
    await tx.payrollRun.update({ where: { id: runId }, data: { status: 'APPROVED', approvedAt: new Date(), approvedById: actorId, lockedAt: new Date() } });
    await event(tx, runId, 'APPROVED', actorId);
    await audit({ userId: actorId, action: 'APPROVE', entity: 'PayrollRun', entityId: runId, after: rec.totals }, tx);
    const payroll = await userIdsWithRole(['PAYROLL_OFFICER', 'FINANCE_OFFICER'], run.companyId);
    await notify(payroll, { type: 'PAYROLL', title: `Payroll ${run.year}-${String(run.month).padStart(2, '0')} approved`, link: `/payroll/runs/${runId}` }, tx);
  },
  async onRejected(tx, r, actorId) {
    const runId = r.entityId.split('#')[0];
    await tx.payrollRun.update({ where: { id: runId }, data: { status: 'CALCULATED' } });
    await event(tx, runId, 'REJECTED', actorId);
  },
  async onCancelled(tx, r, actorId) {
    const runId = r.entityId.split('#')[0];
    await tx.payrollRun.update({ where: { id: runId }, data: { status: 'CALCULATED' } });
    await event(tx, runId, 'WITHDRAWN', actorId);
  },
  link: (r) => `/payroll/runs/${r.entityId.split('#')[0]}`,
});

export async function withdrawRun(runId: string, actorId: string) {
  return prisma.$transaction(async (tx) => {
    const run = await lockRun(tx, runId);
    assertStatus(run, ['PENDING_APPROVAL'], 'withdraw');
    await cancelRequest(tx, 'PAYROLL', approvalEntityId(run), actorId, { force: true });
    return tx.payrollRun.findUniqueOrThrow({ where: { id: runId } });
  });
}

export async function markPaid(runId: string, actorId: string, input: { paidAt?: string; reference?: string }) {
  const result = await prisma.$transaction(async (tx) => {
    const run = await lockRun(tx, runId);
    assertStatus(run, ['APPROVED'], 'mark as paid');
    const paidAt = input.paidAt ? new Date(input.paidAt) : new Date();
    await tx.payslip.updateMany({ where: { runId, paymentStatus: 'UNPAID' }, data: { paymentStatus: 'PAID', paidAt } });
    const updated = await tx.payrollRun.update({ where: { id: runId }, data: { status: 'PAID', paidAt } });
    await event(tx, runId, 'PAID', actorId, input.reference);
    await audit({ userId: actorId, action: 'PAY', entity: 'PayrollRun', entityId: runId, after: { paidAt, reference: input.reference } }, tx);
    return updated;
  });
  // Tell employees their payslip is available.
  const users = await prisma.user.findMany({ where: { isActive: true, employee: { payslips: { some: { runId } } } }, select: { id: true } });
  await notify(users.map((u) => u.id), { type: 'PAYROLL', title: `Your payslip for ${result.year}-${String(result.month).padStart(2, '0')} is available`, link: '/me/payslips' });
  return result;
}

export async function reopenRun(runId: string, actorId: string, reason: string) {
  return prisma.$transaction(async (tx) => {
    const run = await lockRun(tx, runId);
    assertStatus(run, ['APPROVED'], 'reopen');
    const updated = await tx.payrollRun.update({
      where: { id: runId },
      data: { status: 'DRAFT', approvedAt: null, approvedById: null, lockedAt: null, reopenCount: { increment: 1 } },
    });
    await event(tx, runId, 'REOPENED', actorId, reason);
    await audit({ userId: actorId, action: 'REOPEN', entity: 'PayrollRun', entityId: runId, before: { status: run.status, totals: { gross: run.totalGross, net: run.totalNet } }, after: { reason } }, tx);
    return updated;
  });
}

export async function cancelRun(runId: string, actorId: string, reason?: string) {
  return prisma.$transaction(async (tx) => {
    const run = await lockRun(tx, runId);
    assertStatus(run, ['DRAFT', 'CALCULATED'], 'cancel');
    await tx.payslip.deleteMany({ where: { runId } });
    const updated = await tx.payrollRun.update({ where: { id: runId }, data: { status: 'CANCELLED', employeeCount: 0, totalGross: 0, totalNet: 0, totalDeductions: 0, totalEmployerCost: 0 } });
    await event(tx, runId, 'CANCELLED', actorId, reason);
    await audit({ userId: actorId, action: 'CANCEL', entity: 'PayrollRun', entityId: runId, after: { reason } }, tx);
    return updated;
  });
}

export async function addAdjustment(runId: string, input: { employeeId: string; type: 'EARNING' | 'DEDUCTION'; code?: string; description: string; amount: number }, actorId: string) {
  return prisma.$transaction(async (tx) => {
    const run = await lockRun(tx, runId);
    assertStatus(run, ['DRAFT', 'CALCULATED'], 'adjust');
    const emp = await tx.employee.findUnique({ where: { id: input.employeeId }, select: { companyId: true } });
    if (!emp || emp.companyId !== run.companyId) throw badRequest('Employee does not belong to this payroll company');
    const adj = await tx.payrollAdjustment.create({
      data: { runId, employeeId: input.employeeId, type: input.type, code: input.code || 'ADJ', description: input.description, amount: input.amount, createdById: actorId },
    });
    // Totals are stale until recalculated.
    if (run.status === 'CALCULATED') await tx.payrollRun.update({ where: { id: runId }, data: { status: 'DRAFT' } });
    await audit({ userId: actorId, action: 'CREATE', entity: 'PayrollAdjustment', entityId: adj.id, after: adj }, tx);
    return adj;
  });
}

export async function removeAdjustment(runId: string, adjustmentId: string, actorId: string) {
  return prisma.$transaction(async (tx) => {
    const run = await lockRun(tx, runId);
    assertStatus(run, ['DRAFT', 'CALCULATED'], 'adjust');
    const adj = await tx.payrollAdjustment.findFirst({ where: { id: adjustmentId, runId } });
    if (!adj) throw notFound('Adjustment');
    await tx.payrollAdjustment.delete({ where: { id: adjustmentId } });
    if (run.status === 'CALCULATED') await tx.payrollRun.update({ where: { id: runId }, data: { status: 'DRAFT' } });
    await audit({ userId: actorId, action: 'DELETE', entity: 'PayrollAdjustment', entityId: adjustmentId, before: adj }, tx);
  });
}

// ── Salary structures ──

export interface SalaryInput {
  employeeId: string;
  effectiveFrom: string;
  basicSalary: number;
  currency: string;
  items: { componentId: string; amount: number }[];
  reason?: string;
}

export async function proposeSalary(input: SalaryInput, actorId: string) {
  return prisma.$transaction(async (tx) => {
    const emp = await tx.employee.findUnique({ where: { id: input.employeeId }, include: { grade: true } });
    if (!emp || emp.deletedAt) throw notFound('Employee');
    const effectiveFrom = toDateOnly(input.effectiveFrom);
    if (effectiveFrom < emp.hireDate) throw badRequest('Salary cannot start before the hire date');
    await assertPayrollOpen(emp.id, effectiveFrom, tx);
    const currency = await tx.currency.findUnique({ where: { code: input.currency } });
    if (!currency) throw badRequest(`Unknown currency ${input.currency}`);
    const comps = await tx.payComponent.findMany({ where: { id: { in: input.items.map((i) => i.componentId) } } });
    if (comps.length !== new Set(input.items.map((i) => i.componentId)).size || comps.some((c) => c.companyId !== emp.companyId)) {
      throw badRequest('One or more pay components are invalid for this company');
    }
    const pending = await tx.salaryStructure.findFirst({ where: { employeeId: emp.id, status: 'PENDING' } });
    if (pending) throw unprocessable('A salary change for this employee is already awaiting approval');
    const sameDay = await tx.salaryStructure.findFirst({ where: { employeeId: emp.id, status: 'ACTIVE', effectiveFrom } });
    if (sameDay) throw unprocessable(`A salary structure already starts on ${isoDate(effectiveFrom)}`);

    const warnings: string[] = [];
    if (emp.grade?.minSalary && D(input.basicSalary).lt(emp.grade.minSalary)) warnings.push(`Basic salary is below the ${emp.grade.name} grade minimum (${emp.grade.minSalary})`);
    if (emp.grade?.maxSalary && D(input.basicSalary).gt(emp.grade.maxSalary)) warnings.push(`Basic salary is above the ${emp.grade.name} grade maximum (${emp.grade.maxSalary})`);

    const previous = await tx.salaryStructure.findFirst({ where: { employeeId: emp.id, status: 'ACTIVE', effectiveFrom: { lt: effectiveFrom } }, orderBy: { effectiveFrom: 'desc' } });
    const structure = await tx.salaryStructure.create({
      data: {
        employeeId: emp.id, effectiveFrom, basicSalary: input.basicSalary, currency: input.currency, reason: input.reason, createdById: actorId, status: 'PENDING',
        items: { create: input.items.map((i) => ({ componentId: i.componentId, amount: i.amount })) },
      },
    });
    await audit({ userId: actorId, action: 'CREATE', entity: 'SalaryStructure', entityId: structure.id, after: { ...input } }, tx);
    await submitForApproval(tx, {
      companyId: emp.companyId,
      requestType: 'SALARY_CHANGE',
      entityId: structure.id,
      requesterId: actorId,
      employeeId: emp.id,
      title: `Salary ${previous ? 'change' : 'setup'}: ${emp.firstName} ${emp.lastName}, effective ${isoDate(effectiveFrom)}`,
      summary: { previousBasic: previous?.basicSalary ?? null, newBasic: input.basicSalary, currency: input.currency, effectiveFrom: isoDate(effectiveFrom), reason: input.reason, warnings },
      amount: previous ? Number(D(input.basicSalary).minus(previous.basicSalary)) : input.basicSalary,
      context: { departmentId: emp.departmentId, branchId: emp.branchId },
    });
    return { structure: await tx.salaryStructure.findUniqueOrThrow({ where: { id: structure.id }, include: { items: { include: { component: true } } } }), warnings };
  });
}

registerWorkflowHandler('SALARY_CHANGE', {
  async onApproved(tx, r, actorId) {
    const st = await tx.salaryStructure.findUniqueOrThrow({ where: { id: r.entityId } });
    if (st.status !== 'PENDING') return;
    await assertPayrollOpen(st.employeeId, st.effectiveFrom, tx);
    const previous = await tx.salaryStructure.findFirst({ where: { employeeId: st.employeeId, status: 'ACTIVE', effectiveFrom: { lt: st.effectiveFrom } }, orderBy: { effectiveFrom: 'desc' } });
    const next = await tx.salaryStructure.findFirst({ where: { employeeId: st.employeeId, status: 'ACTIVE', effectiveFrom: { gt: st.effectiveFrom } }, orderBy: { effectiveFrom: 'asc' } });
    if (previous && (!previous.effectiveTo || previous.effectiveTo >= st.effectiveFrom)) {
      await tx.salaryStructure.update({ where: { id: previous.id }, data: { effectiveTo: addDays(st.effectiveFrom, -1) } });
    }
    await tx.salaryStructure.update({ where: { id: st.id }, data: { status: 'ACTIVE', effectiveTo: next ? addDays(next.effectiveFrom, -1) : null } });
    await tx.employeeHistory.create({
      data: {
        employeeId: st.employeeId, type: 'SALARY_CHANGE', effectiveDate: st.effectiveFrom,
        fromValue: previous ? { basicSalary: previous.basicSalary.toString(), currency: previous.currency } : Prisma.JsonNull,
        toValue: { basicSalary: st.basicSalary.toString(), currency: st.currency },
        reason: st.reason, createdById: actorId,
      },
    });
  },
  async onRejected(tx, r) {
    await tx.salaryStructure.update({ where: { id: r.entityId }, data: { status: 'REJECTED' } });
  },
  link: (r) => `/approvals/${r.id}`,
});

export function presentBank(snapshot: Prisma.JsonValue) {
  const s = snapshot as { ibanEnc?: string | null; bankAccountEnc?: string | null; bankName?: string | null };
  return { bankName: s.bankName ?? null, iban: decrypt(s.ibanEnc ?? null), bankAccount: decrypt(s.bankAccountEnc ?? null) };
}
