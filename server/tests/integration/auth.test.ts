import { beforeAll, describe, expect, it } from 'vitest';
import { api, auth, login, makeAdmin, makeCompany, makeEmployee, prisma, PASSWORD } from '../helpers';

let companyId: string;
beforeAll(async () => {
  companyId = (await makeCompany()).company.id;
});

describe('authentication', () => {
  it('signs in and returns the current user with permissions', async () => {
    const { email } = await makeAdmin(companyId);
    const token = await login(email);
    const me = await api().get('/api/auth/me').set(auth(token));
    expect(me.status).toBe(200);
    expect(me.body.email).toBe(email);
    expect(me.body.permissions).toContain('payroll.approve');
  });

  it('rejects bad credentials without revealing whether the account exists', async () => {
    const { email } = await makeAdmin(companyId);
    const bad = await api().post('/api/auth/login').send({ email, password: 'wrong-password1' });
    const unknown = await api().post('/api/auth/login').send({ email: 'nobody@test.local', password: 'wrong-password1' });
    expect(bad.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(bad.body.error.message).toBe(unknown.body.error.message);
  });

  it('locks the account after 5 failed attempts', async () => {
    const { email } = await makeAdmin(companyId);
    for (let i = 0; i < 5; i++) await api().post('/api/auth/login').send({ email, password: 'nope-nope1' });
    const res = await api().post('/api/auth/login').send({ email, password: PASSWORD });
    expect(res.status).toBe(401);
    expect(res.body.error.message).toMatch(/locked/i);
  });

  it('requires a token on protected routes', async () => {
    expect((await api().get('/api/employees')).status).toBe(401);
    expect((await api().get('/api/employees').set(auth('garbage'))).status).toBe(401);
  });

  it('rotates refresh tokens and revokes the session on reuse', async () => {
    const { email } = await makeAdmin(companyId);
    const loginRes = await api().post('/api/auth/login').send({ email, password: PASSWORD });
    const cookie1 = loginRes.headers['set-cookie'][0].split(';')[0];
    const r1 = await api().post('/api/auth/refresh').set('Cookie', cookie1);
    expect(r1.status).toBe(200);
    const cookie2 = r1.headers['set-cookie'][0].split(';')[0];
    expect(cookie2).not.toBe(cookie1);
    // Replaying the old token ends the session entirely.
    expect((await api().post('/api/auth/refresh').set('Cookie', cookie1)).status).toBe(401);
    expect((await api().post('/api/auth/refresh').set('Cookie', cookie2)).status).toBe(401);
    expect((await api().get('/api/auth/me').set(auth(loginRes.body.accessToken))).status).toBe(401);
  });

  it('logout ends the session', async () => {
    const { email } = await makeAdmin(companyId);
    const token = await login(email);
    expect((await api().post('/api/auth/logout').set(auth(token))).status).toBe(204);
    expect((await api().get('/api/auth/me').set(auth(token))).status).toBe(401);
  });

  it('enforces the password policy and verifies the current password', async () => {
    const { user } = await makeEmployee(companyId);
    const token = await login(user.email);
    expect((await api().post('/api/auth/change-password').set(auth(token)).send({ currentPassword: PASSWORD, newPassword: 'short' })).status).toBe(400);
    expect((await api().post('/api/auth/change-password').set(auth(token)).send({ currentPassword: 'wrong1234', newPassword: 'NewPass123' })).status).toBe(400);
    expect((await api().post('/api/auth/change-password').set(auth(token)).send({ currentPassword: PASSWORD, newPassword: 'NewPass123' })).status).toBe(204);
    await login(user.email, 'NewPass123');
  });

  it('records sign-ins in the audit log', async () => {
    const { email, user } = await makeAdmin(companyId);
    await login(email);
    const entry = await prisma.auditLog.findFirst({ where: { userId: user.id, action: 'LOGIN' } });
    expect(entry).not.toBeNull();
  });
});
