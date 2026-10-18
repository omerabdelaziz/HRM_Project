import { prisma, Prisma } from '../lib/prisma';
import { forbidden, notFound } from '../lib/errors';
import { AuthUser } from './context';

/**
 * Builds the Prisma filter limiting which employees a user can see.
 * Everyone sees themselves; anyone with direct or indirect reports sees their team;
 * the role's data scope may widen that to departments/branches they manage, their company, or everything.
 */
export async function employeeScope(user: AuthUser): Promise<Prisma.EmployeeWhereInput> {
  if (user._employeeWhere) return user._employeeWhere;
  const or: Prisma.EmployeeWhereInput[] = [];
  const companyFilter: Prisma.EmployeeWhereInput = user.companyIds ? { companyId: { in: user.companyIds } } : {};

  if (user.scope === 'ALL') {
    user._employeeWhere = companyFilter;
    return companyFilter;
  }

  if (user.scope === 'COMPANY') {
    const companies = user.companyIds ?? (user.companyId ? [user.companyId] : []);
    or.push({ companyId: { in: companies } });
  }

  if (user.employeeId) {
    or.push({ id: user.employeeId });

    const teamIds = await reportingTree(user.employeeId);
    if (teamIds.length) or.push({ id: { in: teamIds } });

    if (user.scope === 'DEPARTMENT' || user.scope === 'BRANCH') {
      const managed = await prisma.department.findMany({ where: { managerId: user.employeeId }, select: { id: true } });
      const deptIds = await departmentSubtree(managed.map((d) => d.id));
      if (deptIds.length) or.push({ departmentId: { in: deptIds } });
    }
    if (user.scope === 'BRANCH') {
      const branches = await prisma.branch.findMany({ where: { managerId: user.employeeId }, select: { id: true } });
      if (branches.length) or.push({ branchId: { in: branches.map((b) => b.id) } });
    }
  }

  const where: Prisma.EmployeeWhereInput = or.length ? { AND: [companyFilter, { OR: or }] } : { id: '__none__' };
  user._employeeWhere = where;
  return where;
}

/** All direct and indirect reports of an employee. */
export async function reportingTree(employeeId: string): Promise<string[]> {
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    WITH RECURSIVE tree AS (
      SELECT id FROM "Employee" WHERE "managerId" = ${employeeId} AND "deletedAt" IS NULL
      UNION
      SELECT e.id FROM "Employee" e JOIN tree t ON e."managerId" = t.id WHERE e."deletedAt" IS NULL
    )
    SELECT id FROM tree`;
  return rows.map((r) => r.id);
}

export async function departmentSubtree(rootIds: string[]): Promise<string[]> {
  if (!rootIds.length) return [];
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    WITH RECURSIVE tree AS (
      SELECT id FROM "Department" WHERE id = ANY(${rootIds}::text[])
      UNION
      SELECT d.id FROM "Department" d JOIN tree t ON d."parentId" = t.id
    )
    SELECT id FROM tree`;
  return rows.map((r) => r.id);
}

/** Throws 404 if the employee is outside the user's scope (404 rather than 403 to avoid leaking existence). */
export async function assertEmployeeInScope(user: AuthUser, employeeId: string) {
  const where = await employeeScope(user);
  const found = await prisma.employee.findFirst({ where: { AND: [where, { id: employeeId }] }, select: { id: true } });
  if (!found) throw notFound('Employee');
}

/** Company IDs the user may act on. */
export async function accessibleCompanyIds(user: AuthUser): Promise<string[]> {
  if (user.companyIds) return user.companyIds;
  if (user.scope === 'ALL') return (await prisma.company.findMany({ select: { id: true } })).map((c) => c.id);
  return user.companyId ? [user.companyId] : [];
}

export async function assertCompanyAccess(user: AuthUser, companyId: string) {
  const ids = await accessibleCompanyIds(user);
  if (!ids.includes(companyId)) throw forbidden('You do not have access to this company');
}

/** Resolves the company for a request: explicit (checked) or the user's default. */
export async function resolveCompanyId(user: AuthUser, requested?: string | null): Promise<string> {
  if (requested) {
    await assertCompanyAccess(user, requested);
    return requested;
  }
  const ids = await accessibleCompanyIds(user);
  if (user.preferredCompanyId && ids.includes(user.preferredCompanyId)) return user.preferredCompanyId;
  if (user.companyId) return user.companyId;
  if (!ids.length) throw forbidden('No company is associated with your account');
  return ids[0];
}
