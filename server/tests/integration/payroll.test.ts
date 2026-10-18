import { beforeAll, describe, expect, it } from 'vitest';
import { api, auth, login, makeCompany, makeEmployee, makeWorkflow, prisma } from '../helpers';
import { toDateOnly, zonedTimeToUtc } from '../../src/lib/dates';

let ctx: Awaited<ReturnType<typeof makeCompany>>;
let payroll: Awaited<ReturnType<typeof makeEmployee>>;
let finance: Awaited<ReturnType<typeof makeEmployee>>;
let payrollToken: string;
let financeToken: string;
let worker: Awaited<ReturnType<typeof makeEmployee>>;
let joiner: Awaited<ReturnType<typeof makeEmployee>>;

const YEAR = 2026;
const MONTH = 3; // March 2026: 31 days

beforeAll(async () => {
  ctx = await makeCompany();
  payroll = await makeEmployee(ctx.company.id, { roles: ['PAYROLL_OFFICER'], hireDate: '2020-01-01' });
  finance = await makeEmployee(ctx.company.id, { roles: ['FINANCE_OFFICER'], hireDate: '2020-01-01' });
  payrollToken = await login(payroll.user.email);
  financeToken = await login(finance.user.email);
  worker = await makeEmployee(ctx.company.id, { hireDate: '2020-01-01', iban: 'AE070331234567890123456', bankName: 'Test Bank' });
  joiner = await makeEmployee(ctx.company.id, { hireDate: '2026-03-17' });
  await makeWorkflow(ctx.company.id, 'PAYROLL', [{ name: 'Finance', approverType: 'ROLE', roleCode: 'FINANCE_OFFICER' }]);

  const pension = await prisma.payComponent.create({ data: { companyId: ctx.company.id, code: 'PENSION', name: 'Pension', type: 'DEDUCTION', calcType: 'PERCENT_OF_BASIC', defaultValue: 5, appliesToAll: true } });
  void pension;
  // Salaries (no SALARY_CHANGE workflow → applied immediately).
  for (const [e, basic] of [[payroll, 10000], [finance, 12000], [worker, 9000], [joiner, 6000]] as const) {
    const res = await api().post('/api/payroll/salaries').set(auth(payrollToken)).send({
      employeeId: e.employee.id, effectiveFrom: e.employee.hireDate.toISOString().slice(0, 10), basicSalary: basic, currency: 'AED', items: [{ componentId: ctx.housing.id, amount: 3000 }],
    });
    expect(res.status).toBe(201);
  }
  // Worker: one unpaid leave day and one absence in March.
  await prisma.leaveRequest.create({ data: { employeeId: worker.employee.id, leaveTypeId: ctx.unpaid.id, startDate: toDateOnly('2026-03-10'), endDate: toDateOnly('2026-03-10'), days: 1, status: 'APPROVED' } });
  await prisma.attendanceRecord.create({ data: { employeeId: worker.employee.id, date: toDateOnly('2026-03-11'), status: 'ABSENT' } });
  // Worker: 2h overtime on a weekday.
  await prisma.attendanceRecord.create({
    data: {
      employeeId: worker.employee.id, date: toDateOnly('2026-03-12'), status: 'PRESENT',
      checkIn: zonedTimeToUtc(toDateOnly('2026-03-12'), '09:00', 'Asia/Dubai'), checkOut: zonedTimeToUtc(toDateOnly('2026-03-12'), '20:00', 'Asia/Dubai'),
      workedMinutes: 600, overtimeMinutes: 120,
    },
  });
});

describe('payroll lifecycle', () => {
  let runId: string;

  it('salary changes take effect and are recorded in employee history', async () => {
    const hist = await prisma.employeeHistory.findFirst({ where: { employeeId: worker.employee.id, type: 'SALARY_CHANGE' } });
    expect(hist).not.toBeNull();
  });

  it('creates a single run per month', async () => {
    const res = await api().post('/api/payroll/runs').set(auth(payrollToken)).send({ year: YEAR, month: MONTH });
    expect(res.status).toBe(201);
    runId = res.body.id;
    expect((await api().post('/api/payroll/runs').set(auth(payrollToken)).send({ year: YEAR, month: MONTH })).status).toBe(409);
  });

  it('calculates payslips from salary, attendance and leave', async () => {
    const res = await api().post(`/api/payroll/runs/${runId}/calculate`).set(auth(payrollToken));
    expect(res.status).toBe(200);
    expect(res.body.run.status).toBe('CALCULATED');
    expect(res.body.run.employeeCount).toBe(4);

    const slip = await prisma.payslip.findUniqueOrThrow({ where: { runId_employeeId: { runId, employeeId: worker.employee.id } }, include: { lines: true } });
    const amt = (code: string) => Number(slip.lines.find((l) => l.componentCode === code)?.amount ?? 0);
    // Daily rate 9000/30 = 300; hourly 37.5
    expect(amt('BASIC')).toBe(9000);
    expect(amt('HOUSING')).toBe(3000);
    expect(amt('OT_NORMAL')).toBe(93.75);
    expect(amt('UNPAID_LEAVE')).toBe(300);
    expect(amt('ABSENCE')).toBe(300);
    expect(amt('PENSION')).toBe(450);
    expect(Number(slip.netPay)).toBe(9000 + 3000 + 93.75 - 300 - 300 - 450);

    // Joined 17 March: 15 days out of 30.
    const j = await prisma.payslip.findUniqueOrThrow({ where: { runId_employeeId: { runId, employeeId: joiner.employee.id } } });
    expect(Number(j.basicSalary)).toBe(3000);

    const rec = await api().get(`/api/payroll/runs/${runId}/reconcile`).set(auth(payrollToken));
    expect(rec.body.ok).toBe(true);
  });

  it('adjustments invalidate the calculation until recalculated', async () => {
    const adj = await api().post(`/api/payroll/runs/${runId}/adjustments`).set(auth(payrollToken)).send({ employeeId: worker.employee.id, type: 'EARNING', code: 'BONUS', description: 'Spot bonus', amount: 250 });
    expect(adj.status).toBe(201);
    expect((await prisma.payrollRun.findUniqueOrThrow({ where: { id: runId } })).status).toBe('DRAFT');
    expect((await api().post(`/api/payroll/runs/${runId}/submit`).set(auth(payrollToken)).send({})).status).toBe(422);
    await api().post(`/api/payroll/runs/${runId}/calculate`).set(auth(payrollToken));
    const slip = await prisma.payslip.findUniqueOrThrow({ where: { runId_employeeId: { runId, employeeId: worker.employee.id } } });
    expect(Number(slip.netPay)).toBe(11043.75 + 250);
  });

  it('the preparer cannot approve; finance approves and the period locks', async () => {
    const sub = await api().post(`/api/payroll/runs/${runId}/submit`).set(auth(payrollToken)).send({ comment: 'March payroll' });
    expect(sub.status).toBe(200);
    expect(sub.body.status).toBe('PENDING_APPROVAL');
    const approval = await prisma.approvalRequest.findUniqueOrThrow({ where: { requestType_entityId: { requestType: 'PAYROLL', entityId: `${runId}#0` } } });
    expect((await api().post(`/api/approvals/requests/${approval.id}/approve`).set(auth(payrollToken)).send({})).status).toBe(403);
    const ok = await api().post(`/api/approvals/requests/${approval.id}/approve`).set(auth(financeToken)).send({});
    expect(ok.body.status).toBe('APPROVED');
    const run = await prisma.payrollRun.findUniqueOrThrow({ where: { id: runId } });
    expect(run.status).toBe('APPROVED');
    expect(run.lockedAt).not.toBeNull();
  });

  it('locked periods reject attendance, leave and salary changes', async () => {
    const hr = await makeEmployee(ctx.company.id, { roles: ['HR_MANAGER', 'PAYROLL_OFFICER'] });
    const token = await login(hr.user.email);
    const att = await api().put('/api/attendance/records').set(auth(token)).send({ employeeId: worker.employee.id, date: '2026-03-20', checkIn: null, checkOut: null });
    expect(att.status).toBe(422);
    expect(att.body.error.message).toMatch(/locked/i);
    const sal = await api().post('/api/payroll/salaries').set(auth(payrollToken)).send({ employeeId: worker.employee.id, effectiveFrom: '2026-03-15', basicSalary: 9999, currency: 'AED' });
    expect(sal.status).toBe(422);
    expect((await api().post(`/api/payroll/runs/${runId}/calculate`).set(auth(payrollToken))).status).toBe(422);
    expect((await api().post(`/api/payroll/runs/${runId}/adjustments`).set(auth(payrollToken)).send({ employeeId: worker.employee.id, type: 'EARNING', description: 'Late fix', amount: 1 })).status).toBe(422);
  });

  it('the database itself refuses to modify approved payslips', async () => {
    const slip = await prisma.payslip.findFirstOrThrow({ where: { runId } });
    await expect(prisma.payslip.update({ where: { id: slip.id }, data: { netPay: 1 } })).rejects.toThrow(/cannot be modified/);
    await expect(prisma.payslipLine.deleteMany({ where: { payslipId: slip.id } })).rejects.toThrow(/cannot be changed/);
    await expect(prisma.payrollRun.delete({ where: { id: runId } })).rejects.toThrow();
    // Payment status changes remain possible.
    await prisma.payslip.update({ where: { id: slip.id }, data: { paymentStatus: 'ON_HOLD' } });
    await prisma.payslip.update({ where: { id: slip.id }, data: { paymentStatus: 'UNPAID' } });
  });

  it('employees see their payslip only once approved, and can download it as PDF', async () => {
    const token = await login(worker.user.email);
    const mine = await api().get('/api/payroll/my-payslips').set(auth(token));
    expect(mine.body.length).toBe(1);
    const pdf = await api().get(`/api/payroll/payslips/${mine.body[0].id}/pdf`).set(auth(token));
    expect(pdf.status).toBe(200);
    expect(pdf.headers['content-type']).toBe('application/pdf');
    // Not someone else's.
    const other = await prisma.payslip.findFirstOrThrow({ where: { runId, employeeId: finance.employee.id } });
    expect((await api().get(`/api/payroll/payslips/${other.id}`).set(auth(token))).status).toBe(404);
  });

  it('controlled reopening requires a reason and is audited', async () => {
    const officer = await makeEmployee(ctx.company.id, { roles: ['FINANCE_OFFICER'] });
    const token = await login(officer.user.email);
    expect((await api().post(`/api/payroll/runs/${runId}/reopen`).set(auth(token)).send({ reason: 'x' })).status).toBe(400);
    const res = await api().post(`/api/payroll/runs/${runId}/reopen`).set(auth(token)).send({ reason: 'Late overtime claims' });
    expect(res.body.status).toBe('DRAFT');
    expect(res.body.reopenCount).toBe(1);
    expect(await prisma.auditLog.findFirst({ where: { entity: 'PayrollRun', entityId: runId, action: 'REOPEN' } })).not.toBeNull();
    // Recalculate, resubmit, approve again.
    await api().post(`/api/payroll/runs/${runId}/calculate`).set(auth(payrollToken));
    await api().post(`/api/payroll/runs/${runId}/submit`).set(auth(payrollToken)).send({});
    const approval = await prisma.approvalRequest.findUniqueOrThrow({ where: { requestType_entityId: { requestType: 'PAYROLL', entityId: `${runId}#1` } } });
    expect((await api().post(`/api/approvals/requests/${approval.id}/approve`).set(auth(financeToken)).send({})).body.status).toBe('APPROVED');
  });

  it('bank file lists net pay and flags missing bank details; paying locks reopening', async () => {
    const file = await api().get(`/api/payroll/runs/${runId}/bank-file`).set(auth(financeToken));
    expect(file.status).toBe(200);
    expect(file.text).toContain('AE070331234567890123456');
    expect(file.headers['x-missing-bank-details']).toBeTruthy();
    const paid = await api().post(`/api/payroll/runs/${runId}/pay`).set(auth(financeToken)).send({ reference: 'TRX-1' });
    expect(paid.body.status).toBe('PAID');
    expect((await api().post(`/api/payroll/runs/${runId}/reopen`).set(auth(financeToken)).send({ reason: 'Try to reopen paid' })).status).toBe(422);
  });

  it('payroll register exports to Excel', async () => {
    const res = await api().get(`/api/payroll/runs/${runId}/register`).set(auth(payrollToken));
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/spreadsheetml/);
  });
});
