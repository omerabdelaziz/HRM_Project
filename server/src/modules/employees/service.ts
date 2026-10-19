import type { Employee } from '@prisma/client';
import { z } from 'zod';
import { prisma, Prisma, Tx } from '../../lib/prisma';
import { conflict, badRequest, notFound, unprocessable } from '../../lib/errors';
import { decrypt, encrypt, keyedHash, mask, randomToken } from '../../lib/crypto';
import { audit } from '../../lib/audit';
import { addDays, toDateOnly } from '../../lib/dates';
import { AuthUser, hasPermission } from '../../auth/context';
import { reportingTree } from '../../auth/scope';
import { assertCanGrantRoles, roleWithPermissions } from '../../auth/grants';
import { ensureAllBalances } from '../leave/balances';
import { hashPassword } from '../../auth/passwords';

const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD');
const optStr = (max = 200) => z.string().trim().max(max).nullish().transform((v) => (v === '' ? null : v));
const optId = z.string().uuid().nullish().or(z.literal('').transform(() => null));

export const employeeFields = z.object({
  firstName: z.string().trim().min(1).max(100),
  lastName: z.string().trim().min(1).max(100),
  firstNameAr: optStr(100),
  lastNameAr: optStr(100),
  email: z.string().trim().toLowerCase().email(),
  personalEmail: z.string().trim().toLowerCase().email().nullish().or(z.literal('').transform(() => null)),
  phone: optStr(30),
  gender: z.enum(['MALE', 'FEMALE']).nullish(),
  dateOfBirth: dateStr.nullish(),
  nationality: optStr(60),
  maritalStatus: z.enum(['SINGLE', 'MARRIED', 'DIVORCED', 'WIDOWED']).nullish(),
  nationalId: optStr(50),
  address: optStr(500),
  emergencyContact: z.object({ name: z.string().max(100), relation: z.string().max(50).optional(), phone: z.string().max(30) }).nullish(),
  branchId: optId,
  departmentId: optId,
  positionId: optId,
  gradeId: optId,
  categoryId: optId,
  employmentTypeId: optId,
  costCenterId: optId,
  managerId: optId,
  shiftId: optId,
  hireDate: dateStr,
  probationEndDate: dateStr.nullish(),
  contractStartDate: dateStr.nullish(),
  contractEndDate: dateStr.nullish(),
  bankName: optStr(100),
  bankAccount: optStr(50),
  iban: optStr(50).refine((v) => !v || /^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(v.replace(/\s/g, '').toUpperCase()), 'Invalid IBAN format'),
});

export const createEmployeeSchema = employeeFields.extend({
  companyId: z.string().uuid().optional(),
  status: z.enum(['PROBATION', 'ACTIVE']).optional(),
  createUserAccount: z.boolean().default(false),
  roleCodes: z.array(z.string()).default(['EMPLOYEE']),
  /** Set after the user confirms a suspected duplicate (same name and date of birth). */
  confirmDuplicate: z.boolean().default(false),
});

export const updateEmployeeSchema = employeeFields.partial().extend({
  status: z.enum(['PROBATION', 'ACTIVE', 'SUSPENDED']).optional(),
  /** Date the organizational change takes effect, for the history record. */
  effectiveDate: dateStr.optional(),
  changeReason: z.string().trim().max(500).optional(),
});

export type CreateEmployeeInput = z.infer<typeof createEmployeeSchema>;
type UpdateEmployeeInput = z.infer<typeof updateEmployeeSchema>;

export const employeeInclude = {
  company: { select: { id: true, name: true, nameAr: true, baseCurrency: true } },
  branch: { select: { id: true, name: true, nameAr: true } },
  department: { select: { id: true, name: true, nameAr: true } },
  position: { select: { id: true, title: true, titleAr: true } },
  grade: { select: { id: true, code: true, name: true } },
  category: { select: { id: true, name: true, nameAr: true } },
  employmentType: { select: { id: true, name: true, nameAr: true } },
  costCenter: { select: { id: true, code: true, name: true } },
  manager: { select: { id: true, employeeNo: true, firstName: true, lastName: true, firstNameAr: true, lastNameAr: true } },
  shift: { select: { id: true, name: true, startTime: true, endTime: true } },
  user: { select: { id: true, email: true, isActive: true, lastLoginAt: true, roles: { select: { role: { select: { code: true, name: true } } } } } },
} satisfies Prisma.EmployeeInclude;

type EmployeeWithRelations = Prisma.EmployeeGetPayload<{ include: typeof employeeInclude }>;

/** Removes encrypted columns and exposes sensitive values only to users allowed to see them. */
export function presentEmployee(e: Employee | EmployeeWithRelations, user: AuthUser) {
  const { nationalIdEnc, bankAccountEnc, ibanEnc, nationalIdHash: _h, ...rest } = e;
  const own = user.employeeId === e.id;
  const full = hasPermission(user, 'employee.sensitive.read');
  const show = (v: string | null) => (full ? decrypt(v) : own ? mask(decrypt(v)) : null);
  return { ...rest, nationalId: show(nationalIdEnc), bankAccount: show(bankAccountEnc), iban: show(ibanEnc), canViewSensitive: full };
}

function dates<T extends Partial<Record<string, unknown>>>(input: T, keys: (keyof T)[]) {
  const out: Record<string, unknown> = {};
  for (const k of keys) if (input[k] !== undefined) out[k as string] = input[k] ? toDateOnly(input[k] as string) : null;
  return out;
}

/** Ensures every referenced org record belongs to the employee's company. */
async function validateRefs(tx: Tx, companyId: string, data: Partial<UpdateEmployeeInput>, selfId?: string) {
  const checks: [string, string | null | undefined, (id: string) => Promise<{ companyId: string } | null>][] = [
    ['branch', data.branchId, (id) => tx.branch.findUnique({ where: { id }, select: { companyId: true } })],
    ['department', data.departmentId, (id) => tx.department.findUnique({ where: { id }, select: { companyId: true } })],
    ['position', data.positionId, (id) => tx.position.findUnique({ where: { id }, select: { companyId: true } })],
    ['grade', data.gradeId, (id) => tx.jobGrade.findUnique({ where: { id }, select: { companyId: true } })],
    ['category', data.categoryId, (id) => tx.employeeCategory.findUnique({ where: { id }, select: { companyId: true } })],
    ['employment type', data.employmentTypeId, (id) => tx.employmentType.findUnique({ where: { id }, select: { companyId: true } })],
    ['cost center', data.costCenterId, (id) => tx.costCenter.findUnique({ where: { id }, select: { companyId: true } })],
    ['shift', data.shiftId, (id) => tx.shift.findUnique({ where: { id }, select: { companyId: true } })],
    ['manager', data.managerId, (id) => tx.employee.findFirst({ where: { id, deletedAt: null }, select: { companyId: true } })],
  ];
  for (const [label, id, find] of checks) {
    if (!id) continue;
    const row = await find(id);
    if (!row || row.companyId !== companyId) throw badRequest(`The selected ${label} does not belong to this company`);
  }
  if (selfId && data.managerId) {
    if (data.managerId === selfId) throw badRequest('An employee cannot report to themselves');
    const reports = await reportingTree(selfId);
    if (reports.includes(data.managerId)) throw badRequest('This manager reports to the employee; that would create a reporting loop');
  }
  if (data.contractStartDate && data.contractEndDate && data.contractEndDate < data.contractStartDate) {
    throw badRequest('Contract end date must be after its start date');
  }
}

/** Atomically allocates the next employee number for a company, e.g. EMP00042. */
export async function nextEmployeeNo(tx: Tx, companyId: string) {
  const company = await tx.company.findUniqueOrThrow({ where: { id: companyId }, select: { employeeNoPrefix: true, employeeNoPadding: true } });
  for (;;) {
    const [{ value }] = await tx.$queryRaw<{ value: number }[]>`
      INSERT INTO "Counter" (key, value) VALUES (${`employeeNo:${companyId}`}, 1)
      ON CONFLICT (key) DO UPDATE SET value = "Counter".value + 1
      RETURNING value`;
    const no = `${company.employeeNoPrefix}${String(value).padStart(company.employeeNoPadding, '0')}`;
    // Skip numbers taken by imported records that brought their own employee number.
    const taken = await tx.employee.findUnique({ where: { employeeNo: no }, select: { id: true } });
    if (!taken) return no;
  }
}

export async function findDuplicates(tx: Tx | typeof prisma, companyId: string, input: { email?: string; nationalId?: string | null; firstName?: string; lastName?: string; dateOfBirth?: string | null }, excludeId?: string) {
  const or: Prisma.EmployeeWhereInput[] = [];
  if (input.email) or.push({ email: input.email });
  const h = keyedHash(input.nationalId);
  if (h) or.push({ companyId, nationalIdHash: h });
  if (input.firstName && input.lastName && input.dateOfBirth) {
    or.push({
      companyId,
      firstName: { equals: input.firstName, mode: 'insensitive' },
      lastName: { equals: input.lastName, mode: 'insensitive' },
      dateOfBirth: toDateOnly(input.dateOfBirth),
    });
  }
  if (!or.length) return [];
  const rows = await tx.employee.findMany({
    where: { OR: or, ...(excludeId ? { id: { not: excludeId } } : {}) },
    select: { id: true, employeeNo: true, firstName: true, lastName: true, email: true, nationalIdHash: true, dateOfBirth: true, deletedAt: true },
  });
  return rows.map((r) => ({
    id: r.id,
    employeeNo: r.employeeNo,
    name: `${r.firstName} ${r.lastName}`,
    archived: !!r.deletedAt,
    reasons: [
      r.email === input.email && 'email',
      h && r.nationalIdHash === h && 'nationalId',
      input.dateOfBirth && r.dateOfBirth && toDateOnly(input.dateOfBirth).getTime() === r.dateOfBirth.getTime() && 'nameAndDateOfBirth',
    ].filter(Boolean) as string[],
  }));
}

export async function createEmployee(tx: Tx, companyId: string, input: CreateEmployeeInput, actor: AuthUser | null, opts: { employeeNo?: string } = {}) {
  const dups = await findDuplicates(tx, companyId, input);
  const hard = dups.filter((d) => d.reasons.includes('email') || d.reasons.includes('nationalId'));
  if (hard.length) throw conflict(`An employee with the same ${hard[0].reasons.join(' and ')} already exists (${hard[0].employeeNo})`, { duplicates: hard });
  if (dups.length && !input.confirmDuplicate) {
    throw conflict('A possible duplicate exists with the same name and date of birth. Confirm to create anyway.', { duplicates: dups, confirmable: true });
  }
  await validateRefs(tx, companyId, input);

  const company = await tx.company.findUniqueOrThrow({ where: { id: companyId }, select: { probationMonths: true } });
  const hireDate = toDateOnly(input.hireDate);
  let probationEnd = input.probationEndDate ? toDateOnly(input.probationEndDate) : null;
  if (!probationEnd && company.probationMonths > 0 && input.status !== 'ACTIVE') {
    const d = new Date(hireDate);
    d.setUTCMonth(d.getUTCMonth() + company.probationMonths);
    probationEnd = addDays(d, -1);
  }
  const status = input.status ?? (probationEnd && probationEnd >= toDateOnly(new Date()) ? 'PROBATION' : 'ACTIVE');

  const employeeNo = opts.employeeNo ?? (await nextEmployeeNo(tx, companyId));
  const { companyId: _c, createUserAccount, roleCodes, confirmDuplicate: _d, nationalId, bankAccount, iban, emergencyContact, ...fields } = input;
  const employee = await tx.employee.create({
    data: {
      ...fields,
      ...dates(input, ['dateOfBirth', 'contractStartDate', 'contractEndDate']),
      hireDate,
      probationEndDate: probationEnd,
      companyId,
      employeeNo,
      status,
      emergencyContact: emergencyContact ?? undefined,
      nationalIdEnc: encrypt(nationalId),
      nationalIdHash: keyedHash(nationalId),
      bankAccountEnc: encrypt(bankAccount),
      ibanEnc: encrypt(iban?.replace(/\s/g, '').toUpperCase()),
    },
  });
  await tx.employeeHistory.create({
    data: {
      employeeId: employee.id,
      type: 'HIRE',
      effectiveDate: hireDate,
      toValue: { departmentId: employee.departmentId, positionId: employee.positionId, branchId: employee.branchId, gradeId: employee.gradeId, managerId: employee.managerId },
      createdById: actor?.id,
    },
  });

  let temporaryPassword: string | undefined;
  if (createUserAccount) {
    temporaryPassword = `${randomToken(9)}9a`;
    const roles = await tx.role.findMany({ where: { code: { in: roleCodes.length ? roleCodes : ['EMPLOYEE'] } }, include: roleWithPermissions });
    if (actor) assertCanGrantRoles(actor, roles);
    const existing = await tx.user.findUnique({ where: { email: employee.email } });
    if (existing) throw conflict('A user account with this email already exists');
    await tx.user.create({
      data: {
        email: employee.email,
        displayName: `${employee.firstName} ${employee.lastName}`,
        passwordHash: await hashPassword(temporaryPassword),
        mustChangePassword: true,
        employeeId: employee.id,
        roles: { create: roles.map((r) => ({ roleId: r.id, companyId })) },
      },
    });
  }

  await ensureAllBalances(tx, employee.id);
  await audit({ userId: actor?.id, action: 'CREATE', entity: 'Employee', entityId: employee.id, after: employee }, tx);
  return { employee, temporaryPassword };
}

const TRACKED: Record<string, string> = {
  departmentId: 'TRANSFER',
  branchId: 'TRANSFER',
  costCenterId: 'TRANSFER',
  positionId: 'PROMOTION',
  gradeId: 'PROMOTION',
  managerId: 'MANAGER_CHANGE',
  status: 'STATUS_CHANGE',
};

export async function updateEmployee(id: string, input: UpdateEmployeeInput, actor: AuthUser) {
  return prisma.$transaction(async (tx) => {
    const before = await tx.employee.findUnique({ where: { id } });
    if (!before || before.deletedAt) throw notFound('Employee');
    if (['RESIGNED', 'TERMINATED', 'RETIRED'].includes(before.status)) throw unprocessable('Separated employees cannot be edited; rehire them as a new record');
    await validateRefs(tx, before.companyId, { ...input, contractStartDate: input.contractStartDate ?? before.contractStartDate?.toISOString().slice(0, 10) }, id);
    if (input.email || input.nationalId || input.firstName || input.lastName) {
      const dups = await findDuplicates(tx, before.companyId, { email: input.email, nationalId: input.nationalId }, id);
      if (dups.length) throw conflict(`Another employee already uses this ${dups[0].reasons.join(' and ')} (${dups[0].employeeNo})`, { duplicates: dups });
    }

    const { effectiveDate, changeReason, nationalId, bankAccount, iban, emergencyContact, ...fields } = input;
    const data: Prisma.EmployeeUncheckedUpdateInput = {
      ...fields,
      ...dates(input, ['dateOfBirth', 'hireDate', 'probationEndDate', 'contractStartDate', 'contractEndDate']),
      ...(emergencyContact !== undefined ? { emergencyContact: emergencyContact ?? Prisma.JsonNull } : {}),
      ...(nationalId !== undefined ? { nationalIdEnc: encrypt(nationalId), nationalIdHash: keyedHash(nationalId) } : {}),
      ...(bankAccount !== undefined ? { bankAccountEnc: encrypt(bankAccount) } : {}),
      ...(iban !== undefined ? { ibanEnc: encrypt(iban?.replace(/\s/g, '').toUpperCase()) } : {}),
    };
    const after = await tx.employee.update({ where: { id }, data });

    // History: group tracked field changes by type.
    const groups = new Map<string, { from: Record<string, unknown>; to: Record<string, unknown> }>();
    for (const [field, type] of Object.entries(TRACKED)) {
      const b = (before as Record<string, unknown>)[field];
      const a = (after as Record<string, unknown>)[field];
      if (b !== a) {
        const g = groups.get(type) ?? { from: {}, to: {} };
        g.from[field] = b;
        g.to[field] = a;
        groups.set(type, g);
      }
    }
    const eff = effectiveDate ? toDateOnly(effectiveDate) : toDateOnly(new Date());
    for (const [type, g] of groups) {
      await tx.employeeHistory.create({ data: { employeeId: id, type, effectiveDate: eff, fromValue: g.from as Prisma.InputJsonValue, toValue: g.to as Prisma.InputJsonValue, reason: changeReason, createdById: actor.id } });
    }
    if (input.email && input.email !== before.email) {
      await tx.user.updateMany({ where: { employeeId: id }, data: { email: input.email } });
    }
    if (input.firstName || input.lastName) {
      await tx.user.updateMany({ where: { employeeId: id }, data: { displayName: `${after.firstName} ${after.lastName}` } });
    }
    await audit({ userId: actor.id, action: 'UPDATE', entity: 'Employee', entityId: id, before, after }, tx);
    return after;
  });
}

export async function separateEmployee(id: string, input: { type: 'RESIGNED' | 'TERMINATED' | 'RETIRED'; date: string; reason: string }, actor: AuthUser) {
  return prisma.$transaction(async (tx) => {
    const before = await tx.employee.findUnique({ where: { id } });
    if (!before || before.deletedAt) throw notFound('Employee');
    if (['RESIGNED', 'TERMINATED', 'RETIRED'].includes(before.status)) throw unprocessable('Employee is already separated');
    const date = toDateOnly(input.date);
    if (date < before.hireDate) throw badRequest('Separation date cannot be before the hire date');
    const after = await tx.employee.update({ where: { id }, data: { status: input.type, separationDate: date, separationReason: input.reason } });
    await tx.employeeHistory.create({ data: { employeeId: id, type: 'STATUS_CHANGE', effectiveDate: date, fromValue: { status: before.status }, toValue: { status: input.type }, reason: input.reason, createdById: actor.id } });
    // Access ends on the separation date; future-dated separations are handled by the nightly job.
    if (date <= toDateOnly(new Date())) {
      const u = await tx.user.findUnique({ where: { employeeId: id } });
      if (u) {
        await tx.user.update({ where: { id: u.id }, data: { isActive: false } });
        await tx.session.updateMany({ where: { userId: u.id, revokedAt: null }, data: { revokedAt: new Date() } });
      }
    }
    // Reassign direct reports to the separated employee's manager.
    await tx.employee.updateMany({ where: { managerId: id }, data: { managerId: before.managerId } });
    await audit({ userId: actor.id, action: 'SEPARATE', entity: 'Employee', entityId: id, before, after }, tx);
    return after;
  });
}

export async function archiveEmployee(id: string, actor: AuthUser) {
  return prisma.$transaction(async (tx) => {
    const emp = await tx.employee.findUnique({ where: { id } });
    if (!emp || emp.deletedAt) throw notFound('Employee');
    const paid = await tx.payslip.count({ where: { employeeId: id, run: { status: { in: ['APPROVED', 'PAID'] } } } });
    if (paid) throw unprocessable('This employee has approved payroll records and cannot be archived. Record a separation instead.');
    await tx.employee.update({ where: { id }, data: { deletedAt: new Date() } });
    await tx.employee.updateMany({ where: { managerId: id }, data: { managerId: emp.managerId } });
    const u = await tx.user.findUnique({ where: { employeeId: id } });
    if (u) {
      await tx.user.update({ where: { id: u.id }, data: { isActive: false } });
      await tx.session.updateMany({ where: { userId: u.id, revokedAt: null }, data: { revokedAt: new Date() } });
    }
    await audit({ userId: actor.id, action: 'ARCHIVE', entity: 'Employee', entityId: id, before: emp }, tx);
  });
}
