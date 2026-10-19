import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, auth, login, makeAdmin, makeCompany, makeEmployee, prisma, PASSWORD, uid } from '../helpers';
import { processEscalations } from '../../src/modules/workflow/engine';
import { mailPolicy, testOutbox } from '../../src/lib/mailer';

let ctx: Awaited<ReturnType<typeof makeCompany>>;
let hr: Awaited<ReturnType<typeof makeEmployee>>;
let hrToken: string;
let admin: Awaited<ReturnType<typeof makeAdmin>>;
let adminToken: string;
let day = 0;

/** A distinct weekday in December 2026 for each leave request, so requests never overlap. */
function nextWeekday() {
  const d = new Date(Date.UTC(2026, 11, 1));
  let n = day++;
  while (true) {
    if (![0, 6].includes(d.getUTCDay()) && n-- === 0) return d.toISOString().slice(0, 10);
    d.setUTCDate(d.getUTCDate() + 1);
  }
}

async function requestLeave(employee: { user: { email: string } }) {
  const token = await login(employee.user.email);
  const date = nextWeekday();
  const res = await api().post('/api/leave/requests').set(auth(token)).send({ leaveTypeId: ctx.annual.id, startDate: date, endDate: date });
  expect(res.status).toBe(201);
  return prisma.approvalRequest.findUniqueOrThrow({ where: { requestType_entityId: { requestType: 'LEAVE', entityId: res.body.id } } });
}

beforeAll(async () => {
  ctx = await makeCompany();
  hr = await makeEmployee(ctx.company.id, { roles: ['HR_ADMIN'] });
  hrToken = await login(hr.user.email);
  admin = await makeAdmin(ctx.company.id);
  adminToken = await login(admin.email);
});

describe('escalation on a business-hours SLA', () => {
  let boss: Awaited<ReturnType<typeof makeEmployee>>;
  let manager: Awaited<ReturnType<typeof makeEmployee>>;
  let worker: Awaited<ReturnType<typeof makeEmployee>>;

  beforeAll(async () => {
    boss = await makeEmployee(ctx.company.id, { hireDate: '2020-01-01' });
    manager = await makeEmployee(ctx.company.id, { hireDate: '2020-01-01', managerId: boss.employee.id });
    worker = await makeEmployee(ctx.company.id, { hireDate: '2020-01-01', managerId: manager.employee.id });
    await prisma.workflowDefinition.create({
      data: {
        companyId: ctx.company.id, requestType: 'LEAVE', name: 'Leave',
        steps: { create: [{ order: 1, name: 'Manager', approverType: 'DIRECT_MANAGER', escalateAfterHours: 24, escalateToType: 'MANAGERS_MANAGER' }] },
      },
    });
  });

  it("escalates to the manager's manager only after 24 business hours, naming them in the history", async () => {
    const approval = await requestLeave(worker);
    // Submitted Friday 16:47 Dubai time.
    await prisma.approvalRequest.update({ where: { id: approval.id }, data: { stepEnteredAt: new Date('2026-10-16T12:47:00Z') } });

    await processEscalations(new Date('2026-10-19T12:46:00Z')); // Monday 16:46: not yet
    expect(await prisma.approvalAction.count({ where: { requestId: approval.id, decision: 'ESCALATED' } })).toBe(0);

    await processEscalations(new Date('2026-10-19T12:48:00Z')); // Monday 16:48
    const escalated = await prisma.approvalAction.findFirstOrThrow({ where: { requestId: approval.id, decision: 'ESCALATED' } });
    expect(escalated.comment).toContain(`${boss.employee.firstName} ${boss.employee.lastName}`);
    const tasks = await prisma.approvalTask.findMany({ where: { requestId: approval.id, status: 'OPEN' } });
    expect(tasks.map((t) => t.assigneeId).sort()).toEqual([manager.user.id, boss.user.id].sort());

    // Either the original approver or the escalation target can now decide.
    const ok = await api().post(`/api/approvals/requests/${approval.id}/approve`).set(auth(await login(boss.user.email))).send({});
    expect(ok.body.status).toBe('APPROVED');
  });

  it('falls back to the fallback approver when the escalation target is nobody', async () => {
    // The manager has no manager of their own.
    const approval = await requestLeave({ user: manager.user });
    await prisma.approvalRequest.update({ where: { id: approval.id }, data: { stepEnteredAt: new Date('2026-10-16T12:47:00Z') } });
    await processEscalations(new Date('2026-10-20T12:00:00Z'));
    const escalated = await prisma.approvalAction.findFirstOrThrow({ where: { requestId: approval.id, decision: 'ESCALATED' } });
    expect(escalated.comment).toMatch(/fallback approver/);
    expect(await prisma.approvalTask.count({ where: { requestId: approval.id, assigneeId: hr.user.id, status: 'OPEN' } })).toBe(1);
  });

  it('rejects an escalation threshold without a target', async () => {
    const res = await api().post('/api/workflows').set(auth(adminToken)).send({
      companyId: ctx.company.id, requestType: 'OVERTIME', name: 'OT', steps: [{ name: 'Mgr', approverType: 'DIRECT_MANAGER', escalateAfterHours: 8 }],
    });
    expect(res.status).toBe(400);
  });
});

describe('approval override', () => {
  it('requires a comment, is not allowed on your own request, and is recorded as OVERRIDE_APPROVE', async () => {
    const worker = await makeEmployee(ctx.company.id, { hireDate: '2020-01-01' });
    const owner = await makeEmployee(ctx.company.id, { hireDate: '2020-01-01' });
    await prisma.employee.update({ where: { id: worker.employee.id }, data: { managerId: owner.employee.id } });
    const approval = await requestLeave(worker);

    const detail = await api().get(`/api/approvals/requests/${approval.id}`).set(auth(hrToken));
    expect(detail.body.canOverride).toBe(true);
    expect(detail.body.canAct).toBe(false);

    const noComment = await api().post(`/api/approvals/requests/${approval.id}/override`).set(auth(hrToken)).send({ decision: 'APPROVED', comment: '  ' });
    expect(noComment.status).toBe(400);
    const employeeTry = await api().post(`/api/approvals/requests/${approval.id}/override`).set(auth(await login(worker.user.email))).send({ decision: 'APPROVED', comment: 'please' });
    expect(employeeTry.status).toBe(403);

    const ok = await api()
      .post(`/api/approvals/requests/${approval.id}/override`)
      .set(auth(hrToken))
      .set('User-Agent', 'qa-agent/1.0')
      .set('X-Forwarded-For', '203.0.113.9')
      .send({ decision: 'APPROVED', comment: 'Manager on leave; approved per policy' });
    expect(ok.status).toBe(200);
    expect(ok.body.status).toBe('APPROVED');

    const action = await prisma.approvalAction.findFirstOrThrow({ where: { requestId: approval.id, decision: 'OVERRIDE_APPROVE' } });
    expect(action.actorId).toBe(hr.user.id);
    expect(await prisma.approvalTask.count({ where: { requestId: approval.id, status: 'OPEN' } })).toBe(0);
    const log = await prisma.auditLog.findFirstOrThrow({ where: { action: 'OVERRIDE_APPROVE', entityId: approval.entityId } });
    expect(log.userAgent).toBe('qa-agent/1.0');
    expect(log.ip).toBe('203.0.113.9');

    const handled = await api().get('/api/approvals/requests').query({ view: 'handled' }).set(auth(hrToken));
    expect(handled.body.items.map((i: { id: string }) => i.id)).toContain(approval.id);
  });

  it('an override reject finalises the request', async () => {
    const worker = await makeEmployee(ctx.company.id, { hireDate: '2020-01-01' });
    const approval = await requestLeave(worker);
    const res = await api().post(`/api/approvals/requests/${approval.id}/override`).set(auth(hrToken)).send({ decision: 'REJECTED', comment: 'Blackout period' });
    expect(res.body.status).toBe('REJECTED');
    expect(await prisma.auditLog.count({ where: { action: 'OVERRIDE_REJECT', entityId: approval.entityId } })).toBe(1);
  });

  it('payroll overrides also need payroll.approve', async () => {
    const req = await prisma.approvalRequest.create({
      data: { companyId: ctx.company.id, requestType: 'PAYROLL', entityId: crypto.randomUUID(), requesterId: admin.user.id, title: 'Payroll test', status: 'PENDING', currentStep: 1 },
    });
    const res = await api().post(`/api/approvals/requests/${req.id}/override`).set(auth(hrToken)).send({ decision: 'APPROVED', comment: 'x' });
    expect(res.status).toBe(403);
    const detail = await api().get(`/api/approvals/requests/${req.id}`).set(auth(hrToken));
    expect(detail.body.canOverride).toBe(false);
    await prisma.approvalRequest.update({ where: { id: req.id }, data: { status: 'CANCELLED' } });
  });
});

describe('workflow settings and coverage', () => {
  it('reports what happens to each request type and stores the auto-approve list', async () => {
    const put = await api().put('/api/workflows/settings').set(auth(adminToken)).send({ companyId: ctx.company.id, workflowFallbackRole: 'HR_ADMIN', autoApproveRequestTypes: ['DOCUMENT'] });
    expect(put.status).toBe(200);
    const bad = await api().put('/api/workflows/settings').set(auth(adminToken)).send({ companyId: ctx.company.id, workflowFallbackRole: 'NO_SUCH_ROLE', autoApproveRequestTypes: [] });
    expect(bad.status).toBe(400);
    const cov = await api().get('/api/workflows/coverage').query({ companyId: ctx.company.id }).set(auth(adminToken));
    const byType = Object.fromEntries(cov.body.map((c: { requestType: string }) => [c.requestType, c]));
    expect(byType.LEAVE).toMatchObject({ workflows: 1, fullyCovered: true });
    expect(byType.DOCUMENT).toMatchObject({ workflows: 0, otherwise: 'AUTO_APPROVE' });
    expect(byType.EXPENSE).toMatchObject({ workflows: 0, otherwise: 'FALLBACK', fallbackRole: 'HR_ADMIN' });
  });
});

describe('audit trail', () => {
  it('lists UPLOAD and override actions in the filter and never returns hashes or encrypted values', async () => {
    await prisma.auditLog.create({ data: { action: 'UPDATE', entity: 'Employee', entityId: 'legacy', before: { nationalIdHash: 'h', nationalIdEnc: 'e' }, after: { nationalIdHash: 'h2', nationalIdEnc: 'e2', phone: '+971501234567' } } });
    const facets = await api().get('/api/audit/facets').set(auth(adminToken));
    expect(facets.body.actions).toEqual(expect.arrayContaining(['UPLOAD', 'OVERRIDE_APPROVE', 'OVERRIDE_REJECT']));
    const list = await api().get('/api/audit').query({ entityId: 'legacy' }).set(auth(adminToken));
    const text = JSON.stringify(list.body.items);
    expect(text).not.toMatch(/Hash|Enc"/);
    expect(list.body.items[0].after).toEqual({ nationalId: '[protected]', phone: '+971501234567' });
  });
});

describe('MFA required by role', () => {
  let role: { id: string };
  afterAll(async () => {
    if (role) await prisma.role.update({ where: { id: role.id }, data: { requireMfa: false } });
  });

  it('holders of a role that requires MFA must enrol before using the app', async () => {
    role = await prisma.role.findUniqueOrThrow({ where: { code: 'RECRUITMENT_OFFICER' } });
    const recruiter = await makeEmployee(ctx.company.id, { roles: ['RECRUITMENT_OFFICER'] });
    const before = await login(recruiter.user.email);
    expect((await api().get('/api/employees').set(auth(before))).status).toBe(200);

    const set = await api().put(`/api/roles/${role.id}/mfa`).set(auth(adminToken)).send({ requireMfa: true });
    expect(set.status).toBe(200);
    expect(await prisma.auditLog.count({ where: { entity: 'Role', entityId: role.id, action: 'UPDATE' } })).toBeGreaterThan(0);

    const token = await login(recruiter.user.email);
    const me = await api().get('/api/auth/me').set(auth(token));
    expect(me.body.mfaSetupRequired).toBe(true);
    const blocked = await api().get('/api/employees').set(auth(token));
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe('MFA_SETUP_REQUIRED');

    // Only role managers may change it.
    const denied = await api().put(`/api/roles/${role.id}/mfa`).set(auth(hrToken)).send({ requireMfa: false });
    expect(denied.status).toBe(403);
  });
});

describe('account invitations', () => {
  afterAll(() => {
    mailPolicy.configured = false;
  });

  it('without email configured, a new account gets a temporary password', async () => {
    mailPolicy.configured = false;
    const res = await api().post('/api/users').set(auth(adminToken)).send({ email: `tmp-${uid()}@test.local`, displayName: 'Temp', roleCodes: ['EMPLOYEE'], companyId: ctx.company.id });
    expect(res.status).toBe(201);
    expect(res.body.temporaryPassword).toBeTruthy();
    expect(res.body.inviteSent).toBeUndefined();
  });

  it('with email configured, sends a single-use 72-hour link instead of a password', async () => {
    mailPolicy.configured = true;
    const email = `inv-${uid()}@test.local`;
    const res = await api().post('/api/users').set(auth(adminToken)).send({ email, displayName: 'Invitee', roleCodes: ['EMPLOYEE'], companyId: ctx.company.id });
    expect(res.status).toBe(201);
    expect(res.body.inviteSent).toBe(true);
    expect(res.body.temporaryPassword).toBeUndefined();
    const hours = (new Date(res.body.inviteExpiresAt).getTime() - Date.now()) / 3_600_000;
    expect(hours).toBeGreaterThan(71.9);
    expect(hours).toBeLessThanOrEqual(72);

    const mail = testOutbox.filter((m) => m.to === email).at(-1)!;
    const token = decodeURIComponent(/accept-invite\?token=([^\s"&<]+)/.exec(mail.text)![1]);
    // Nobody knows the account's password until the invitation is accepted.
    expect((await api().post('/api/auth/login').send({ email, password: PASSWORD })).status).toBe(401);

    const check = await api().get('/api/auth/invite').query({ token });
    expect(check.body.email).toBe(email);
    const weak = await api().post('/api/auth/invite/accept').send({ token, password: 'short' });
    expect(weak.status).toBe(400);
    const accept = await api().post('/api/auth/invite/accept').send({ token, password: 'N3w-Strong-Pass!' });
    expect(accept.status).toBe(200);
    const signedIn = await api().post('/api/auth/login').send({ email, password: 'N3w-Strong-Pass!' });
    expect(signedIn.status).toBe(200);
    expect(signedIn.body.user?.mustChangePassword ?? false).toBe(false);

    const again = await api().post('/api/auth/invite/accept').send({ token, password: 'An0ther-Pass!' });
    expect(again.status).toBe(400);
    expect(await prisma.auditLog.count({ where: { action: 'INVITE_ACCEPTED', entityId: res.body.id } })).toBe(1);
  });

  it('expired or replaced links stop working', async () => {
    mailPolicy.configured = true;
    const email = `exp-${uid()}@test.local`;
    const res = await api().post('/api/users').set(auth(adminToken)).send({ email, displayName: 'Late', roleCodes: ['EMPLOYEE'], companyId: ctx.company.id });
    const firstToken = decodeURIComponent(/token=([^\s"&<]+)/.exec(testOutbox.filter((m) => m.to === email).at(-1)!.text)![1]);
    const resend = await api().post(`/api/users/${res.body.id}/invite`).set(auth(adminToken)).send({});
    expect(resend.status).toBe(200);
    expect((await api().get('/api/auth/invite').query({ token: firstToken })).status).toBe(400);

    const secondToken = decodeURIComponent(/token=([^\s"&<]+)/.exec(testOutbox.filter((m) => m.to === email).at(-1)!.text)![1]);
    await prisma.userInvite.updateMany({ where: { userId: res.body.id, usedAt: null }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await api().post('/api/auth/invite/accept').send({ token: secondToken, password: 'N3w-Strong-Pass!' })).status).toBe(400);
  });
});
