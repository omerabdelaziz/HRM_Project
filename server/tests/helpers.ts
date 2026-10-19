import request from 'supertest';
import { createApp } from '../src/app';
import { prisma } from '../src/lib/prisma';
import { PERMISSIONS, ALL_PERMISSIONS, SYSTEM_ROLES } from '../src/auth/permissions';
import { hashPassword } from '../src/auth/passwords';
import { loadAuthUser } from '../src/auth/context';
import { createEmployee, CreateEmployeeInput } from '../src/modules/employees/service';

export const app = createApp();
export const api = () => request(app);
export const PASSWORD = 'Test@12345';

let counter = 0;
export const uid = () => `${Date.now().toString(36)}${(counter++).toString(36)}`;

/** Permissions and roles (idempotent). */
export async function seedRoles() {
  for (const code of ALL_PERMISSIONS) {
    const [module, description] = PERMISSIONS[code];
    await prisma.permission.upsert({ where: { code }, create: { code, module, description }, update: {} });
  }
  const perms = await prisma.permission.findMany();
  for (const [code, def] of Object.entries(SYSTEM_ROLES)) {
    if (await prisma.role.findUnique({ where: { code } })) continue;
    // requireMfa stays false here so test users can sign in without enrolling; the MFA tests turn it on explicitly.
    await prisma.role.create({
      data: { code, name: def.name, dataScope: def.dataScope, isSystem: true, requireMfa: false, permissions: { create: def.permissions.map((p) => ({ permissionId: perms.find((x) => x.code === p)!.id })) } },
    });
  }
  for (const [code, name] of [['AED', 'UAE Dirham'], ['USD', 'US Dollar']]) {
    await prisma.currency.upsert({ where: { code }, create: { code, name, symbol: code }, update: {} });
  }
}

/** A company with one branch/department, a Mon–Fri 09:00–18:00 default shift, annual + unpaid leave and payroll settings. */
export async function makeCompany(overrides: { weekendDays?: number[]; autoApprove?: string[] } = {}) {
  await seedRoles();
  const code = `C${uid()}`.toUpperCase();
  const company = await prisma.company.create({
    data: {
      code, name: `Test Co ${code}`, baseCurrency: 'AED', timezone: 'Asia/Dubai', weekendDays: overrides.weekendDays ?? [0, 6], employeeNoPrefix: 'T', employeeNoPadding: 4, probationMonths: 0,
      autoApproveRequestTypes: overrides.autoApprove ?? [],
      payrollSettings: { create: { dailyRateBasis: 'FIXED_30', overtimeMultiplier: 1.25 } },
      attendancePolicy: { create: { minOvertimeMinutes: 30, overtimeRequiresApproval: false } },
    },
  });
  const branch = await prisma.branch.create({ data: { companyId: company.id, code: 'HQ', name: 'HQ' } });
  const dept = await prisma.department.create({ data: { companyId: company.id, code: 'OPS', name: 'Operations', branchId: branch.id } });
  const dept2 = await prisma.department.create({ data: { companyId: company.id, code: 'FIN', name: 'Finance', branchId: branch.id } });
  const position = await prisma.position.create({ data: { companyId: company.id, code: 'OPSX', title: 'Operations Executive', departmentId: dept.id } });
  const shift = await prisma.shift.create({ data: { companyId: company.id, code: 'DAY', name: 'Day', startTime: '09:00', endTime: '18:00', breakMinutes: 60, graceMinutes: 10, workDays: [1, 2, 3, 4, 5], isDefault: true } });
  const annual = await prisma.leaveType.create({ data: { companyId: company.id, code: 'ANNUAL', name: 'Annual leave', annualEntitlement: 24, accrualMethod: 'ANNUAL', prorateFirstYear: false } });
  const unpaid = await prisma.leaveType.create({ data: { companyId: company.id, code: 'UNPAID', name: 'Unpaid leave', isPaid: false, accrualMethod: 'NONE', annualEntitlement: 0 } });
  const housing = await prisma.payComponent.create({ data: { companyId: company.id, code: 'HOUSING', name: 'Housing', type: 'EARNING', calcType: 'FIXED' } });
  return { company, branch, dept, dept2, position, shift, annual, unpaid, housing };
}

export async function makeAdmin(companyId: string) {
  const role = await prisma.role.findUniqueOrThrow({ where: { code: 'SUPER_ADMIN' } });
  const email = `admin-${uid()}@test.local`;
  const user = await prisma.user.create({ data: { email, displayName: 'Admin', passwordHash: await hashPassword(PASSWORD), roles: { create: [{ roleId: role.id, companyId }] } } });
  return { user, email };
}

/** Creates an employee (through the real service) with a user account holding the given roles. */
export async function makeEmployee(companyId: string, opts: Partial<CreateEmployeeInput> & { roles?: string[] } = {}) {
  const adminRole = await prisma.role.findUniqueOrThrow({ where: { code: 'SUPER_ADMIN' } });
  let actorUser = await prisma.user.findFirst({ where: { roles: { some: { roleId: adminRole.id } } } });
  if (!actorUser) actorUser = (await makeAdmin(companyId)).user;
  const actor = (await loadAuthUser(actorUser.id, 'test'))!;
  const { roles: roleCodes = [], ...fields } = opts;
  const id = uid();
  const { employee } = await prisma.$transaction((tx) =>
    createEmployee(tx, companyId, { firstName: 'Emp', lastName: id, email: `e-${id}@test.local`, hireDate: '2024-01-01', createUserAccount: false, roleCodes: [], confirmDuplicate: false, ...fields } as CreateEmployeeInput, actor),
  );
  const roles = await prisma.role.findMany({ where: { code: { in: ['EMPLOYEE', ...roleCodes] } } });
  const user = await prisma.user.create({
    data: { email: employee.email, displayName: `${employee.firstName} ${employee.lastName}`, passwordHash: await hashPassword(PASSWORD), employeeId: employee.id, roles: { create: roles.map((r) => ({ roleId: r.id, companyId })) } },
  });
  return { employee, user };
}

export async function login(email: string, password = PASSWORD) {
  const res = await api().post('/api/auth/login').send({ email, password });
  if (res.status !== 200) throw new Error(`login failed for ${email}: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.accessToken as string;
}

export const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

export async function makeWorkflow(companyId: string, requestType: string, steps: { name: string; approverType: string; roleCode?: string; minAmount?: number }[]) {
  return prisma.workflowDefinition.create({ data: { companyId, requestType, name: requestType, steps: { create: steps.map((s, i) => ({ ...s, order: i + 1 })) } } });
}

export { prisma };
