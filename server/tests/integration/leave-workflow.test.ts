import { beforeAll, describe, expect, it } from 'vitest';
import { api, auth, login, makeCompany, makeEmployee, makeWorkflow, prisma } from '../helpers';

let ctx: Awaited<ReturnType<typeof makeCompany>>;
let manager: Awaited<ReturnType<typeof makeEmployee>>;
let hr: Awaited<ReturnType<typeof makeEmployee>>;
let mgrToken: string;
let hrToken: string;

// Next Monday–Wednesday etc. computed relative to a fixed future week to keep weekdays stable.
const NEXT_YEAR = new Date().getUTCFullYear() + 1;
const mondayOf = (week: number) => {
  const jan1 = new Date(Date.UTC(NEXT_YEAR, 0, 1));
  const firstMonday = new Date(jan1);
  while (firstMonday.getUTCDay() !== 1) firstMonday.setUTCDate(firstMonday.getUTCDate() + 1);
  firstMonday.setUTCDate(firstMonday.getUTCDate() + 7 * week);
  return firstMonday;
};
const iso = (d: Date, plus = 0) => new Date(d.getTime() + plus * 86_400_000).toISOString().slice(0, 10);

beforeAll(async () => {
  ctx = await makeCompany();
  manager = await makeEmployee(ctx.company.id);
  hr = await makeEmployee(ctx.company.id, { roles: ['HR_MANAGER'] });
  mgrToken = await login(manager.user.email);
  hrToken = await login(hr.user.email);
  await makeWorkflow(ctx.company.id, 'LEAVE', [
    { name: 'Manager', approverType: 'DIRECT_MANAGER' },
    { name: 'HR for long leave', approverType: 'ROLE', roleCode: 'HR_MANAGER', minAmount: 5.5 },
  ]);
});

async function employee() {
  const e = await makeEmployee(ctx.company.id, { managerId: manager.employee.id, hireDate: '2020-01-01' });
  return { ...e, token: await login(e.user.email) };
}

async function balance(token: string) {
  const res = await api().get(`/api/leave/balances?year=${NEXT_YEAR}`).set(auth(token));
  return res.body.find((b: { leaveType: { code: string } }) => b.leaveType.code === 'ANNUAL');
}

describe('leave requests and approval workflow', () => {
  it('counts only working days and holds them as pending until approved', async () => {
    const e = await employee();
    const mon = mondayOf(2);
    const res = await api().post('/api/leave/requests').set(auth(e.token)).send({ leaveTypeId: ctx.annual.id, startDate: iso(mon), endDate: iso(mon, 6), reason: 'Trip' });
    expect(res.status).toBe(201);
    expect(Number(res.body.days)).toBe(5); // Mon–Sun spans 5 working days
    expect(res.body.status).toBe('PENDING');
    const bal = await balance(e.token);
    expect(Number(bal.pending)).toBe(5);
    expect(bal.available).toBe(19);
  });

  it('manager approval completes a short request, consumes balance and marks attendance', async () => {
    const e = await employee();
    const mon = mondayOf(3);
    const req = await api().post('/api/leave/requests').set(auth(e.token)).send({ leaveTypeId: ctx.annual.id, startDate: iso(mon), endDate: iso(mon, 2) });
    const inbox = await api().get('/api/approvals/inbox').set(auth(mgrToken));
    const item = inbox.body.items.find((i: { entityId: string }) => i.entityId === req.body.id);
    expect(item).toBeTruthy();
    // The employee cannot approve their own request.
    expect((await api().post(`/api/approvals/requests/${item.id}/approve`).set(auth(e.token)).send({})).status).toBe(403);
    const ok = await api().post(`/api/approvals/requests/${item.id}/approve`).set(auth(mgrToken)).send({ comment: 'Enjoy' });
    expect(ok.status).toBe(200);
    expect(ok.body.status).toBe('APPROVED');
    const leave = await prisma.leaveRequest.findUniqueOrThrow({ where: { id: req.body.id } });
    expect(leave.status).toBe('APPROVED');
    const bal = await balance(e.token);
    expect(Number(bal.used)).toBe(3);
    expect(Number(bal.pending)).toBe(0);
    const att = await prisma.attendanceRecord.count({ where: { employeeId: e.employee.id, status: 'ON_LEAVE' } });
    expect(att).toBe(3);
  });

  it('long requests need a second (HR) approval step', async () => {
    const e = await employee();
    const mon = mondayOf(5);
    const req = await api().post('/api/leave/requests').set(auth(e.token)).send({ leaveTypeId: ctx.annual.id, startDate: iso(mon), endDate: iso(mon, 11) });
    expect(Number(req.body.days)).toBe(10);
    const approval = await prisma.approvalRequest.findUniqueOrThrow({ where: { requestType_entityId: { requestType: 'LEAVE', entityId: req.body.id } } });
    const step1 = await api().post(`/api/approvals/requests/${approval.id}/approve`).set(auth(mgrToken)).send({});
    expect(step1.body.status).toBe('PENDING');
    expect(step1.body.currentStep).toBe(2);
    // The manager cannot approve step 2.
    expect((await api().post(`/api/approvals/requests/${approval.id}/approve`).set(auth(mgrToken)).send({})).status).toBe(403);
    const step2 = await api().post(`/api/approvals/requests/${approval.id}/approve`).set(auth(hrToken)).send({});
    expect(step2.body.status).toBe('APPROVED');
    const detail = await api().get(`/api/approvals/requests/${approval.id}`).set(auth(e.token));
    expect(detail.body.actions.map((a: { decision: string }) => a.decision)).toEqual(['SUBMITTED', 'APPROVED', 'APPROVED']);
  });

  it('rejection requires a comment and releases the pending days', async () => {
    const e = await employee();
    const mon = mondayOf(7);
    const req = await api().post('/api/leave/requests').set(auth(e.token)).send({ leaveTypeId: ctx.annual.id, startDate: iso(mon), endDate: iso(mon, 1) });
    const approval = await prisma.approvalRequest.findUniqueOrThrow({ where: { requestType_entityId: { requestType: 'LEAVE', entityId: req.body.id } } });
    expect((await api().post(`/api/approvals/requests/${approval.id}/reject`).set(auth(mgrToken)).send({})).status).toBe(400);
    const rej = await api().post(`/api/approvals/requests/${approval.id}/reject`).set(auth(mgrToken)).send({ comment: 'Peak season' });
    expect(rej.body.status).toBe('REJECTED');
    const bal = await balance(e.token);
    expect(Number(bal.pending)).toBe(0);
    const notes = await prisma.notification.findMany({ where: { userId: e.user.id, type: 'APPROVAL_DECIDED' } });
    expect(notes.length).toBe(1);
  });

  it('blocks overlapping requests and insufficient balance', async () => {
    const e = await employee();
    const mon = mondayOf(9);
    await api().post('/api/leave/requests').set(auth(e.token)).send({ leaveTypeId: ctx.annual.id, startDate: iso(mon), endDate: iso(mon, 2) });
    const overlap = await api().post('/api/leave/requests').set(auth(e.token)).send({ leaveTypeId: ctx.annual.id, startDate: iso(mon, 2), endDate: iso(mon, 3) });
    expect(overlap.status).toBe(422);
    expect(overlap.body.error.message).toMatch(/overlaps/i);
    const tooLong = await api().post('/api/leave/requests').set(auth(e.token)).send({ leaveTypeId: ctx.annual.id, startDate: iso(mondayOf(12)), endDate: iso(mondayOf(12), 40) });
    expect(tooLong.status).toBe(422);
    expect(tooLong.body.error.message).toMatch(/insufficient/i);
  });

  it('employees can withdraw pending requests', async () => {
    const e = await employee();
    const mon = mondayOf(15);
    const req = await api().post('/api/leave/requests').set(auth(e.token)).send({ leaveTypeId: ctx.annual.id, startDate: iso(mon), endDate: iso(mon) });
    const cancel = await api().post(`/api/leave/requests/${req.body.id}/cancel`).set(auth(e.token)).send({ reason: 'Plans changed' });
    expect(cancel.status).toBe(200);
    expect(cancel.body.status).toBe('CANCELLED');
    const approval = await prisma.approvalRequest.findUniqueOrThrow({ where: { requestType_entityId: { requestType: 'LEAVE', entityId: req.body.id } } });
    expect(approval.status).toBe('CANCELLED');
    expect(Number((await balance(e.token)).pending)).toBe(0);
  });

  it('auto-approves without a workflow only when the request type is configured to', async () => {
    const solo = await makeCompany({ autoApprove: ['LEAVE'] });
    const e = await makeEmployee(solo.company.id, { hireDate: '2020-01-01' });
    const token = await login(e.user.email);
    const res = await api().post('/api/leave/requests').set(auth(token)).send({ leaveTypeId: solo.annual.id, startDate: iso(mondayOf(4)), endDate: iso(mondayOf(4)) });
    expect(res.body.status).toBe('APPROVED');
    const approval = await prisma.approvalRequest.findUniqueOrThrow({ where: { requestType_entityId: { requestType: 'LEAVE', entityId: res.body.id } }, include: { actions: true } });
    expect(approval.actions.find((a) => a.decision === 'APPROVED')?.comment).toMatch(/configured to auto-approve/);
  });

  it('without a workflow, routes to the fallback approver instead of approving', async () => {
    const solo = await makeCompany();
    const hr = await makeEmployee(solo.company.id, { roles: ['HR_ADMIN'] });
    const e = await makeEmployee(solo.company.id, { hireDate: '2020-01-01' });
    const token = await login(e.user.email);
    const res = await api().post('/api/leave/requests').set(auth(token)).send({ leaveTypeId: solo.annual.id, startDate: iso(mondayOf(4)), endDate: iso(mondayOf(4)) });
    expect(res.body.status).toBe('PENDING');
    const approval = await prisma.approvalRequest.findUniqueOrThrow({ where: { requestType_entityId: { requestType: 'LEAVE', entityId: res.body.id } }, include: { actions: true, tasks: true } });
    expect(approval.tasks.map((t) => t.assigneeId)).toEqual([hr.user.id]);
    expect(approval.actions.find((a) => a.decision === 'COMMENT')?.comment).toMatch(/fallback approver \(HR_ADMIN\)/);
    const hrToken = await login(hr.user.email);
    const ok = await api().post(`/api/approvals/requests/${approval.id}/approve`).set(auth(hrToken)).send({});
    expect(ok.body.status).toBe('APPROVED');
  });

  it('delegated approvers receive tasks while the delegation is active', async () => {
    const deputy = await makeEmployee(ctx.company.id);
    const today = new Date().toISOString().slice(0, 10);
    const del = await api().post('/api/approvals/delegations').set(auth(mgrToken)).send({ toUserId: deputy.user.id, startDate: today, endDate: today });
    expect(del.status).toBe(201);
    const e = await employee();
    const req = await api().post('/api/leave/requests').set(auth(e.token)).send({ leaveTypeId: ctx.annual.id, startDate: iso(mondayOf(20)), endDate: iso(mondayOf(20)) });
    const deputyToken = await login(deputy.user.email);
    const approval = await prisma.approvalRequest.findUniqueOrThrow({ where: { requestType_entityId: { requestType: 'LEAVE', entityId: req.body.id } } });
    const ok = await api().post(`/api/approvals/requests/${approval.id}/approve`).set(auth(deputyToken)).send({});
    expect(ok.body.status).toBe('APPROVED');
    await api().delete(`/api/approvals/delegations/${del.body.id}`).set(auth(mgrToken));
  });
});
