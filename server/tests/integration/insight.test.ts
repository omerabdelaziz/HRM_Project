import { beforeAll, describe, expect, it } from 'vitest';
import { api, auth, login, makeAdmin, makeCompany, makeEmployee } from '../helpers';
import { REPORTS } from '../../src/modules/reports/definitions';

let ctx: Awaited<ReturnType<typeof makeCompany>>;
let token: string;

beforeAll(async () => {
  ctx = await makeCompany();
  token = await login((await makeAdmin(ctx.company.id)).email);
  for (let i = 0; i < 3; i++) await makeEmployee(ctx.company.id, { departmentId: ctx.dept.id, hireDate: '2025-06-01' });
});

const filters: Record<string, string> = { from: '2026-01-01', to: '2026-03-31', year: '2026', month: '3', days: '90' };

describe('dashboard, reports and API docs', () => {
  it('dashboard returns KPIs for the filters', async () => {
    const res = await api().get(`/api/dashboard?departmentId=${ctx.dept.id}`).set(auth(token));
    expect(res.status).toBe(200);
    expect(res.body.headcount.current).toBe(3);
    expect(res.body.headcount.trend).toHaveLength(12);
    expect(res.body).toHaveProperty('attendanceToday.absenteeismRate');
    expect(res.body).toHaveProperty('approvals.pending');
    const other = await api().get(`/api/dashboard?departmentId=${ctx.dept2.id}`).set(auth(token));
    expect(other.body.headcount.current).toBe(0);
  });

  it('employees without dashboard permission are refused', async () => {
    const e = await makeEmployee(ctx.company.id);
    expect((await api().get('/api/dashboard').set(auth(await login(e.user.email)))).status).toBe(403);
  });

  it.each(REPORTS.map((r) => r.key))('report %s runs and exports', async (key) => {
    const q = new URLSearchParams(filters).toString();
    const json = await api().get(`/api/reports/${key}?${q}`).set(auth(token));
    expect(json.status).toBe(200);
    expect(Array.isArray(json.body.columns)).toBe(true);
    for (const format of ['xlsx', 'csv', 'pdf']) {
      const file = await api().get(`/api/reports/${key}?${q}&format=${format}`).set(auth(token));
      expect(file.status).toBe(200);
    }
  });

  it('invalid report filters are reported clearly', async () => {
    const res = await api().get('/api/reports/attendance-summary?from=bad').set(auth(token));
    expect(res.status).toBe(400);
  });

  it('saved report configurations', async () => {
    const res = await api().post('/api/saved-reports').set(auth(token)).send({ name: 'Monthly attendance', reportKey: 'attendance-summary', filters: { from: '@prevMonthStart', to: '@prevMonthEnd' }, schedule: 'MONTHLY' });
    expect(res.status).toBe(201);
    expect((await api().get('/api/saved-reports').set(auth(token))).body).toHaveLength(1);
  });

  it('serves the OpenAPI document', async () => {
    const res = await api().get('/api/openapi.json');
    expect(res.status).toBe(200);
    expect(Object.keys(res.body.paths).length).toBeGreaterThan(100);
    expect(res.body.paths['/api/leave/requests'].post).toBeTruthy();
  });

  it('health check', async () => {
    const res = await api().get('/api/system/health');
    expect(res.body.status).toBe('ok');
  });
});
