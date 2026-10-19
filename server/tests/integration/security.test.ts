import jwt from 'jsonwebtoken';
import { authenticator } from 'otplib';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { api, auth, login, makeAdmin, makeCompany, makeEmployee, prisma, PASSWORD } from '../helpers';
import { encrypt } from '../../src/lib/crypto';
import { csvCell } from '../../src/lib/csv';
import { env, policy } from '../../src/config/env';

let a: Awaited<ReturnType<typeof makeCompany>>;
let b: Awaited<ReturnType<typeof makeCompany>>;
let adminToken: string;

beforeAll(async () => {
  a = await makeCompany();
  b = await makeCompany();
  adminToken = await login((await makeAdmin(a.company.id)).email);
});

const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');
const PDF = Buffer.from('%PDF-1.4\n%test\n');

describe('role and user administration cannot escalate privileges', () => {
  it('does not let an HR administrator grant roles with access they lack', async () => {
    const hr = await makeEmployee(a.company.id, { roles: ['HR_ADMIN'] });
    const token = await login(hr.user.email);
    const create = (roleCodes: string[]) => api().post('/api/users').set(auth(token)).send({ email: `u${Date.now()}${Math.random()}@test.local`, displayName: 'U', roleCodes });
    expect((await create(['FINANCE_OFFICER'])).status).toBe(403); // payroll approve/pay
    expect((await create(['AUDITOR'])).status).toBe(403); // all-company scope
    const ok = await create(['EMPLOYEE']);
    expect(ok.status).toBe(201);
    const assignment = await prisma.userRole.findFirstOrThrow({ where: { userId: ok.body.id } });
    expect(assignment.companyId).toBe(a.company.id); // not an unrestricted, all-company grant
  });

  it('does not let an HR administrator give themselves more roles', async () => {
    const hr = await makeEmployee(a.company.id, { roles: ['HR_ADMIN'] });
    const token = await login(hr.user.email);
    const res = await api().put(`/api/users/${hr.user.id}`).set(auth(token)).send({ roleCodes: ['HR_ADMIN', 'FINANCE_OFFICER'] });
    expect(res.status).toBe(403);
  });

  it('does not let an HR administrator take over a more privileged account', async () => {
    const hr = await makeEmployee(a.company.id, { roles: ['HR_ADMIN'] });
    const finance = await makeEmployee(a.company.id, { roles: ['FINANCE_OFFICER'] });
    const token = await login(hr.user.email);
    expect((await api().post(`/api/users/${finance.user.id}/reset-password`).set(auth(token))).status).toBe(403);
  });

  it('does not let an HR administrator manage users of another company', async () => {
    const hr = await makeEmployee(a.company.id, { roles: ['HR_ADMIN'] });
    const other = await makeEmployee(b.company.id);
    const token = await login(hr.user.email);
    expect((await api().post(`/api/users/${other.user.id}/reset-password`).set(auth(token))).status).toBe(404);
  });

  it('does not let a user re-link their own account to another employee', async () => {
    const hr = await makeEmployee(a.company.id, { roles: ['HR_ADMIN'] });
    const victim = await makeEmployee(a.company.id);
    await prisma.user.update({ where: { id: victim.user.id }, data: { employeeId: null } });
    const token = await login(hr.user.email);
    expect((await api().put(`/api/users/${hr.user.id}`).set(auth(token)).send({ employeeId: victim.employee.id })).status).toBe(403);
  });

  it('does not let a role manager add permissions they lack to a role', async () => {
    const role = await prisma.role.create({ data: { code: `RM${Date.now()}`, name: 'Role manager', dataScope: 'COMPANY', permissions: { create: [{ permission: { connect: { code: 'role.manage' } } }] } } });
    const u = await makeEmployee(a.company.id);
    await prisma.userRole.create({ data: { userId: u.user.id, roleId: role.id, companyId: a.company.id } });
    const token = await login(u.user.email);
    const res = await api().put(`/api/roles/${role.id}`).set(auth(token)).send({ name: 'Role manager', dataScope: 'COMPANY', permissions: ['role.manage', 'payroll.approve'] });
    expect(res.status).toBe(403);
  });
});

describe('cross-company approval requests', () => {
  it('hides another company’s approval request from approval.read.all holders', async () => {
    const hrm = await makeEmployee(a.company.id, { roles: ['HR_MANAGER'] });
    const requester = await makeEmployee(b.company.id);
    const req = await prisma.approvalRequest.create({ data: { companyId: b.company.id, requestType: 'LEAVE', entityId: requester.employee.id, requesterId: requester.user.id, title: 'Leave' } });
    const token = await login(hrm.user.email);
    expect((await api().get(`/api/approvals/requests/${req.id}`).set(auth(token))).status).toBe(404);
  });
});

describe('file uploads', () => {
  it('rejects a file whose content does not match an allowed type', async () => {
    const emp = await makeEmployee(a.company.id);
    const html = Buffer.from('<html><script>alert(1)</script></html>');
    const res = await api().post(`/api/employees/${emp.employee.id}/photo`).set(auth(adminToken)).attach('file', html, { filename: 'x.html', contentType: 'image/png' });
    expect(res.status).toBe(400);
    const pdfAsPhoto = await api().post(`/api/employees/${emp.employee.id}/photo`).set(auth(adminToken)).attach('file', PDF, { filename: 'x.png', contentType: 'image/png' });
    expect(pdfAsPhoto.status).toBe(400);
  });

  it('stores files under the detected type and serves them safely', async () => {
    const emp = await makeEmployee(a.company.id);
    const photo = await api().post(`/api/employees/${emp.employee.id}/photo`).set(auth(adminToken)).attach('file', PNG, { filename: 'evil.html', contentType: 'image/png' });
    expect(photo.status).toBe(200);
    expect(photo.body.photoPath).toMatch(/\.png$/);
    const get = await api().get(`/api/employees/${emp.employee.id}/photo`).set(auth(adminToken));
    expect(get.headers['content-type']).toBe('image/png');
    expect(get.headers['content-security-policy']).toContain('sandbox');

    const doc = await api().post(`/api/employees/${emp.employee.id}/documents`).set(auth(adminToken)).field('type', 'OTHER').field('title', 'Doc').attach('file', PDF, { filename: 'contract.pdf', contentType: 'application/pdf' });
    expect(doc.status).toBe(201);
    const dl = await api().get(`/api/employees/${emp.employee.id}/documents/${doc.body.id}/download`).set(auth(adminToken));
    expect(dl.status).toBe(200);
    expect(dl.headers['content-type']).toBe('application/pdf');
    expect(dl.headers['content-disposition']).toMatch(/^attachment/);
  });
});

describe('sign-in hardening', () => {
  afterEach(() => {
    policy.mfaRequiredForAdmins = false;
  });

  it('gives the same message for a locked account as for a wrong password', async () => {
    const { email } = await makeAdmin(a.company.id);
    const wrong = await api().post('/api/auth/login').send({ email, password: 'wrong-password1' });
    for (let i = 0; i < 4; i++) await api().post('/api/auth/login').send({ email, password: 'wrong-password1' });
    const locked = await api().post('/api/auth/login').send({ email, password: PASSWORD });
    expect(locked.status).toBe(401);
    expect(locked.body.error.message).toBe(wrong.body.error.message);
  });

  it('counts wrong MFA codes toward the lockout', async () => {
    const secret = authenticator.generateSecret();
    const { email, user } = await makeAdmin(a.company.id);
    await prisma.user.update({ where: { id: user.id }, data: { mfaEnabled: true, mfaSecretEnc: encrypt(secret) } });
    const valid = authenticator.generate(secret);
    const wrong = valid === '000000' ? '111111' : '000000';
    for (let i = 0; i < 5; i++) await api().post('/api/auth/login').send({ email, password: PASSWORD, mfaCode: wrong });
    const res = await api().post('/api/auth/login').send({ email, password: PASSWORD, mfaCode: authenticator.generate(secret) });
    expect(res.status).toBe(401);
  });

  it('allows only password change while a temporary password is in use', async () => {
    const { user } = await makeEmployee(a.company.id);
    await prisma.user.update({ where: { id: user.id }, data: { mustChangePassword: true } });
    const token = await login(user.email);
    expect((await api().get('/api/auth/me').set(auth(token))).status).toBe(200);
    const blocked = await api().get('/api/notifications').set(auth(token));
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe('PASSWORD_CHANGE_REQUIRED');
    expect((await api().post('/api/auth/change-password').set(auth(token)).send({ currentPassword: PASSWORD, newPassword: 'Changed123' })).status).toBe(204);
    expect((await api().get('/api/notifications').set(auth(token))).status).toBe(200);
  });

  it('requires administrators to enrol MFA when the policy is on', async () => {
    policy.mfaRequiredForAdmins = true;
    const { email } = await makeAdmin(a.company.id);
    const token = await login(email);
    const me = await api().get('/api/auth/me').set(auth(token));
    expect(me.body.mfaSetupRequired).toBe(true);
    const blocked = await api().get('/api/employees').set(auth(token));
    expect(blocked.body.error.code).toBe('MFA_SETUP_REQUIRED');
    expect((await api().post('/api/auth/mfa/setup').set(auth(token))).status).toBe(200);
    // Regular employees are not affected.
    const { user } = await makeEmployee(a.company.id);
    expect((await api().get('/api/notifications').set(auth(await login(user.email)))).status).toBe(200);
  });

  it('requires the password to turn on MFA', async () => {
    const { user } = await makeEmployee(a.company.id);
    const token = await login(user.email);
    const setup = await api().post('/api/auth/mfa/setup').set(auth(token));
    const code = authenticator.generate(setup.body.secret);
    expect((await api().post('/api/auth/mfa/enable').set(auth(token)).send({ code, password: 'not-my-password1' })).status).toBe(400);
    expect((await api().post('/api/auth/mfa/enable').set(auth(token)).send({ code, password: PASSWORD })).status).toBe(204);
  });

  it('ends idle sessions on refresh', async () => {
    const { email } = await makeAdmin(a.company.id);
    const res = await api().post('/api/auth/login').send({ email, password: PASSWORD });
    const cookie = res.headers['set-cookie'][0].split(';')[0];
    const sid = decodeURIComponent(cookie.split('=')[1]).split('.')[0];
    await prisma.session.update({ where: { id: sid }, data: { lastUsedAt: new Date(Date.now() - (env.SESSION_IDLE_MINUTES + 1) * 60_000) } });
    expect((await api().post('/api/auth/refresh').set('Cookie', cookie)).status).toBe(401);
  });

  it('rejects tokens with another algorithm or audience', async () => {
    const { email, user } = await makeAdmin(a.company.id);
    await login(email);
    const session = await prisma.session.findFirstOrThrow({ where: { userId: user.id } });
    const none = jwt.sign({ sub: user.id, sid: session.id }, '', { algorithm: 'none', issuer: 'hrms', audience: 'hrms-api' });
    const wrongAud = jwt.sign({ sub: user.id, sid: session.id }, env.JWT_SECRET, { issuer: 'hrms', audience: 'other' });
    expect((await api().get('/api/auth/me').set(auth(none))).status).toBe(401);
    expect((await api().get('/api/auth/me').set(auth(wrongAud))).status).toBe(401);
  });
});

describe('response headers', () => {
  it('sends a strict CSP and no-store on API responses', async () => {
    const res = await api().get('/api/system/health');
    expect(res.headers['content-security-policy']).toContain("script-src 'self'");
    expect(res.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });
});

describe('CSV export', () => {
  it('neutralises spreadsheet formulas but keeps numbers', () => {
    expect(csvCell('=HYPERLINK("http://x")')).toBe(`"'=HYPERLINK(""http://x"")"`);
    expect(csvCell('+971 50')).toBe("'+971 50");
    expect(csvCell('@SUM(A1)')).toBe("'@SUM(A1)");
    expect(csvCell(-12.5)).toBe('-12.5');
    expect(csvCell('Nadia')).toBe('Nadia');
  });
});
