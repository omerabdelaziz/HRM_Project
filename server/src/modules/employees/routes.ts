import { z } from 'zod';
import { createRouter, dateString, idParam, paged, pageQuery, paging, sortBy } from '../../lib/http';
import { prisma, Prisma } from '../../lib/prisma';
import { assertEmployeeInScope, employeeScope, resolveCompanyId } from '../../auth/scope';
import { hasPermission } from '../../auth/context';
import { badRequest, forbidden, notFound } from '../../lib/errors';
import { audit, ipOf } from '../../lib/audit';
import { deleteStored, resolveStored, saveFile, upload } from '../../lib/storage';
import { toDateOnly } from '../../lib/dates';
import {
  archiveEmployee, createEmployee, createEmployeeSchema, employeeInclude, findDuplicates, presentEmployee,
  separateEmployee, updateEmployee, updateEmployeeSchema,
} from './service';
import { exportEmployees, importEmployees, importTemplate } from './excel';

const r = createRouter('/api/employees', 'Employees');
export default r;

const STATUSES = ['PROBATION', 'ACTIVE', 'SUSPENDED', 'RESIGNED', 'TERMINATED', 'RETIRED'] as const;

const listQuery = pageQuery.extend({
  companyId: z.string().uuid().optional(),
  branchId: z.string().uuid().optional(),
  departmentId: z.string().uuid().optional(),
  positionId: z.string().uuid().optional(),
  managerId: z.string().uuid().optional(),
  categoryId: z.string().uuid().optional(),
  status: z.union([z.enum(STATUSES), z.array(z.enum(STATUSES))]).optional(),
  hiredFrom: dateString.optional(),
  hiredTo: dateString.optional(),
  includeArchived: z.enum(['true', 'false']).optional(),
});

async function listWhere(user: Parameters<typeof employeeScope>[0], q: z.infer<typeof listQuery>): Promise<Prisma.EmployeeWhereInput> {
  const scope = await employeeScope(user);
  const statuses = q.status ? (Array.isArray(q.status) ? q.status : [q.status]) : undefined;
  const and: Prisma.EmployeeWhereInput[] = [scope];
  if (q.includeArchived !== 'true') and.push({ deletedAt: null });
  if (q.companyId) and.push({ companyId: q.companyId });
  if (q.branchId) and.push({ branchId: q.branchId });
  if (q.departmentId) and.push({ departmentId: q.departmentId });
  if (q.positionId) and.push({ positionId: q.positionId });
  if (q.managerId) and.push({ managerId: q.managerId });
  if (q.categoryId) and.push({ categoryId: q.categoryId });
  if (statuses) and.push({ status: { in: statuses } });
  if (q.hiredFrom || q.hiredTo) and.push({ hireDate: { ...(q.hiredFrom ? { gte: toDateOnly(q.hiredFrom) } : {}), ...(q.hiredTo ? { lte: toDateOnly(q.hiredTo) } : {}) } });
  if (q.search) {
    const s = q.search;
    and.push({
      OR: [
        { firstName: { contains: s, mode: 'insensitive' } },
        { lastName: { contains: s, mode: 'insensitive' } },
        { firstNameAr: { contains: s } },
        { lastNameAr: { contains: s } },
        { employeeNo: { contains: s, mode: 'insensitive' } },
        { email: { contains: s, mode: 'insensitive' } },
        { phone: { contains: s } },
      ],
    });
  }
  return { AND: and };
}

r.get('/', { summary: 'Search and list employees within data scope', permission: 'employee.read', query: listQuery }, async ({ user, query }) => {
  const where = await listWhere(user, query);
  const [items, total] = await Promise.all([
    prisma.employee.findMany({
      where,
      include: {
        department: { select: { id: true, name: true, nameAr: true } },
        position: { select: { id: true, title: true, titleAr: true } },
        branch: { select: { id: true, name: true, nameAr: true } },
        manager: { select: { id: true, firstName: true, lastName: true } },
      },
      orderBy: sortBy(query.sort, ['employeeNo', 'firstName', 'lastName', 'hireDate', 'status', 'department.name', 'position.title'], { employeeNo: 'asc' }),
      ...paging(query),
    }),
    prisma.employee.count({ where }),
  ]);
  return paged(items.map((e) => presentEmployee(e, user)), total, query);
});

r.get('/lookup', { summary: 'Lightweight employee picker (id, number, name) within scope', query: z.object({ search: z.string().optional(), companyId: z.string().uuid().optional() }) }, async ({ user, query }) => {
  const where = await listWhere(user, { ...query, page: 1, pageSize: 20 } as z.infer<typeof listQuery>);
  return prisma.employee.findMany({
    where: { AND: [where, { status: { in: ['ACTIVE', 'PROBATION', 'SUSPENDED'] } }] },
    select: { id: true, employeeNo: true, firstName: true, lastName: true, firstNameAr: true, lastNameAr: true, user: { select: { id: true } } },
    orderBy: { firstName: 'asc' },
    take: 20,
  });
});

r.get('/export', { summary: 'Export the filtered employee list to Excel', permission: 'employee.export', query: listQuery, raw: true }, async ({ req, res, user, query }) => {
  const buf = await exportEmployees(await listWhere(user, query), user);
  await audit({ userId: user.id, action: 'EXPORT', entity: 'Employee', after: { filters: query }, ip: ipOf(req) });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="employees-${new Date().toISOString().slice(0, 10)}.xlsx"`);
  res.send(buf);
});

r.get('/import/template', { summary: 'Download the Excel import template', permission: 'employee.import', raw: true }, async ({ res }) => {
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="employee-import-template.xlsx"');
  res.send(await importTemplate());
});

r.post(
  '/import',
  {
    summary: 'Bulk import employees from Excel (multipart field "file")',
    description: 'All rows are validated first. Nothing is saved unless every row is valid. Use dryRun=true to validate only.',
    permission: 'employee.import',
    middleware: [upload.single('file')],
    body: z.object({ companyId: z.string().uuid().optional(), dryRun: z.preprocess((v) => v === 'true' || v === true, z.boolean()).default(true) }),
  },
  async ({ req, user, body }) => {
    if (!req.file) throw badRequest('Attach an .xlsx file in the "file" field');
    const companyId = await resolveCompanyId(user, body.companyId);
    const result = await importEmployees(req.file.buffer, companyId, user, body.dryRun);
    if (result.committed) await audit({ userId: user.id, action: 'IMPORT', entity: 'Employee', after: result.summary, ip: ipOf(req) });
    return result;
  },
);

r.post(
  '/check-duplicates',
  { summary: 'Check for existing employees with the same email, national ID, or name + date of birth', permission: ['employee.create', 'employee.update'], body: z.object({ companyId: z.string().uuid().optional(), email: z.string().optional(), nationalId: z.string().optional(), firstName: z.string().optional(), lastName: z.string().optional(), dateOfBirth: dateString.optional(), excludeId: z.string().uuid().optional() }) },
  async ({ user, body }) => findDuplicates(prisma, await resolveCompanyId(user, body.companyId), body, body.excludeId),
);

r.post('/', { summary: 'Create an employee (optionally with a user account)', permission: 'employee.create', body: createEmployeeSchema, status: 201 }, async ({ user, body }) => {
  const companyId = await resolveCompanyId(user, body.companyId);
  if (body.createUserAccount && !hasPermission(user, 'user.manage')) throw forbidden('Creating user accounts requires the user.manage permission');
  const { employee, temporaryPassword } = await prisma.$transaction((tx) => createEmployee(tx, companyId, body, user));
  const full = await prisma.employee.findUniqueOrThrow({ where: { id: employee.id }, include: employeeInclude });
  return { ...presentEmployee(full, user), temporaryPassword };
});

r.get('/:id', { summary: 'Employee profile', params: idParam }, async ({ user, params }) => {
  if (params.id !== user.employeeId && !hasPermission(user, 'employee.read')) throw forbidden();
  await assertEmployeeInScope(user, params.id);
  const e = await prisma.employee.findUnique({ where: { id: params.id }, include: { ...employeeInclude, _count: { select: { reports: true, documents: { where: { deletedAt: null } } } } } });
  if (!e) throw notFound('Employee');
  return presentEmployee(e, user);
});

r.put('/:id', { summary: 'Update an employee; org changes are recorded in history', permission: 'employee.update', params: idParam, body: updateEmployeeSchema }, async ({ user, params, body }) => {
  await assertEmployeeInScope(user, params.id);
  if ((body.nationalId !== undefined || body.bankAccount !== undefined || body.iban !== undefined) && !hasPermission(user, 'employee.sensitive.read')) {
    throw forbidden('Changing national ID or bank details requires access to sensitive data');
  }
  await updateEmployee(params.id, body, user);
  return presentEmployee(await prisma.employee.findUniqueOrThrow({ where: { id: params.id }, include: employeeInclude }), user);
});

/** Fields an employee may change on their own profile via self-service. */
const selfUpdateSchema = z.object({
  phone: z.string().trim().max(30).nullish(),
  personalEmail: z.string().trim().toLowerCase().email().nullish(),
  address: z.string().trim().max(500).nullish(),
  maritalStatus: z.enum(['SINGLE', 'MARRIED', 'DIVORCED', 'WIDOWED']).nullish(),
  emergencyContact: z.object({ name: z.string().max(100), relation: z.string().max(50).optional(), phone: z.string().max(30) }).nullish(),
  firstNameAr: z.string().trim().max(100).nullish(),
  lastNameAr: z.string().trim().max(100).nullish(),
});

r.patch('/me', { summary: 'Update permitted fields of my own profile', body: selfUpdateSchema }, async ({ user, body }) => {
  if (!user.employeeId) throw badRequest('Your account is not linked to an employee record');
  await updateEmployee(user.employeeId, body, user);
  return presentEmployee(await prisma.employee.findUniqueOrThrow({ where: { id: user.employeeId }, include: employeeInclude }), user);
});

r.post(
  '/:id/separate',
  {
    summary: 'Record a resignation, termination or retirement',
    permission: 'employee.update',
    params: idParam,
    body: z.object({ type: z.enum(['RESIGNED', 'TERMINATED', 'RETIRED']), date: dateString, reason: z.string().trim().min(3).max(1000) }),
  },
  async ({ user, params, body }) => {
    await assertEmployeeInScope(user, params.id);
    return presentEmployee(await separateEmployee(params.id, body, user), user);
  },
);

r.delete('/:id', { summary: 'Archive an employee created in error (not for separations)', permission: 'employee.delete', params: idParam }, async ({ user, params }) => {
  await assertEmployeeInScope(user, params.id);
  await archiveEmployee(params.id, user);
});

r.get('/:id/history', { summary: 'Employment history: hire, transfers, promotions, status and salary changes', params: idParam }, async ({ user, params }) => {
  if (params.id !== user.employeeId && !hasPermission(user, 'employee.read')) throw forbidden();
  await assertEmployeeInScope(user, params.id);
  const rows = await prisma.employeeHistory.findMany({ where: { employeeId: params.id }, orderBy: [{ effectiveDate: 'desc' }, { createdAt: 'desc' }] });
  const canSalary = hasPermission(user, 'employee.salary.read') || params.id === user.employeeId;
  const visible = rows.filter((h) => h.type !== 'SALARY_CHANGE' || canSalary);
  // Resolve ids in history values to names for display.
  const ids = new Set<string>();
  for (const h of visible) for (const v of [h.fromValue, h.toValue]) if (v && typeof v === 'object') Object.values(v as Record<string, unknown>).forEach((x) => typeof x === 'string' && /^[0-9a-f-]{36}$/.test(x) && ids.add(x));
  const idList = [...ids];
  const [depts, positions, branches, grades, emps, ccs] = await Promise.all([
    prisma.department.findMany({ where: { id: { in: idList } }, select: { id: true, name: true } }),
    prisma.position.findMany({ where: { id: { in: idList } }, select: { id: true, title: true } }),
    prisma.branch.findMany({ where: { id: { in: idList } }, select: { id: true, name: true } }),
    prisma.jobGrade.findMany({ where: { id: { in: idList } }, select: { id: true, name: true } }),
    prisma.employee.findMany({ where: { id: { in: idList } }, select: { id: true, firstName: true, lastName: true } }),
    prisma.costCenter.findMany({ where: { id: { in: idList } }, select: { id: true, name: true } }),
  ]);
  const names: Record<string, string> = {};
  depts.forEach((x) => (names[x.id] = x.name));
  positions.forEach((x) => (names[x.id] = x.title));
  branches.forEach((x) => (names[x.id] = x.name));
  grades.forEach((x) => (names[x.id] = x.name));
  ccs.forEach((x) => (names[x.id] = x.name));
  emps.forEach((x) => (names[x.id] = `${x.firstName} ${x.lastName}`));
  return { items: visible, names };
});

// ── Documents ──

const DOC_TYPES = ['CONTRACT', 'ID', 'PASSPORT', 'VISA', 'CERTIFICATE', 'LETTER', 'OTHER'] as const;

r.get('/:id/documents', { summary: "Employee's documents", params: idParam }, async ({ user, params }) => {
  const own = params.id === user.employeeId;
  if (!own && !hasPermission(user, 'document.read')) throw forbidden();
  await assertEmployeeInScope(user, params.id);
  const canConfidential = hasPermission(user, 'document.confidential.read');
  return prisma.employeeDocument.findMany({
    where: { employeeId: params.id, deletedAt: null, ...(canConfidential ? {} : { confidential: false }) },
    orderBy: { createdAt: 'desc' },
  });
});

r.post(
  '/:id/documents',
  {
    summary: 'Upload a document (multipart field "file")',
    permission: 'document.manage',
    params: idParam,
    status: 201,
    middleware: [upload.single('file')],
    body: z.object({
      type: z.enum(DOC_TYPES),
      title: z.string().trim().min(1).max(200),
      documentNo: z.string().trim().max(100).optional(),
      issueDate: dateString.optional().or(z.literal('').transform(() => undefined)),
      expiryDate: dateString.optional().or(z.literal('').transform(() => undefined)),
      confidential: z.preprocess((v) => v === 'true' || v === true, z.boolean()).default(false),
    }),
  },
  async ({ req, user, params, body }) => {
    await assertEmployeeInScope(user, params.id);
    if (!req.file) throw badRequest('Attach a file in the "file" field');
    if (body.issueDate && body.expiryDate && body.expiryDate < body.issueDate) throw badRequest('Expiry date must be after issue date');
    const storagePath = saveFile(`employees/${params.id}`, req.file.originalname, req.file.buffer);
    const doc = await prisma.employeeDocument.create({
      data: {
        employeeId: params.id,
        type: body.type,
        title: body.title,
        documentNo: body.documentNo,
        issueDate: body.issueDate ? toDateOnly(body.issueDate) : null,
        expiryDate: body.expiryDate ? toDateOnly(body.expiryDate) : null,
        confidential: body.confidential,
        fileName: req.file.originalname,
        mimeType: req.file.mimetype,
        sizeBytes: req.file.size,
        storagePath,
        uploadedById: user.id,
      },
    });
    await audit({ userId: user.id, action: 'UPLOAD', entity: 'EmployeeDocument', entityId: doc.id, after: doc, ip: ipOf(req) });
    return doc;
  },
);

r.get('/:id/documents/:docId/download', { summary: 'Download a document', params: z.object({ id: z.string().uuid(), docId: z.string().uuid() }), raw: true }, async ({ req, res, user, params }) => {
  const own = params.id === user.employeeId;
  if (!own && !hasPermission(user, 'document.read')) throw forbidden();
  await assertEmployeeInScope(user, params.id);
  const doc = await prisma.employeeDocument.findFirst({ where: { id: params.docId, employeeId: params.id, deletedAt: null } });
  if (!doc) throw notFound('Document');
  if (doc.confidential && !hasPermission(user, 'document.confidential.read')) throw notFound('Document');
  await audit({ userId: user.id, action: 'DOWNLOAD', entity: 'EmployeeDocument', entityId: doc.id, ip: ipOf(req) });
  res.setHeader('Content-Type', doc.mimeType);
  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(doc.fileName)}"`);
  res.sendFile(resolveStored(doc.storagePath));
});

r.delete('/:id/documents/:docId', { summary: 'Delete a document', permission: 'document.manage', params: z.object({ id: z.string().uuid(), docId: z.string().uuid() }) }, async ({ req, user, params }) => {
  await assertEmployeeInScope(user, params.id);
  const doc = await prisma.employeeDocument.findFirst({ where: { id: params.docId, employeeId: params.id, deletedAt: null } });
  if (!doc) throw notFound('Document');
  // Soft delete keeps the audit trail; the file itself is removed.
  await prisma.employeeDocument.update({ where: { id: doc.id }, data: { deletedAt: new Date() } });
  deleteStored(doc.storagePath);
  await audit({ userId: user.id, action: 'DELETE', entity: 'EmployeeDocument', entityId: doc.id, before: doc, ip: ipOf(req) });
});

r.post('/:id/photo', { summary: 'Upload a profile photo', permission: 'employee.update', params: idParam, middleware: [upload.single('file')] }, async ({ req, user, params }) => {
  await assertEmployeeInScope(user, params.id);
  if (!req.file || !req.file.mimetype.startsWith('image/')) throw badRequest('Attach an image in the "file" field');
  const before = await prisma.employee.findUniqueOrThrow({ where: { id: params.id }, select: { photoPath: true } });
  const photoPath = saveFile('photos', req.file.originalname, req.file.buffer);
  await prisma.employee.update({ where: { id: params.id }, data: { photoPath } });
  if (before.photoPath) deleteStored(before.photoPath);
  return { photoPath };
});

r.get('/:id/photo', { summary: 'Profile photo', params: idParam, raw: true }, async ({ res, user, params }) => {
  await assertEmployeeInScope(user, params.id);
  const e = await prisma.employee.findUnique({ where: { id: params.id }, select: { photoPath: true } });
  if (!e?.photoPath) throw notFound('Photo');
  res.setHeader('Cache-Control', 'private, max-age=3600');
  res.sendFile(resolveStored(e.photoPath));
});
