import { z } from 'zod';
import bcrypt from 'bcryptjs';
import { createRouter, dateString, idParam, paged, pageQuery, paging, sortBy } from '../../lib/http';
import { prisma, Prisma } from '../../lib/prisma';
import { assertCompanyAccess, assertEmployeeInScope, employeeScope, resolveCompanyId } from '../../auth/scope';
import { hasPermission, AuthUser } from '../../auth/context';
import { badRequest, forbidden, notFound, unauthorized } from '../../lib/errors';
import { audit, diff, ipOf } from '../../lib/audit';
import { randomToken } from '../../lib/crypto';
import { toDateOnly } from '../../lib/dates';
import { processDay, punch, recalculateRecord, requestCorrection, requestOvertime, upsertManualRecord } from './service';

const r = createRouter('/api/attendance', 'Attendance');
export default r;

function selfEmployee(user: AuthUser) {
  if (!user.employeeId) throw badRequest('Your account is not linked to an employee record');
  return user.employeeId;
}

async function readableEmployee(user: AuthUser, employeeId?: string) {
  if (!employeeId || employeeId === user.employeeId) return selfEmployee(user);
  if (!hasPermission(user, 'attendance.read')) throw forbidden();
  await assertEmployeeInScope(user, employeeId);
  return employeeId;
}

// ── Self service ──

r.post(
  '/punch',
  {
    summary: 'Check in or out (web/mobile)',
    permission: 'attendance.self',
    body: z.object({ source: z.enum(['WEB', 'MOBILE']).default('WEB'), lat: z.number().min(-90).max(90).optional(), lng: z.number().min(-180).max(180).optional() }),
  },
  async ({ user, body }) => punch({ employeeId: selfEmployee(user), ...body }),
);

r.get('/today', { summary: "My attendance record for today" }, async ({ user }) => {
  const employeeId = selfEmployee(user);
  return prisma.attendanceRecord.findFirst({ where: { employeeId }, orderBy: { date: 'desc' } });
});

// ── Records ──

const recordsQuery = pageQuery.extend({
  employeeId: z.string().uuid().optional(),
  from: dateString.optional(),
  to: dateString.optional(),
  status: z.enum(['PRESENT', 'LATE', 'ABSENT', 'HALF_DAY', 'ON_LEAVE', 'HOLIDAY', 'WEEKEND', 'MISSED_PUNCH']).optional(),
  departmentId: z.string().uuid().optional(),
  branchId: z.string().uuid().optional(),
  mine: z.enum(['true', 'false']).optional(),
});

r.get('/records', { summary: 'Attendance records within data scope', query: recordsQuery }, async ({ user, query }) => {
  let employeeWhere: Prisma.EmployeeWhereInput;
  if (query.mine === 'true' || !hasPermission(user, 'attendance.read')) employeeWhere = { id: selfEmployee(user) };
  else {
    employeeWhere = {
      AND: [
        await employeeScope(user),
        query.departmentId ? { departmentId: query.departmentId } : {},
        query.branchId ? { branchId: query.branchId } : {},
        query.search ? { OR: [{ firstName: { contains: query.search, mode: 'insensitive' } }, { lastName: { contains: query.search, mode: 'insensitive' } }, { employeeNo: { contains: query.search, mode: 'insensitive' } }] } : {},
      ],
    };
  }
  const where: Prisma.AttendanceRecordWhereInput = {
    employee: employeeWhere,
    ...(query.employeeId ? { employeeId: query.employeeId } : {}),
    ...(query.status ? { status: query.status } : {}),
    date: { ...(query.from ? { gte: toDateOnly(query.from) } : {}), ...(query.to ? { lte: toDateOnly(query.to) } : {}) },
  };
  const [items, total] = await Promise.all([
    prisma.attendanceRecord.findMany({
      where,
      include: { employee: { select: { id: true, employeeNo: true, firstName: true, lastName: true, firstNameAr: true, lastNameAr: true, department: { select: { name: true, nameAr: true } } } } },
      orderBy: sortBy(query.sort, ['date', 'checkIn', 'lateMinutes', 'overtimeMinutes', 'workedMinutes', 'status'], { date: 'desc' }),
      ...paging(query),
    }),
    prisma.attendanceRecord.count({ where }),
  ]);
  return paged(items, total, query);
});

r.put(
  '/records',
  {
    summary: 'Create or overwrite a day record (HR)',
    permission: 'attendance.manage',
    body: z.object({ employeeId: z.string().uuid(), date: dateString, checkIn: z.string().datetime({ offset: true }).nullish(), checkOut: z.string().datetime({ offset: true }).nullish(), notes: z.string().max(500).nullish() }),
  },
  async ({ user, body }) => {
    await assertEmployeeInScope(user, body.employeeId);
    return upsertManualRecord(body, user.id);
  },
);

r.post(
  '/records/recalculate',
  { summary: 'Recalculate records in a date range after a shift or holiday change', permission: 'attendance.manage', body: z.object({ employeeId: z.string().uuid().optional(), from: dateString, to: dateString }) },
  async ({ user, body }) => {
    const scope = await employeeScope(user);
    const records = await prisma.attendanceRecord.findMany({
      where: { date: { gte: toDateOnly(body.from), lte: toDateOnly(body.to) }, employee: scope, ...(body.employeeId ? { employeeId: body.employeeId } : {}) },
      select: { employeeId: true, date: true },
    });
    let updated = 0;
    for (const rec of records) {
      try {
        await recalculateRecord(prisma, rec.employeeId, rec.date);
        updated++;
      } catch {
        /* skip locked or invalid */
      }
    }
    return { updated };
  },
);

r.post(
  '/process-day',
  { summary: 'Close a day: mark absences and missed punches', permission: 'attendance.manage', body: z.object({ companyId: z.string().uuid().optional(), date: dateString }) },
  async ({ user, body }) => processDay(await resolveCompanyId(user, body.companyId), body.date),
);

r.get(
  '/summary',
  {
    summary: 'Per-employee totals for a period (worked hours, late, overtime, absences)',
    permission: ['attendance.read', 'attendance.self'],
    query: z.object({ from: dateString, to: dateString, employeeId: z.string().uuid().optional(), departmentId: z.string().uuid().optional() }),
  },
  async ({ user, query }) => {
    const employeeWhere = hasPermission(user, 'attendance.read')
      ? { AND: [await employeeScope(user), query.departmentId ? { departmentId: query.departmentId } : {}, query.employeeId ? { id: query.employeeId } : {}] }
      : { id: selfEmployee(user) };
    const rows = await prisma.attendanceRecord.groupBy({
      by: ['employeeId'],
      where: { date: { gte: toDateOnly(query.from), lte: toDateOnly(query.to) }, employee: employeeWhere },
      _sum: { workedMinutes: true, lateMinutes: true, earlyLeaveMinutes: true, overtimeMinutes: true, approvedOvertimeMinutes: true },
      _count: { _all: true },
    });
    const statusCounts = await prisma.attendanceRecord.groupBy({
      by: ['employeeId', 'status'],
      where: { date: { gte: toDateOnly(query.from), lte: toDateOnly(query.to) }, employee: employeeWhere },
      _count: { _all: true },
    });
    const employees = await prisma.employee.findMany({
      where: { id: { in: rows.map((r) => r.employeeId) } },
      select: { id: true, employeeNo: true, firstName: true, lastName: true, firstNameAr: true, lastNameAr: true, department: { select: { name: true } } },
    });
    return rows.map((row) => ({
      employee: employees.find((e) => e.id === row.employeeId),
      days: row._count._all,
      workedMinutes: row._sum.workedMinutes ?? 0,
      lateMinutes: row._sum.lateMinutes ?? 0,
      earlyLeaveMinutes: row._sum.earlyLeaveMinutes ?? 0,
      overtimeMinutes: row._sum.overtimeMinutes ?? 0,
      approvedOvertimeMinutes: row._sum.approvedOvertimeMinutes ?? 0,
      byStatus: Object.fromEntries(statusCounts.filter((s) => s.employeeId === row.employeeId).map((s) => [s.status, s._count._all])),
    }));
  },
);

// ── Corrections & overtime ──

r.post(
  '/corrections',
  {
    summary: 'Request an attendance correction (goes through approval)',
    permission: ['attendance.self', 'attendance.manage'],
    status: 201,
    body: z.object({ employeeId: z.string().uuid().optional(), date: dateString, checkIn: z.string().datetime({ offset: true }).nullish(), checkOut: z.string().datetime({ offset: true }).nullish(), reason: z.string().trim().min(3).max(1000) }),
  },
  async ({ user, body }) => {
    const employeeId = body.employeeId && body.employeeId !== user.employeeId ? body.employeeId : selfEmployee(user);
    if (employeeId !== user.employeeId) {
      if (!hasPermission(user, 'attendance.manage')) throw forbidden();
      await assertEmployeeInScope(user, employeeId);
    }
    return requestCorrection({ ...body, employeeId }, user.id);
  },
);

r.get('/corrections', { summary: 'Correction requests (own, or within scope)', query: pageQuery.extend({ mine: z.enum(['true', 'false']).optional(), status: z.string().optional() }) }, async ({ user, query }) => {
  const employee = query.mine === 'true' || !hasPermission(user, 'attendance.read') ? { id: selfEmployee(user) } : await employeeScope(user);
  const where: Prisma.AttendanceCorrectionWhereInput = { employee, ...(query.status ? { status: query.status } : {}) };
  const [items, total] = await Promise.all([
    prisma.attendanceCorrection.findMany({ where, include: { employee: { select: { id: true, employeeNo: true, firstName: true, lastName: true } } }, orderBy: { createdAt: 'desc' }, ...paging(query) }),
    prisma.attendanceCorrection.count({ where }),
  ]);
  return paged(items, total, query);
});

r.post(
  '/overtime',
  {
    summary: 'Request overtime approval (pre- or post-work)',
    permission: ['attendance.self', 'attendance.manage'],
    status: 201,
    body: z.object({ employeeId: z.string().uuid().optional(), date: dateString, minutes: z.number().int().min(15).max(16 * 60), reason: z.string().trim().min(3).max(1000) }),
  },
  async ({ user, body }) => {
    const employeeId = body.employeeId && body.employeeId !== user.employeeId ? body.employeeId : selfEmployee(user);
    if (employeeId !== user.employeeId) {
      if (!hasPermission(user, 'attendance.manage')) throw forbidden();
      await assertEmployeeInScope(user, employeeId);
    }
    return requestOvertime({ ...body, employeeId }, user.id);
  },
);

r.get('/overtime', { summary: 'Overtime requests (own, or within scope)', query: pageQuery.extend({ mine: z.enum(['true', 'false']).optional(), status: z.string().optional() }) }, async ({ user, query }) => {
  const employee = query.mine === 'true' || !hasPermission(user, 'attendance.read') ? { id: selfEmployee(user) } : await employeeScope(user);
  const where: Prisma.OvertimeRequestWhereInput = { employee, ...(query.status ? { status: query.status } : {}) };
  const [items, total] = await Promise.all([
    prisma.overtimeRequest.findMany({ where, include: { employee: { select: { id: true, employeeNo: true, firstName: true, lastName: true } } }, orderBy: { date: 'desc' }, ...paging(query) }),
    prisma.overtimeRequest.count({ where }),
  ]);
  return paged(items, total, query);
});

// ── Device integration ──

r.post(
  '/device/punches',
  {
    summary: 'Push punches from a biometric/attendance device',
    description: 'Authenticate with header "X-Device-Key". Each punch is matched by employee number; results are reported per punch.',
    public: true,
    body: z.object({ companyCode: z.string(), punches: z.array(z.object({ employeeNo: z.string(), timestamp: z.string().datetime({ offset: true }) })).min(1).max(1000) }),
  },
  async ({ req, body }) => {
    const key = req.headers['x-device-key'];
    const company = await prisma.company.findUnique({ where: { code: body.companyCode }, include: { attendancePolicy: true } });
    const hash = company?.attendancePolicy?.deviceApiKeyHash;
    if (!company || !hash || typeof key !== 'string' || !(await bcrypt.compare(key, hash))) throw unauthorized('Invalid device key');
    const sorted = [...body.punches].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    const results = [];
    for (const p of sorted) {
      const emp = await prisma.employee.findFirst({ where: { employeeNo: p.employeeNo, companyId: company.id, deletedAt: null }, select: { id: true } });
      if (!emp) {
        results.push({ ...p, ok: false, error: 'Unknown employee number' });
        continue;
      }
      try {
        const out = await punch({ employeeId: emp.id, at: new Date(p.timestamp), source: 'DEVICE' });
        results.push({ ...p, ok: true, action: out.action });
      } catch (e) {
        results.push({ ...p, ok: false, error: (e as Error).message });
      }
    }
    return { accepted: results.filter((x) => x.ok).length, rejected: results.filter((x) => !x.ok).length, results };
  },
);

// ── Shifts ──

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:mm');
const shiftSchema = z.object({
  code: z.string().trim().min(1).max(20),
  name: z.string().trim().min(1).max(100),
  nameAr: z.string().max(100).nullish(),
  startTime: hhmm,
  endTime: hhmm,
  breakMinutes: z.number().int().min(0).max(240).default(60),
  graceMinutes: z.number().int().min(0).max(120).default(10),
  earlyLeaveGraceMinutes: z.number().int().min(0).max(120).default(0),
  isFlexible: z.boolean().default(false),
  requiredMinutes: z.number().int().min(60).max(1440).nullish(),
  workDays: z.array(z.number().int().min(0).max(6)).min(1).max(7),
  isDefault: z.boolean().default(false),
  isActive: z.boolean().default(true),
});

export const shiftRouter = createRouter('/api/shifts', 'Shifts & holidays');
const s = shiftRouter;

s.get('/', { summary: 'List shifts', query: z.object({ companyId: z.string().uuid().optional() }) }, async ({ user, query }) =>
  prisma.shift.findMany({ where: { companyId: await resolveCompanyId(user, query.companyId) }, include: { _count: { select: { employees: true } } }, orderBy: { name: 'asc' } }),
);

s.post('/', { summary: 'Create a shift', permission: 'shift.manage', body: shiftSchema.extend({ companyId: z.string().uuid().optional() }), status: 201 }, async ({ req, user, body }) => {
  const companyId = await resolveCompanyId(user, body.companyId);
  const shift = await prisma.$transaction(async (tx) => {
    if (body.isDefault) await tx.shift.updateMany({ where: { companyId }, data: { isDefault: false } });
    return tx.shift.create({ data: { ...body, companyId } });
  });
  await audit({ userId: user.id, action: 'CREATE', entity: 'Shift', entityId: shift.id, after: shift, ip: ipOf(req) });
  return shift;
});

s.put('/:id', { summary: 'Update a shift', permission: 'shift.manage', params: idParam, body: shiftSchema.partial() }, async ({ req, user, params, body }) => {
  const before = await prisma.shift.findUnique({ where: { id: params.id } });
  if (!before) throw notFound('Shift');
  await assertCompanyAccess(user, before.companyId);
  const after = await prisma.$transaction(async (tx) => {
    if (body.isDefault) await tx.shift.updateMany({ where: { companyId: before.companyId, id: { not: params.id } }, data: { isDefault: false } });
    return tx.shift.update({ where: { id: params.id }, data: body });
  });
  const d = diff(before, after);
  if (d.changed) await audit({ userId: user.id, action: 'UPDATE', entity: 'Shift', entityId: params.id, before: d.before, after: d.after, ip: ipOf(req) });
  return after;
});

s.post(
  '/assignments',
  {
    summary: 'Assign employees to a shift for a date range (rotating shifts)',
    permission: 'shift.manage',
    status: 201,
    body: z.object({ shiftId: z.string().uuid(), employeeIds: z.array(z.string().uuid()).min(1).max(500), startDate: dateString, endDate: dateString }),
  },
  async ({ req, user, body }) => {
    if (body.endDate < body.startDate) throw badRequest('End date must be on or after start date');
    const shift = await prisma.shift.findUnique({ where: { id: body.shiftId } });
    if (!shift) throw notFound('Shift');
    await assertCompanyAccess(user, shift.companyId);
    for (const id of body.employeeIds) await assertEmployeeInScope(user, id);
    const created = await prisma.shiftAssignment.createMany({
      data: body.employeeIds.map((employeeId) => ({ employeeId, shiftId: body.shiftId, startDate: toDateOnly(body.startDate), endDate: toDateOnly(body.endDate) })),
    });
    await audit({ userId: user.id, action: 'ASSIGN', entity: 'ShiftAssignment', after: body, ip: ipOf(req) });
    return created;
  },
);

s.get('/assignments', { summary: 'Shift assignments overlapping a date range', permission: ['shift.manage', 'attendance.read'], query: z.object({ from: dateString, to: dateString }) }, async ({ user, query }) =>
  prisma.shiftAssignment.findMany({
    where: { startDate: { lte: toDateOnly(query.to) }, endDate: { gte: toDateOnly(query.from) }, employee: await employeeScope(user) },
    include: { shift: { select: { name: true, code: true, startTime: true, endTime: true } }, employee: { select: { id: true, firstName: true, lastName: true, employeeNo: true } } },
    orderBy: { startDate: 'asc' },
  }),
);

s.delete('/assignments/:id', { summary: 'Remove a shift assignment', permission: 'shift.manage', params: idParam }, async ({ user, params }) => {
  const a = await prisma.shiftAssignment.findUnique({ where: { id: params.id } });
  if (!a) throw notFound('Assignment');
  await assertEmployeeInScope(user, a.employeeId);
  await prisma.shiftAssignment.delete({ where: { id: params.id } });
});

// ── Holidays ──

s.get('/holidays', { summary: 'Public holidays for a year', query: z.object({ companyId: z.string().uuid().optional(), year: z.coerce.number().int().optional() }) }, async ({ user, query }) => {
  const companyId = await resolveCompanyId(user, query.companyId);
  const year = query.year ?? new Date().getUTCFullYear();
  return prisma.holiday.findMany({
    where: { companyId, date: { gte: new Date(Date.UTC(year, 0, 1)), lte: new Date(Date.UTC(year, 11, 31)) } },
    include: { branch: { select: { name: true } } },
    orderBy: { date: 'asc' },
  });
});

const holidaySchema = z.object({ date: dateString, name: z.string().trim().min(1).max(150), nameAr: z.string().max(150).nullish(), branchId: z.string().uuid().nullish() });

s.post('/holidays', { summary: 'Add a public holiday', permission: 'holiday.manage', body: holidaySchema.extend({ companyId: z.string().uuid().optional() }), status: 201 }, async ({ req, user, body }) => {
  const companyId = await resolveCompanyId(user, body.companyId);
  const dup = await prisma.holiday.findFirst({ where: { companyId, date: toDateOnly(body.date), branchId: body.branchId ?? null } });
  if (dup) throw badRequest('A holiday already exists on this date');
  const h = await prisma.holiday.create({ data: { ...body, companyId, date: toDateOnly(body.date) } });
  await audit({ userId: user.id, action: 'CREATE', entity: 'Holiday', entityId: h.id, after: h, ip: ipOf(req) });
  return h;
});

s.put('/holidays/:id', { summary: 'Update a holiday', permission: 'holiday.manage', params: idParam, body: holidaySchema.partial() }, async ({ user, params, body }) => {
  const h = await prisma.holiday.findUnique({ where: { id: params.id } });
  if (!h) throw notFound('Holiday');
  await assertCompanyAccess(user, h.companyId);
  return prisma.holiday.update({ where: { id: params.id }, data: { ...body, date: body.date ? toDateOnly(body.date) : undefined } });
});

s.delete('/holidays/:id', { summary: 'Delete a holiday', permission: 'holiday.manage', params: idParam }, async ({ req, user, params }) => {
  const h = await prisma.holiday.findUnique({ where: { id: params.id } });
  if (!h) throw notFound('Holiday');
  await assertCompanyAccess(user, h.companyId);
  await prisma.holiday.delete({ where: { id: params.id } });
  await audit({ userId: user.id, action: 'DELETE', entity: 'Holiday', entityId: h.id, before: h, ip: ipOf(req) });
});

// ── Attendance policy ──

s.get('/policy', { summary: 'Attendance policy of a company', permission: ['attendance.read', 'settings.manage'], query: z.object({ companyId: z.string().uuid().optional() }) }, async ({ user, query }) => {
  const companyId = await resolveCompanyId(user, query.companyId);
  const p = await prisma.attendancePolicy.upsert({ where: { companyId }, create: { companyId }, update: {} });
  return { ...p, deviceApiKeyHash: undefined, hasDeviceKey: !!p.deviceApiKeyHash };
});

s.put(
  '/policy',
  {
    summary: 'Update the attendance policy',
    permission: 'settings.manage',
    body: z.object({
      companyId: z.string().uuid().optional(),
      minOvertimeMinutes: z.number().int().min(0).max(600).optional(),
      overtimeRequiresApproval: z.boolean().optional(),
      halfDayThresholdMinutes: z.number().int().min(0).max(720).optional(),
      allowMobileCheckIn: z.boolean().optional(),
      allowWebCheckIn: z.boolean().optional(),
      geofenceLat: z.number().min(-90).max(90).nullish(),
      geofenceLng: z.number().min(-180).max(180).nullish(),
      geofenceRadiusMeters: z.number().int().min(10).max(100_000).nullish(),
    }),
  },
  async ({ req, user, body }) => {
    const { companyId: requested, ...data } = body;
    const companyId = await resolveCompanyId(user, requested);
    const before = await prisma.attendancePolicy.findUnique({ where: { companyId } });
    const after = await prisma.attendancePolicy.upsert({ where: { companyId }, create: { companyId, ...data }, update: data });
    await audit({ userId: user.id, action: 'UPDATE', entity: 'AttendancePolicy', entityId: after.id, before, after, ip: ipOf(req) });
    return { ...after, deviceApiKeyHash: undefined, hasDeviceKey: !!after.deviceApiKeyHash };
  },
);

s.post('/policy/device-key', { summary: 'Generate a new device API key (shown once)', permission: 'settings.manage', body: z.object({ companyId: z.string().uuid().optional() }) }, async ({ req, user, body }) => {
  const companyId = await resolveCompanyId(user, body.companyId);
  const key = randomToken(32);
  await prisma.attendancePolicy.upsert({ where: { companyId }, create: { companyId, deviceApiKeyHash: await bcrypt.hash(key, 10) }, update: { deviceApiKeyHash: await bcrypt.hash(key, 10) } });
  await audit({ userId: user.id, action: 'ROTATE_DEVICE_KEY', entity: 'AttendancePolicy', entityId: companyId, ip: ipOf(req) });
  return { deviceKey: key };
});
