import { beforeAll, describe, expect, it } from 'vitest';
import { api, auth, login, makeAdmin, makeCompany, makeEmployee, prisma } from '../helpers';

let ctx: Awaited<ReturnType<typeof makeCompany>>;
let token: string;

beforeAll(async () => {
  ctx = await makeCompany();
  token = await login((await makeAdmin(ctx.company.id)).email);
});

const valid = (over: Record<string, unknown> = {}) => ({
  companyId: ctx.company.id,
  firstName: 'Layla',
  lastName: `Val${Math.random().toString(36).slice(2, 7)}`,
  email: `val.${Math.random().toString(36).slice(2, 9)}@test.local`,
  hireDate: '2025-02-01',
  branchId: ctx.branch.id,
  departmentId: ctx.dept.id,
  positionId: ctx.position.id,
  ...over,
});
const fields = (res: { body: { error: { details: { path: string; message: string }[] } } }) =>
  Object.fromEntries(res.body.error.details.map((d) => [d.path, d.message]));

describe('employee validation', () => {
  it('reports every invalid field in one response', async () => {
    const res = await api()
      .post('/api/employees')
      .set(auth(token))
      .send(valid({ branchId: null, departmentId: null, positionId: null, dateOfBirth: '2099-01-01', nationality: 'ZZ', phone: '12345', nationalIdType: 'EMIRATES_ID', nationalId: '784-1990-1234567-1' }));
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(fields(res)).toMatchObject({
      branchId: 'validation.required',
      departmentId: 'validation.required',
      positionId: 'validation.required',
      dateOfBirth: 'validation.dobFuture',
      nationality: 'validation.nationality',
      phone: 'validation.phone',
      nationalId: 'validation.emiratesIdChecksum',
    });
  });

  it('enforces the company minimum age (default 18) at the hire date', async () => {
    const res = await api().post('/api/employees').set(auth(token)).send(valid({ dateOfBirth: '2008-06-01', hireDate: '2025-02-01' }));
    expect(res.status).toBe(400);
    expect(fields(res).dateOfBirth).toBe('validation.minAge|18');
    await prisma.company.update({ where: { id: ctx.company.id }, data: { minEmployeeAge: 15 } });
    const ok = await api().post('/api/employees').set(auth(token)).send(valid({ dateOfBirth: '2008-06-01', hireDate: '2025-02-01' }));
    expect(ok.status).toBe(201);
    await prisma.company.update({ where: { id: ctx.company.id }, data: { minEmployeeAge: 18 } });
  });

  it('validates Emirates IDs for UAE nationals and stores them normalised', async () => {
    const bad = await api().post('/api/employees').set(auth(token)).send(valid({ nationality: 'AE', nationalId: '784-1990-12345' }));
    expect(fields(bad).nationalId).toBe('validation.emiratesIdFormat');
    const ok = await api().post('/api/employees').set(auth(token)).send(valid({ nationality: 'ae', nationalId: '784199012345676' }));
    expect(ok.status).toBe(201);
    expect(ok.body.nationality).toBe('AE');
    expect(ok.body.nationalId).toBe('784-1990-1234567-6');
    // Passports are free text.
    const passport = await api().post('/api/employees').set(auth(token)).send(valid({ nationality: 'IN', nationalIdType: 'PASSPORT', nationalId: 'Z1234567' }));
    expect(passport.status).toBe(201);
  });

  it('normalises phones to E.164 and capitalises names', async () => {
    const res = await api().post('/api/employees').set(auth(token)).send(valid({ firstName: 'SAEED', lastName: 'bin rashid al maktoum', phone: '050 123 4567' }));
    expect(res.status).toBe(201);
    expect(res.body.firstName).toBe('Saeed');
    expect(res.body.lastName).toBe('bin Rashid Al Maktoum');
    expect(res.body.phone).toBe('+971501234567');
  });

  it('defaults the pension scheme by nationality', async () => {
    const national = await api().post('/api/employees').set(auth(token)).send(valid({ nationality: 'AE', hireDate: '2024-03-01' }));
    expect(national.body.pensionScheme).toBe('GPSSA_NEW');
    const expat = await api().post('/api/employees').set(auth(token)).send(valid({ nationality: 'JO' }));
    expect(expat.body.pensionScheme).toBe('NONE');
    const wrong = await api().post('/api/employees').set(auth(token)).send(valid({ nationality: 'JO', pensionScheme: 'GPSSA_OLD' }));
    expect(fields(wrong).pensionScheme).toBe('validation.pensionNationals');
  });

  it('uses friendly labels for duplicates', async () => {
    const first = await api().post('/api/employees').set(auth(token)).send(valid({ nationality: 'AE', nationalId: '784-1985-7654321-3' }));
    expect(first.status).toBe(201);
    const dup = await api().post('/api/employees').set(auth(token)).send(valid({ nationality: 'AE', nationalId: '784 1985 7654321 3' }));
    expect(dup.status).toBe(409);
    expect(dup.body.error.message).toContain('National ID');
    expect(dup.body.error.message).not.toContain('nationalId');
  });

  it('warns (without blocking) when the manager sits in an unrelated department', async () => {
    const mgr = await makeEmployee(ctx.company.id, { departmentId: ctx.dept2.id });
    const res = await api().post('/api/employees').set(auth(token)).send(valid({ managerId: mgr.employee.id }));
    expect(res.status).toBe(201);
    expect(res.body.warnings).toEqual([expect.objectContaining({ code: 'MANAGER_OTHER_DEPARTMENT', field: 'managerId' })]);
    // A manager of the employee's own department is a normal reporting line.
    await prisma.department.update({ where: { id: ctx.dept.id }, data: { managerId: mgr.employee.id } });
    const ok = await api().post('/api/employees').set(auth(token)).send(valid({ managerId: mgr.employee.id }));
    expect(ok.body.warnings).toEqual([]);
    await prisma.department.update({ where: { id: ctx.dept.id }, data: { managerId: null } });
  });

  it('re-validates the stored record on update', async () => {
    const created = await api().post('/api/employees').set(auth(token)).send(valid({ nationality: 'IN', nationalIdType: 'PASSPORT', nationalId: 'P998877' }));
    // Switching to the Emirates ID type makes the stored passport number invalid.
    const res = await api().put(`/api/employees/${created.body.id}`).set(auth(token)).send({ nationalIdType: 'EMIRATES_ID' });
    expect(res.status).toBe(400);
    expect(fields(res).nationalId).toBe('validation.emiratesIdFormat');
  });
});
