import ExcelJS from 'exceljs';
import { beforeAll, describe, expect, it } from 'vitest';
import { api, auth, login, makeAdmin, makeCompany, makeEmployee, prisma } from '../helpers';

let ctx: Awaited<ReturnType<typeof makeCompany>>;
let adminToken: string;

beforeAll(async () => {
  ctx = await makeCompany();
  adminToken = await login((await makeAdmin(ctx.company.id)).email);
});

const base = (over: Record<string, unknown> = {}) => ({
  companyId: ctx.company.id,
  firstName: 'Nadia',
  lastName: `Test${Math.random().toString(36).slice(2, 7)}`,
  email: `nadia.${Math.random().toString(36).slice(2, 9)}@test.local`,
  hireDate: '2025-02-01',
  departmentId: ctx.dept.id,
  ...over,
});

describe('employee management', () => {
  it('creates employees with sequential, unique employee numbers', async () => {
    const a = await api().post('/api/employees').set(auth(adminToken)).send(base());
    const b = await api().post('/api/employees').set(auth(adminToken)).send(base());
    expect(a.status).toBe(201);
    expect(a.body.employeeNo).toMatch(/^T\d{4}$/);
    expect(Number(b.body.employeeNo.slice(1))).toBe(Number(a.body.employeeNo.slice(1)) + 1);
  });

  it('prevents duplicate email and national ID, and asks to confirm a name + birth date match', async () => {
    const first = await api().post('/api/employees').set(auth(adminToken)).send(base({ nationalId: '784-1990-1234567-1', dateOfBirth: '1990-04-04', firstName: 'Dup', lastName: 'Person' }));
    expect(first.status).toBe(201);
    const sameEmail = await api().post('/api/employees').set(auth(adminToken)).send(base({ email: first.body.email }));
    expect(sameEmail.status).toBe(409);
    // National ID matched after normalizing spaces/dashes.
    const sameId = await api().post('/api/employees').set(auth(adminToken)).send(base({ nationalId: '784 1990 1234567 1' }));
    expect(sameId.status).toBe(409);
    const suspect = await api().post('/api/employees').set(auth(adminToken)).send(base({ firstName: 'dup', lastName: 'PERSON', dateOfBirth: '1990-04-04' }));
    expect(suspect.status).toBe(409);
    expect(suspect.body.error.details.confirmable).toBe(true);
    const confirmed = await api().post('/api/employees').set(auth(adminToken)).send(base({ firstName: 'dup', lastName: 'PERSON', dateOfBirth: '1990-04-04', confirmDuplicate: true }));
    expect(confirmed.status).toBe(201);
  });

  it('encrypts national ID and bank details at rest and shows them only with permission', async () => {
    const res = await api().post('/api/employees').set(auth(adminToken)).send(base({ nationalId: '784-1985-7654321-2', iban: 'AE070331234567890123456' }));
    const row = await prisma.employee.findUniqueOrThrow({ where: { id: res.body.id } });
    expect(row.ibanEnc).not.toContain('AE07');
    expect(res.body.iban).toBe('AE070331234567890123456');
    expect(res.body).not.toHaveProperty('ibanEnc');
  });

  it('records transfers and promotions in history and blocks reporting loops', async () => {
    const mgr = await api().post('/api/employees').set(auth(adminToken)).send(base());
    const emp = await api().post('/api/employees').set(auth(adminToken)).send(base({ managerId: mgr.body.id }));
    const moved = await api().put(`/api/employees/${emp.body.id}`).set(auth(adminToken)).send({ departmentId: ctx.dept2.id, changeReason: 'Reorganisation' });
    expect(moved.status).toBe(200);
    const history = await api().get(`/api/employees/${emp.body.id}/history`).set(auth(adminToken));
    expect(history.body.items.map((h: { type: string }) => h.type)).toEqual(expect.arrayContaining(['HIRE', 'TRANSFER']));
    const loop = await api().put(`/api/employees/${mgr.body.id}`).set(auth(adminToken)).send({ managerId: emp.body.id });
    expect(loop.status).toBe(400);
  });

  it('rejects references to another company', async () => {
    const other = await makeCompany();
    const res = await api().post('/api/employees').set(auth(adminToken)).send(base({ departmentId: other.dept.id }));
    expect(res.status).toBe(400);
  });

  it('separation ends system access and reassigns direct reports', async () => {
    const boss = await makeEmployee(ctx.company.id);
    const mid = await makeEmployee(ctx.company.id, { managerId: boss.employee.id });
    const report = await makeEmployee(ctx.company.id, { managerId: mid.employee.id });
    const res = await api().post(`/api/employees/${mid.employee.id}/separate`).set(auth(adminToken)).send({ type: 'RESIGNED', date: '2026-01-15', reason: 'Relocating abroad' });
    expect(res.status).toBe(200);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: mid.user.id } })).isActive).toBe(false);
    expect((await prisma.employee.findUniqueOrThrow({ where: { id: report.employee.id } })).managerId).toBe(boss.employee.id);
  });

  it('imports from Excel with a validating dry run, then commits all rows', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Employees');
    ws.addRow(['First Name*', 'Last Name*', 'Work Email*', 'Hire Date*', 'Department Code', 'Employee No', 'Manager Employee No']);
    const tag = Math.random().toString(36).slice(2, 7);
    ws.addRow(['Imp', 'Lead', `lead.${tag}@test.local`, '2025-03-01', 'OPS', `IMP-${tag}-1`, '']);
    ws.addRow(['Imp', 'Member', `member.${tag}@test.local`, '2025-03-02', 'OPS', '', `IMP-${tag}-1`]);
    const good = Buffer.from(await wb.xlsx.writeBuffer());
    ws.addRow(['Bad', 'Row', 'not-an-email', '2025-13-40', 'NOPE', '', '']);
    const bad = Buffer.from(await wb.xlsx.writeBuffer());

    const dry = await api().post('/api/employees/import').set(auth(adminToken)).field('dryRun', 'true').attach('file', bad, 'e.xlsx');
    expect(dry.status).toBe(200);
    expect(dry.body.committed).toBe(false);
    expect(dry.body.summary.invalid).toBe(1);
    expect(dry.body.rows[2].errors.join(' ')).toMatch(/department/);

    const commit = await api().post('/api/employees/import').set(auth(adminToken)).field('dryRun', 'false').attach('file', good, 'e.xlsx');
    expect(commit.body.committed).toBe(true);
    const member = await prisma.employee.findUniqueOrThrow({ where: { email: `member.${tag}@test.local` }, include: { manager: true } });
    expect(member.manager?.employeeNo).toBe(`IMP-${tag}-1`);
  });

  it('exports the employee list to Excel', async () => {
    const res = await api().get('/api/employees/export').set(auth(adminToken)).buffer(true).parse((r, cb) => {
      const chunks: Buffer[] = [];
      r.on('data', (c: Buffer) => chunks.push(c));
      r.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/spreadsheetml/);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(res.body);
    expect(wb.worksheets[0].rowCount).toBeGreaterThan(1);
  });
});

describe('role-based access control', () => {
  it('employees see only themselves', async () => {
    const me = await makeEmployee(ctx.company.id);
    const other = await makeEmployee(ctx.company.id);
    const token = await login(me.user.email);
    expect((await api().get('/api/employees').set(auth(token))).status).toBe(403);
    expect((await api().get(`/api/employees/${me.employee.id}`).set(auth(token))).status).toBe(200);
    expect((await api().get(`/api/employees/${other.employee.id}`).set(auth(token))).status).toBe(403);
    expect((await api().get('/api/payroll/runs').set(auth(token))).status).toBe(403);
    expect((await api().get('/api/audit').set(auth(token))).status).toBe(403);
  });

  it('department managers see only their departments and their team', async () => {
    const mgr = await makeEmployee(ctx.company.id, { departmentId: ctx.dept.id, roles: ['DEPARTMENT_MANAGER'] });
    await prisma.department.update({ where: { id: ctx.dept.id }, data: { managerId: mgr.employee.id } });
    const inDept = await makeEmployee(ctx.company.id, { departmentId: ctx.dept.id });
    const outside = await makeEmployee(ctx.company.id, { departmentId: ctx.dept2.id });
    const token = await login(mgr.user.email);
    const list = await api().get('/api/employees?pageSize=500').set(auth(token));
    expect(list.status).toBe(200);
    const ids = list.body.items.map((e: { id: string }) => e.id);
    expect(ids).toContain(inDept.employee.id);
    expect(ids).not.toContain(outside.employee.id);
    expect((await api().get(`/api/employees/${outside.employee.id}`).set(auth(token))).status).toBe(404);
  });

  it('hides sensitive fields from users without the permission', async () => {
    const mgr = await makeEmployee(ctx.company.id, { departmentId: ctx.dept2.id, roles: ['DEPARTMENT_MANAGER'] });
    await prisma.department.update({ where: { id: ctx.dept2.id }, data: { managerId: mgr.employee.id } });
    const res = await api().post('/api/employees').set(auth(adminToken)).send(base({ departmentId: ctx.dept2.id, nationalId: '784-1999-1111111-1', iban: 'AE070331234567890999999' }));
    const token = await login(mgr.user.email);
    const view = await api().get(`/api/employees/${res.body.id}`).set(auth(token));
    expect(view.status).toBe(200);
    expect(view.body.nationalId).toBeNull();
    expect(view.body.iban).toBeNull();
    // and cannot change them
    expect((await api().put(`/api/employees/${res.body.id}`).set(auth(token)).send({ iban: null })).status).toBe(403);
  });

  it('only a super administrator can grant the super administrator role', async () => {
    const hr = await makeEmployee(ctx.company.id, { roles: ['HR_ADMIN'] });
    const token = await login(hr.user.email);
    const res = await api().post('/api/users').set(auth(token)).send({ email: `x${Date.now()}@test.local`, displayName: 'X', roleCodes: ['SUPER_ADMIN'] });
    expect(res.status).toBe(403);
  });
});
