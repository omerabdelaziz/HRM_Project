import { beforeAll, describe, expect, it } from 'vitest';
import { api, auth, login, makeAdmin, makeCompany, makeEmployee, makeWorkflow, prisma } from '../helpers';
import { toDateOnly, zonedTimeToUtc } from '../../src/lib/dates';
import { recalculateRecord } from '../../src/modules/attendance/service';

let ctx: Awaited<ReturnType<typeof makeCompany>>;
let payrollToken: string;
let financeToken: string;
let fatima: Awaited<ReturnType<typeof makeEmployee>>;
let clerk: Awaited<ReturnType<typeof makeEmployee>>;
let expat: Awaited<ReturnType<typeof makeEmployee>>;
let ceo: Awaited<ReturnType<typeof makeEmployee>>;
let worker: Awaited<ReturnType<typeof makeEmployee>>;

const TZ = 'Asia/Dubai';
const at = (iso: string, hhmm: string) => zonedTimeToUtc(toDateOnly(iso), hhmm, TZ);

async function slipOf(runId: string, employeeId: string) {
  const slip = await prisma.payslip.findUniqueOrThrow({ where: { runId_employeeId: { runId, employeeId } }, include: { lines: true } });
  return { slip, line: (code: string) => slip.lines.find((l) => l.componentCode === code) };
}

async function runFor(year: number, month: number) {
  const created = await api().post('/api/payroll/runs').set(auth(payrollToken)).send({ year, month });
  expect(created.status).toBe(201);
  const calc = await api().post(`/api/payroll/runs/${created.body.id}/calculate`).set(auth(payrollToken));
  expect(calc.status).toBe(200);
  return created.body.id as string;
}

beforeAll(async () => {
  ctx = await makeCompany();
  const payroll = await makeEmployee(ctx.company.id, { roles: ['PAYROLL_OFFICER'], hireDate: '2020-01-01' });
  const finance = await makeEmployee(ctx.company.id, { roles: ['FINANCE_OFFICER'], hireDate: '2020-01-01' });
  payrollToken = await login(payroll.user.email);
  financeToken = await login(finance.user.email);
  await makeWorkflow(ctx.company.id, 'PAYROLL', [{ name: 'Finance', approverType: 'ROLE', roleCode: 'FINANCE_OFFICER' }]);

  await prisma.payComponent.update({ where: { id: ctx.housing.id }, data: { pensionable: true } });
  const transport = await prisma.payComponent.create({ data: { companyId: ctx.company.id, code: 'TRANSPORT', name: 'Transport', type: 'EARNING', calcType: 'FIXED' } });
  const executive = await prisma.jobGrade.create({ data: { companyId: ctx.company.id, code: 'G5', name: 'Executive', overtimeEligible: false } });

  fatima = await makeEmployee(ctx.company.id, { hireDate: '2015-05-01', nationality: 'AE', pensionScheme: 'GPSSA_OLD' });
  clerk = await makeEmployee(ctx.company.id, { hireDate: '2024-01-15', nationality: 'AE', pensionScheme: 'GPSSA_NEW' });
  expat = await makeEmployee(ctx.company.id, { hireDate: '2020-01-01', nationality: 'IN' });
  ceo = await makeEmployee(ctx.company.id, { hireDate: '2019-01-01', nationality: 'GB', gradeId: executive.id });
  worker = await makeEmployee(ctx.company.id, { hireDate: '2020-01-01', nationality: 'PK' });

  for (const [e, basic, housing, transportAmt] of [[fatima, 27000, 9000, 1500], [clerk, 9000, 3000, 800], [expat, 12000, 4000, 800], [ceo, 52000, 20000, 3000], [worker, 4800, 1500, 500]] as const) {
    const res = await api().post('/api/payroll/salaries').set(auth(payrollToken)).send({
      employeeId: e.employee.id, effectiveFrom: e.employee.hireDate.toISOString().slice(0, 10), basicSalary: basic, currency: 'AED',
      items: [{ componentId: ctx.housing.id, amount: housing }, { componentId: transport.id, amount: transportAmt }],
    });
    expect(res.status).toBe(201);
  }

  // Overtime on Tue 10 Feb 2026 (shift 09:00–18:00): CEO and worker both stay until 23:00.
  for (const e of [ceo, worker]) {
    await prisma.attendanceRecord.create({ data: { employeeId: e.employee.id, date: toDateOnly('2026-02-10'), checkIn: at('2026-02-10', '09:00'), checkOut: at('2026-02-10', '23:00'), source: 'DEVICE' } });
    await recalculateRecord(prisma, e.employee.id, toDateOnly('2026-02-10'), new Date('2026-03-01T00:00:00Z'));
  }
});

describe('UAE pension (GPSSA / ADPF)', () => {
  it('contributes on basic + pensionable allowances, with the subsidy shown separately', async () => {
    const runId = await runFor(2026, 4);
    const f = await slipOf(runId, fatima.employee.id);
    expect(Number(f.line('PENSION_EE')!.amount)).toBe(1800); // 5% × (27,000 + 9,000), not 1,350
    expect(Number(f.line('PENSION_EE')!.quantity)).toBe(36000);
    expect(Number(f.line('PENSION_ER')!.amount)).toBe(5400); // 15%
    expect(f.line('PENSION_SUBSIDY')).toBeUndefined();

    const c = await slipOf(runId, clerk.employee.id);
    expect(Number(c.line('PENSION_EE')!.amount)).toBe(1320); // 11% × 12,000
    expect(Number(c.line('PENSION_ER')!.amount)).toBe(1500); // 12.5%
    expect(c.line('PENSION_SUBSIDY')).toMatchObject({ type: 'INFORMATION' });
    expect(Number(c.line('PENSION_SUBSIDY')!.amount)).toBe(300);
    expect(Number(c.slip.employerCost)).toBe(9000 + 3000 + 800 + 1500); // gross + employer share; the subsidy is not a cost

    const x = await slipOf(runId, expat.employee.id);
    expect(x.slip.lines.filter((l) => l.componentCode.startsWith('PENSION'))).toHaveLength(0);
  });

  it('settings are configurable and recalculating a draft run uses them, while paid runs keep their figures', async () => {
    // March: calculate, approve and pay with the default rules.
    const paidRunId = await runFor(2026, 3);
    expect((await api().post(`/api/payroll/runs/${paidRunId}/submit`).set(auth(payrollToken)).send({})).status).toBe(200);
    const approval = await prisma.approvalRequest.findFirstOrThrow({ where: { requestType: 'PAYROLL', entityId: { startsWith: paidRunId } } });
    expect((await api().post(`/api/approvals/requests/${approval.id}/approve`).set(auth(financeToken)).send({})).status).toBe(200);
    expect((await api().post(`/api/payroll/runs/${paidRunId}/pay`).set(auth(financeToken)).send({})).status).toBe(200);
    const paidBefore = Number((await slipOf(paidRunId, fatima.employee.id)).line('PENSION_ER')!.amount);

    const settings = await api().get('/api/payroll/settings').set(auth(payrollToken));
    expect(settings.body.pensionRules.schemes.GPSSA_OLD).toEqual({ employeeRate: 5, cap: 50000 });
    const put = await api().put('/api/payroll/settings').set(auth(payrollToken)).send({ pensionRules: { ...settings.body.pensionRules, employerRate: 16 } });
    expect(put.status).toBe(200);

    // The draft April run picks up the new rate on recalculation.
    const draft = await prisma.payrollRun.findFirstOrThrow({ where: { companyId: ctx.company.id, year: 2026, month: 4 } });
    await api().post(`/api/payroll/runs/${draft.id}/calculate`).set(auth(payrollToken));
    expect(Number((await slipOf(draft.id, fatima.employee.id)).line('PENSION_ER')!.amount)).toBe(5760);

    // The paid run cannot be recalculated and its stored lines are unchanged.
    expect((await api().post(`/api/payroll/runs/${paidRunId}/calculate`).set(auth(payrollToken))).status).toBe(422);
    expect(Number((await slipOf(paidRunId, fatima.employee.id)).line('PENSION_ER')!.amount)).toBe(paidBefore);
    await api().put('/api/payroll/settings').set(auth(payrollToken)).send({ pensionRules: settings.body.pensionRules });
  });

  it('rejects inconsistent pension settings', async () => {
    const settings = await api().get('/api/payroll/settings').set(auth(payrollToken));
    const res = await api().put('/api/payroll/settings').set(auth(payrollToken)).send({ pensionRules: { ...settings.body.pensionRules, minBase: 80000 } });
    expect(res.status).toBe(400);
  });
});

describe('overtime eligibility and night overtime', () => {
  it('splits the night part of overtime on the attendance record', async () => {
    const rec = await prisma.attendanceRecord.findUniqueOrThrow({ where: { employeeId_date: { employeeId: worker.employee.id, date: toDateOnly('2026-02-10') } } });
    expect(rec.overtimeMinutes).toBe(300); // 18:00–23:00
    expect(rec.nightOvertimeMinutes).toBe(60); // 22:00–23:00
  });

  it('pays night hours at the night multiplier and gives managerial grades no overtime', async () => {
    const runId = await runFor(2026, 2);
    const w = await slipOf(runId, worker.employee.id);
    // Hourly rate = 4,800 / 30 / 8 = 20.
    expect(Number(w.line('OT_NORMAL')!.quantity)).toBe(4);
    expect(Number(w.line('OT_NORMAL')!.amount)).toBe(100); // 4h × 20 × 1.25
    expect(Number(w.line('OT_NIGHT')!.quantity)).toBe(1);
    expect(Number(w.line('OT_NIGHT')!.amount)).toBe(30); // 1h × 20 × 1.5
    const c = await slipOf(runId, ceo.employee.id);
    expect(c.slip.lines.filter((l) => l.source === 'OVERTIME')).toHaveLength(0);
  });

  it('an employee override wins over the grade', async () => {
    await prisma.employee.update({ where: { id: ceo.employee.id }, data: { overtimeEligible: true } });
    const run = await prisma.payrollRun.findFirstOrThrow({ where: { companyId: ctx.company.id, year: 2026, month: 2 } });
    await api().post(`/api/payroll/runs/${run.id}/calculate`).set(auth(payrollToken));
    expect((await slipOf(run.id, ceo.employee.id)).line('OT_NORMAL')).toBeDefined();
    await prisma.employee.update({ where: { id: ceo.employee.id }, data: { overtimeEligible: null } });
  });

  it('blocks overtime requests for ineligible employees', async () => {
    const adminToken = await login((await makeAdmin(ctx.company.id)).email);
    const res = await api().post('/api/attendance/overtime').set(auth(adminToken)).send({ employeeId: ceo.employee.id, date: '2026-02-11', minutes: 120, reason: 'Board meeting' });
    expect(res.status).toBe(422);
    expect(res.body.error.details.code).toBe('OVERTIME_NOT_ELIGIBLE');
  });
});
