import { z } from 'zod';
import { createRouter, dateString, idParam, paged, pageQuery, paging, sortBy } from '../../lib/http';
import { prisma, Prisma } from '../../lib/prisma';
import { assertCompanyAccess, assertEmployeeInScope, employeeScope, resolveCompanyId } from '../../auth/scope';
import { hasPermission } from '../../auth/context';
import { AuthUser } from '../../auth/context';
import { badRequest, forbidden, notFound } from '../../lib/errors';
import { audit, diff, ipOf } from '../../lib/audit';
import { resolveStored, saveFile, upload } from '../../lib/storage';
import { toDateOnly } from '../../lib/dates';
import { available, ensureAllBalances } from './balances';
import { adjustBalance, cancelLeave, createLeaveRequest, validateLeave } from './service';

const r = createRouter('/api/leave', 'Leave');
export default r;

async function targetEmployee(user: AuthUser, employeeId: string | undefined, managePerm: 'leave.manage' | 'leave.read') {
  if (!employeeId || employeeId === user.employeeId) {
    if (!user.employeeId) throw badRequest('Your account is not linked to an employee record');
    return user.employeeId;
  }
  if (!hasPermission(user, managePerm)) throw forbidden();
  await assertEmployeeInScope(user, employeeId);
  return employeeId;
}

// ── Leave types ──

const leaveTypeSchema = z.object({
  code: z.string().trim().min(1).max(20).regex(/^[A-Z0-9_]+$/, 'Upper-case letters, digits and _ only'),
  name: z.string().trim().min(1).max(100),
  nameAr: z.string().trim().max(100).nullish(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#3b82f6'),
  isPaid: z.boolean().default(true),
  annualEntitlement: z.coerce.number().min(0).max(366),
  accrualMethod: z.enum(['ANNUAL', 'MONTHLY', 'NONE']).default('ANNUAL'),
  prorateFirstYear: z.boolean().default(true),
  maxCarryForward: z.coerce.number().min(0).max(366).default(0),
  allowNegativeBalance: z.boolean().default(false),
  allowHalfDay: z.boolean().default(true),
  countWeekendsAndHolidays: z.boolean().default(false),
  requiresAttachment: z.boolean().default(false),
  maxConsecutiveDays: z.number().int().positive().nullish(),
  minNoticeDays: z.number().int().min(0).default(0),
  minServiceMonths: z.number().int().min(0).default(0),
  genderRestriction: z.enum(['MALE', 'FEMALE']).nullish(),
  allowOverlap: z.boolean().default(false),
  isActive: z.boolean().default(true),
});

r.get('/types', { summary: 'List leave types', query: z.object({ companyId: z.string().uuid().optional(), all: z.enum(['true', 'false']).optional() }) }, async ({ user, query }) => {
  const companyId = await resolveCompanyId(user, query.companyId);
  return prisma.leaveType.findMany({ where: { companyId, ...(query.all === 'true' ? {} : { isActive: true }) }, orderBy: { name: 'asc' } });
});

r.post('/types', { summary: 'Create a leave type', permission: 'leavetype.manage', body: leaveTypeSchema.extend({ companyId: z.string().uuid().optional() }), status: 201 }, async ({ req, user, body }) => {
  const companyId = await resolveCompanyId(user, body.companyId);
  const t = await prisma.leaveType.create({ data: { ...body, companyId } });
  await audit({ userId: user.id, action: 'CREATE', entity: 'LeaveType', entityId: t.id, after: t, ip: ipOf(req) });
  return t;
});

r.put('/types/:id', { summary: 'Update a leave type policy', permission: 'leavetype.manage', params: idParam, body: leaveTypeSchema.partial() }, async ({ req, user, params, body }) => {
  const before = await prisma.leaveType.findUnique({ where: { id: params.id } });
  if (!before) throw notFound('Leave type');
  await assertCompanyAccess(user, before.companyId);
  const after = await prisma.leaveType.update({ where: { id: params.id }, data: body });
  const d = diff(before, after);
  if (d.changed) await audit({ userId: user.id, action: 'UPDATE', entity: 'LeaveType', entityId: params.id, before: d.before, after: d.after, ip: ipOf(req) });
  return after;
});

// ── Balances ──

r.get(
  '/balances',
  { summary: 'Leave balances of an employee (own by default)', query: z.object({ employeeId: z.string().uuid().optional(), year: z.coerce.number().int().optional() }) },
  async ({ user, query }) => {
    const employeeId = await targetEmployee(user, query.employeeId, 'leave.read');
    const year = query.year ?? new Date().getUTCFullYear();
    await prisma.$transaction((tx) => ensureAllBalances(tx, employeeId, year));
    const rows = await prisma.leaveBalance.findMany({ where: { employeeId, year, leaveType: { isActive: true } }, include: { leaveType: true }, orderBy: { leaveType: { name: 'asc' } } });
    return rows.map((b) => ({ ...b, available: available(b).toNumber() }));
  },
);

r.post(
  '/balances/adjust',
  {
    summary: 'Manually adjust a leave balance (positive or negative)',
    permission: 'leave.manage',
    body: z.object({ employeeId: z.string().uuid(), leaveTypeId: z.string().uuid(), year: z.number().int(), delta: z.number().refine((n) => n !== 0, 'Adjustment cannot be zero'), reason: z.string().trim().min(3).max(500) }),
  },
  async ({ user, body }) => {
    await assertEmployeeInScope(user, body.employeeId);
    return adjustBalance(body, user.id);
  },
);

// ── Requests ──

const listQuery = pageQuery.extend({
  employeeId: z.string().uuid().optional(),
  status: z.enum(['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED']).optional(),
  leaveTypeId: z.string().uuid().optional(),
  from: dateString.optional(),
  to: dateString.optional(),
  departmentId: z.string().uuid().optional(),
  mine: z.enum(['true', 'false']).optional(),
});

r.get('/requests', { summary: 'List leave requests within data scope', query: listQuery }, async ({ user, query }) => {
  const scope = await employeeScope(user);
  const where: Prisma.LeaveRequestWhereInput = {
    employee: query.mine === 'true' || !hasPermission(user, 'leave.read') ? { id: user.employeeId ?? '__none__' } : { AND: [scope, query.departmentId ? { departmentId: query.departmentId } : {}] },
    ...(query.employeeId ? { employeeId: query.employeeId } : {}),
    ...(query.status ? { status: query.status } : {}),
    ...(query.leaveTypeId ? { leaveTypeId: query.leaveTypeId } : {}),
    ...(query.from ? { endDate: { gte: toDateOnly(query.from) } } : {}),
    ...(query.to ? { startDate: { lte: toDateOnly(query.to) } } : {}),
  };
  if (query.search) {
    where.AND = [{ employee: { OR: [{ firstName: { contains: query.search, mode: 'insensitive' } }, { lastName: { contains: query.search, mode: 'insensitive' } }, { employeeNo: { contains: query.search, mode: 'insensitive' } }] } }];
  }
  const [items, total] = await Promise.all([
    prisma.leaveRequest.findMany({
      where,
      include: { leaveType: { select: { id: true, name: true, nameAr: true, color: true, code: true } }, employee: { select: { id: true, employeeNo: true, firstName: true, lastName: true, firstNameAr: true, lastNameAr: true, department: { select: { name: true } } } } },
      orderBy: sortBy(query.sort, ['startDate', 'createdAt', 'status', 'days'], { createdAt: 'desc' }),
      ...paging(query),
    }),
    prisma.leaveRequest.count({ where }),
  ]);
  return paged(items, total, query);
});

r.get('/requests/:id', { summary: 'Get a leave request with its approval trail', params: idParam }, async ({ user, params }) => {
  const req = await prisma.leaveRequest.findUnique({
    where: { id: params.id },
    include: { leaveType: true, employee: { select: { id: true, employeeNo: true, firstName: true, lastName: true } } },
  });
  if (!req) throw notFound('Leave request');
  if (req.employeeId !== user.employeeId) {
    if (!hasPermission(user, 'leave.read')) throw notFound('Leave request');
    await assertEmployeeInScope(user, req.employeeId);
  }
  const approval = await prisma.approvalRequest.findUnique({
    where: { requestType_entityId: { requestType: 'LEAVE', entityId: req.id } },
    include: { actions: { include: { actor: { select: { displayName: true } } }, orderBy: { createdAt: 'asc' } } },
  });
  return { ...req, approval };
});

const boolish = z.preprocess((v) => v === true || v === 'true' || v === '1', z.boolean());
const createSchema = z.object({
  employeeId: z.string().uuid().optional(),
  leaveTypeId: z.string().uuid(),
  startDate: dateString,
  endDate: dateString,
  halfDay: boolish.optional(),
  reason: z.string().trim().max(1000).optional(),
  autoApprove: boolish.optional(),
});

r.get(
  '/preview',
  { summary: 'Check a prospective request: days counted, balance after, and policy violations', query: createSchema.omit({ autoApprove: true }) },
  async ({ user, query }) => {
    const employeeId = await targetEmployee(user, query.employeeId, 'leave.manage');
    try {
      const v = await validateLeave(prisma, { ...query, employeeId, attachmentPath: 'preview' });
      return { ok: true, days: v.days, balanceAfter: v.balanceAfter };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  },
);

r.post(
  '/requests',
  {
    summary: 'Submit a leave request (multipart; optional "attachment" file)',
    description: 'Employees submit for themselves. Users with leave.manage may submit for employees in scope and may record pre-approved leave with autoApprove.',
    body: createSchema,
    status: 201,
    middleware: [upload.single('attachment')],
  },
  async ({ req, user, body }) => {
    const employeeId = await targetEmployee(user, body.employeeId, 'leave.manage');
    if (employeeId === user.employeeId && !hasPermission(user, 'leave.request', 'leave.manage')) throw forbidden();
    if (body.autoApprove && !hasPermission(user, 'leave.manage')) throw forbidden('Only HR can record pre-approved leave');
    const attachmentPath = req.file ? saveFile('leave', req.file.originalname, req.file.buffer) : null;
    return createLeaveRequest({ ...body, employeeId, attachmentPath }, user.id, { autoApprove: !!body.autoApprove && employeeId !== user.employeeId });
  },
);

r.get('/requests/:id/attachment', { summary: 'Download the supporting document', params: idParam, raw: true }, async ({ res, user, params }) => {
  const req = await prisma.leaveRequest.findUnique({ where: { id: params.id } });
  if (!req?.attachmentPath) throw notFound('Attachment');
  if (req.employeeId !== user.employeeId) {
    if (!hasPermission(user, 'leave.read')) throw notFound('Attachment');
    await assertEmployeeInScope(user, req.employeeId);
  }
  res.sendFile(resolveStored(req.attachmentPath));
});

r.post(
  '/requests/:id/cancel',
  { summary: 'Cancel a pending request, or an approved one before it starts', params: idParam, body: z.object({ reason: z.string().trim().max(500).optional() }) },
  async ({ user, params, body }) => {
    const req = await prisma.leaveRequest.findUnique({ where: { id: params.id } });
    if (!req) throw notFound('Leave request');
    const own = req.employeeId === user.employeeId;
    const isHr = hasPermission(user, 'leave.manage');
    if (!own) {
      if (!isHr) throw forbidden();
      await assertEmployeeInScope(user, req.employeeId);
    }
    return cancelLeave(params.id, user.id, { isHr: isHr && !own ? true : isHr, reason: body.reason });
  },
);

r.get(
  '/calendar',
  { summary: 'Approved and pending leave in a date range (team calendar)', query: z.object({ from: dateString, to: dateString, departmentId: z.string().uuid().optional() }) },
  async ({ user, query }) => {
    const scope = await employeeScope(user);
    return prisma.leaveRequest.findMany({
      where: {
        status: { in: ['APPROVED', 'PENDING'] },
        startDate: { lte: toDateOnly(query.to) },
        endDate: { gte: toDateOnly(query.from) },
        employee: { AND: [scope, { deletedAt: null }, query.departmentId ? { departmentId: query.departmentId } : {}] },
      },
      select: {
        id: true, startDate: true, endDate: true, days: true, halfDay: true, status: true,
        leaveType: { select: { name: true, nameAr: true, color: true } },
        employee: { select: { id: true, firstName: true, lastName: true, firstNameAr: true, lastNameAr: true, department: { select: { name: true } } } },
      },
      orderBy: { startDate: 'asc' },
    });
  },
);
