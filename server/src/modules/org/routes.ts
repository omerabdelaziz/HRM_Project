import { z, ZodObject, ZodRawShape } from 'zod';
import { createRouter, idParam } from '../../lib/http';
import { prisma } from '../../lib/prisma';
import { accessibleCompanyIds, assertCompanyAccess, employeeScope, resolveCompanyId } from '../../auth/scope';
import { audit, diff, ipOf } from '../../lib/audit';
import { conflict, notFound } from '../../lib/errors';

const r = createRouter('/api/org', 'Organization');
export default r;

const code = z.string().trim().min(1).max(30).regex(/^[A-Za-z0-9_-]+$/, 'Letters, digits, - and _ only');
const name = z.string().trim().min(1).max(150);
const opt = z.string().trim().max(500).nullish();
const optUuid = z.string().uuid().nullish();
const money = z.coerce.number().nonnegative().nullish();

// ── Companies ──

const companySchema = z.object({
  code,
  name,
  nameAr: opt,
  legalName: opt,
  registrationNo: opt,
  taxNo: opt,
  email: z.string().email().nullish(),
  phone: opt,
  address: opt,
  baseCurrency: z.string().length(3).toUpperCase(),
  timezone: z.string().refine((tz) => {
    try {
      new Intl.DateTimeFormat('en', { timeZone: tz });
      return true;
    } catch {
      return false;
    }
  }, 'Unknown time zone'),
  locale: z.enum(['en', 'ar']).default('en'),
  dateFormat: z.string().max(20).default('yyyy-MM-dd'),
  weekendDays: z.array(z.number().int().min(0).max(6)).max(6),
  fiscalYearStartMonth: z.number().int().min(1).max(12).default(1),
  employeeNoPrefix: z.string().trim().max(10).regex(/^[A-Za-z0-9-]*$/),
  employeeNoPadding: z.number().int().min(3).max(10),
  isActive: z.boolean().default(true),
});

r.get('/companies', { summary: 'List companies the user can access', permission: 'org.read' }, async ({ user }) => {
  const ids = await accessibleCompanyIds(user);
  return prisma.company.findMany({ where: { id: { in: ids } }, orderBy: { name: 'asc' } });
});

r.get('/companies/:id', { summary: 'Get a company', permission: 'org.read', params: idParam }, async ({ user, params }) => {
  await assertCompanyAccess(user, params.id);
  return prisma.company.findUniqueOrThrow({ where: { id: params.id }, include: { payrollSettings: true, attendancePolicy: true } });
});

r.post('/companies', { summary: 'Create a company', permission: 'settings.manage', body: companySchema, status: 201 }, async ({ req, user, body }) => {
  if (user.scope !== 'ALL') throw conflict('Only users with global scope can create companies');
  const company = await prisma.company.create({
    data: { ...body, payrollSettings: { create: {} }, attendancePolicy: { create: {} } },
  });
  await audit({ userId: user.id, action: 'CREATE', entity: 'Company', entityId: company.id, after: company, ip: ipOf(req) });
  return company;
});

r.put('/companies/:id', { summary: 'Update company information and regional settings', permission: 'settings.manage', params: idParam, body: companySchema.partial() }, async ({ req, user, params, body }) => {
  await assertCompanyAccess(user, params.id);
  const before = await prisma.company.findUniqueOrThrow({ where: { id: params.id } });
  const after = await prisma.company.update({ where: { id: params.id }, data: body });
  const d = diff(before, after);
  if (d.changed) await audit({ userId: user.id, action: 'UPDATE', entity: 'Company', entityId: params.id, before: d.before, after: d.after, ip: ipOf(req) });
  return after;
});

// ── Generic CRUD for company-owned lookup entities ──

type Delegate = {
  findMany: (args: unknown) => Promise<unknown[]>;
  findUnique: (args: unknown) => Promise<Record<string, unknown> | null>;
  create: (args: unknown) => Promise<Record<string, unknown>>;
  update: (args: unknown) => Promise<Record<string, unknown>>;
  delete: (args: unknown) => Promise<unknown>;
  count: (args: unknown) => Promise<number>;
};

interface CrudOpts<S extends ZodRawShape> {
  path: string;
  entity: string;
  delegate: () => Delegate;
  schema: ZodObject<S>;
  include?: Record<string, unknown>;
  orderBy?: Record<string, unknown>;
  searchFields?: string[];
  /** Filters accepted on the list route besides companyId/search. */
  filters?: string[];
}

function crud<S extends ZodRawShape>(o: CrudOpts<S>) {
  const listQuery = z.object({
    companyId: z.string().uuid().optional(),
    search: z.string().optional(),
    active: z.enum(['true', 'false']).optional(),
    ...Object.fromEntries((o.filters ?? []).map((f) => [f, z.string().uuid().optional()])),
  });

  r.get(`/${o.path}`, { summary: `List ${o.entity}s`, permission: 'org.read', query: listQuery }, async ({ user, query }) => {
    const companyId = await resolveCompanyId(user, query.companyId);
    const where: Record<string, unknown> = { companyId };
    for (const f of o.filters ?? []) if ((query as Record<string, unknown>)[f]) where[f] = (query as Record<string, unknown>)[f];
    if (query.active) where.isActive = query.active === 'true';
    if (query.search && o.searchFields) {
      where.OR = o.searchFields.map((f) => ({ [f]: { contains: query.search, mode: 'insensitive' } }));
    }
    return o.delegate().findMany({ where, include: o.include, orderBy: o.orderBy ?? { name: 'asc' } });
  });

  r.get(`/${o.path}/:id`, { summary: `Get a ${o.entity}`, permission: 'org.read', params: idParam }, async ({ user, params }) => {
    const row = await o.delegate().findUnique({ where: { id: params.id }, include: o.include });
    if (!row) throw notFound(o.entity);
    await assertCompanyAccess(user, row.companyId as string);
    return row;
  });

  const createSchema = o.schema.extend({ companyId: z.string().uuid().optional() });
  r.post(`/${o.path}`, { summary: `Create a ${o.entity}`, permission: 'org.manage', body: createSchema, status: 201 }, async ({ req, user, body }) => {
    const companyId = await resolveCompanyId(user, body.companyId as string | undefined);
    const row = await o.delegate().create({ data: { ...body, companyId }, include: o.include });
    await audit({ userId: user.id, action: 'CREATE', entity: o.entity, entityId: row.id as string, after: row, ip: ipOf(req) });
    return row;
  });

  r.put(`/${o.path}/:id`, { summary: `Update a ${o.entity}`, permission: 'org.manage', params: idParam, body: o.schema.partial() }, async ({ req, user, params, body }) => {
    const before = await o.delegate().findUnique({ where: { id: params.id } });
    if (!before) throw notFound(o.entity);
    await assertCompanyAccess(user, before.companyId as string);
    if ('parentId' in body && body.parentId === params.id) throw conflict('An item cannot be its own parent');
    const after = await o.delegate().update({ where: { id: params.id }, data: body, include: o.include });
    const d = diff(before, after);
    if (d.changed) await audit({ userId: user.id, action: 'UPDATE', entity: o.entity, entityId: params.id, before: d.before, after: d.after, ip: ipOf(req) });
    return after;
  });

  r.delete(`/${o.path}/:id`, { summary: `Delete a ${o.entity} (only when unused; otherwise deactivate it)`, permission: 'org.manage', params: idParam }, async ({ req, user, params }) => {
    const before = await o.delegate().findUnique({ where: { id: params.id } });
    if (!before) throw notFound(o.entity);
    await assertCompanyAccess(user, before.companyId as string);
    try {
      await o.delegate().delete({ where: { id: params.id } });
    } catch (e) {
      if ((e as { code?: string }).code === 'P2003') {
        throw conflict(`This ${o.entity.toLowerCase()} is in use. Deactivate it instead of deleting it.`);
      }
      throw e;
    }
    await audit({ userId: user.id, action: 'DELETE', entity: o.entity, entityId: params.id, before, ip: ipOf(req) });
  });
}

crud({
  path: 'branches',
  entity: 'Branch',
  delegate: () => prisma.branch as unknown as Delegate,
  schema: z.object({ code, name, nameAr: opt, address: opt, city: opt, country: opt, timezone: opt, managerId: optUuid, isActive: z.boolean().optional() }),
  include: { manager: { select: { id: true, firstName: true, lastName: true, employeeNo: true } }, _count: { select: { employees: true } } },
  searchFields: ['name', 'code', 'city'],
});

crud({
  path: 'departments',
  entity: 'Department',
  delegate: () => prisma.department as unknown as Delegate,
  schema: z.object({ code, name, nameAr: opt, branchId: optUuid, parentId: optUuid, managerId: optUuid, costCenterId: optUuid, isActive: z.boolean().optional() }),
  include: {
    manager: { select: { id: true, firstName: true, lastName: true, employeeNo: true } },
    branch: { select: { id: true, name: true } },
    parent: { select: { id: true, name: true } },
    costCenter: { select: { id: true, code: true, name: true } },
    _count: { select: { employees: true, children: true } },
  },
  searchFields: ['name', 'code'],
  filters: ['branchId', 'parentId'],
});

crud({
  path: 'positions',
  entity: 'Position',
  delegate: () => prisma.position as unknown as Delegate,
  schema: z.object({ code, title: name, titleAr: opt, description: z.string().max(5000).nullish(), departmentId: optUuid, gradeId: optUuid, headcount: z.number().int().min(0).default(1), isActive: z.boolean().optional() }),
  include: { department: { select: { id: true, name: true } }, grade: { select: { id: true, code: true, name: true } }, _count: { select: { employees: true } } },
  orderBy: { title: 'asc' },
  searchFields: ['title', 'code'],
  filters: ['departmentId'],
});

crud({
  path: 'grades',
  entity: 'JobGrade',
  delegate: () => prisma.jobGrade as unknown as Delegate,
  schema: z.object({ code, name, level: z.number().int().min(0).default(1), minSalary: money, maxSalary: money }),
  orderBy: { level: 'asc' },
});

crud({
  path: 'cost-centers',
  entity: 'CostCenter',
  delegate: () => prisma.costCenter as unknown as Delegate,
  schema: z.object({ code, name }),
  searchFields: ['name', 'code'],
});

crud({
  path: 'categories',
  entity: 'EmployeeCategory',
  delegate: () => prisma.employeeCategory as unknown as Delegate,
  schema: z.object({ code, name, nameAr: opt }),
});

crud({
  path: 'employment-types',
  entity: 'EmploymentType',
  delegate: () => prisma.employmentType as unknown as Delegate,
  schema: z.object({ code, name, nameAr: opt }),
});

// ── Org chart & workforce ──

r.get(
  '/chart',
  { summary: 'Reporting-line tree of employees visible to the user', permission: ['org.read', 'employee.read'], query: z.object({ companyId: z.string().uuid().optional() }) },
  async ({ user, query }) => {
    const companyId = await resolveCompanyId(user, query.companyId);
    const scope = await employeeScope(user);
    const people = await prisma.employee.findMany({
      where: { AND: [scope, { companyId, deletedAt: null, status: { in: ['ACTIVE', 'PROBATION', 'SUSPENDED'] } }] },
      select: {
        id: true, employeeNo: true, firstName: true, lastName: true, firstNameAr: true, lastNameAr: true, photoPath: true, managerId: true,
        position: { select: { title: true, titleAr: true } }, department: { select: { id: true, name: true, nameAr: true } },
      },
      orderBy: { firstName: 'asc' },
    });
    const ids = new Set(people.map((p) => p.id));
    // Employees whose manager is not visible become roots.
    return people.map((p) => ({ ...p, managerId: p.managerId && ids.has(p.managerId) ? p.managerId : null }));
  },
);

r.get(
  '/workforce',
  { summary: 'Headcount vs budgeted positions per department', permission: ['org.read'], query: z.object({ companyId: z.string().uuid().optional() }) },
  async ({ user, query }) => {
    const companyId = await resolveCompanyId(user, query.companyId);
    const [departments, positions] = await Promise.all([
      prisma.department.findMany({
        where: { companyId, isActive: true },
        select: { id: true, code: true, name: true, nameAr: true, _count: { select: { employees: { where: { deletedAt: null, status: { in: ['ACTIVE', 'PROBATION'] } } } } } },
        orderBy: { name: 'asc' },
      }),
      prisma.position.findMany({
        where: { companyId, isActive: true },
        select: { id: true, title: true, departmentId: true, headcount: true, _count: { select: { employees: { where: { deletedAt: null, status: { in: ['ACTIVE', 'PROBATION'] } } } } } },
      }),
    ]);
    return departments.map((d) => {
      const pos = positions.filter((p) => p.departmentId === d.id);
      const budgeted = pos.reduce((s, p) => s + p.headcount, 0);
      const filled = d._count.employees;
      return {
        id: d.id, code: d.code, name: d.name, nameAr: d.nameAr, filled, budgeted, vacancies: Math.max(0, budgeted - filled),
        positions: pos.map((p) => ({ id: p.id, title: p.title, budgeted: p.headcount, filled: p._count.employees, vacancies: Math.max(0, p.headcount - p._count.employees) })),
      };
    });
  },
);
