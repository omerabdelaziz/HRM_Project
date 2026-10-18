import type { LeaveType } from '@prisma/client';
import { prisma, Prisma, Tx } from '../../lib/prisma';
import { badRequest, notFound, unprocessable } from '../../lib/errors';
import { addDays, daysBetweenInclusive, isoDate, monthsBetween, toDateOnly } from '../../lib/dates';
import { employeeCalendar } from '../attendance/calendar';
import { registerWorkflowHandler, submitForApproval, cancelRequest } from '../workflow/engine';
import { available, changeBalance, ensureBalance } from './balances';
import { audit } from '../../lib/audit';
import { notify } from '../notifications/service';

export interface LeaveInput {
  employeeId: string;
  leaveTypeId: string;
  startDate: string;
  endDate: string;
  halfDay?: boolean;
  reason?: string | null;
  attachmentPath?: string | null;
}

/** Number of leave days a request consumes, honoring the type's weekend/holiday rule. */
export async function countLeaveDays(db: Tx | typeof prisma, employeeId: string, type: LeaveType, start: Date, end: Date, halfDay: boolean) {
  if (halfDay) return start.getTime() === end.getTime() ? 0.5 : NaN;
  if (type.countWeekendsAndHolidays) return daysBetweenInclusive(start, end);
  const cal = await employeeCalendar(employeeId, start, end, db);
  return cal.filter((d) => d.isWorkingDay).length;
}

/** Validates a leave request against policy and returns the computed days and balance. Throws on violations. */
export async function validateLeave(db: Tx | typeof prisma, input: LeaveInput, opts: { excludeRequestId?: string; today?: Date; skipNotice?: boolean } = {}) {
  const start = toDateOnly(input.startDate);
  const end = toDateOnly(input.endDate);
  const today = toDateOnly(opts.today ?? new Date());
  if (end < start) throw badRequest('End date must be on or after the start date');
  if (start.getUTCFullYear() !== end.getUTCFullYear()) {
    throw unprocessable('A leave request cannot span two calendar years. Please submit one request per year.');
  }

  const [employee, type] = await Promise.all([
    db.employee.findUnique({ where: { id: input.employeeId }, select: { id: true, companyId: true, gender: true, hireDate: true, status: true, deletedAt: true, departmentId: true, branchId: true, firstName: true, lastName: true } }),
    db.leaveType.findUnique({ where: { id: input.leaveTypeId } }),
  ]);
  if (!employee || employee.deletedAt) throw notFound('Employee');
  if (!type || !type.isActive || type.companyId !== employee.companyId) throw badRequest('This leave type is not available');
  if (['RESIGNED', 'TERMINATED', 'RETIRED'].includes(employee.status)) throw unprocessable('Separated employees cannot request leave');
  if (type.genderRestriction && employee.gender && type.genderRestriction !== employee.gender) {
    throw unprocessable(`${type.name} is not available for this employee`);
  }
  if (type.minServiceMonths > 0 && monthsBetween(employee.hireDate, start) < type.minServiceMonths) {
    throw unprocessable(`${type.name} requires at least ${type.minServiceMonths} months of service`);
  }
  if (input.halfDay && !type.allowHalfDay) throw unprocessable(`${type.name} cannot be taken as a half day`);
  if (input.halfDay && start.getTime() !== end.getTime()) throw badRequest('A half-day leave must start and end on the same day');
  if (!opts.skipNotice && type.minNoticeDays > 0 && start < addDays(today, type.minNoticeDays)) {
    throw unprocessable(`${type.name} must be requested at least ${type.minNoticeDays} day(s) in advance`);
  }
  if (type.requiresAttachment && !input.attachmentPath) throw unprocessable(`${type.name} requires a supporting document`);

  const days = await countLeaveDays(db, employee.id, type, start, end, !!input.halfDay);
  if (!days || days <= 0) throw unprocessable('The selected dates contain no working days');
  if (type.maxConsecutiveDays && days > type.maxConsecutiveDays) {
    throw unprocessable(`${type.name} is limited to ${type.maxConsecutiveDays} consecutive day(s)`);
  }

  // Overlap with the employee's other pending/approved requests.
  const overlapping = await db.leaveRequest.findMany({
    where: {
      employeeId: employee.id,
      status: { in: ['PENDING', 'APPROVED'] },
      startDate: { lte: end },
      endDate: { gte: start },
      ...(opts.excludeRequestId ? { id: { not: opts.excludeRequestId } } : {}),
    },
    include: { leaveType: true },
  });
  const blocking = overlapping.filter((o) => !(type.allowOverlap && o.leaveType.allowOverlap));
  // Two half days on the same date are allowed (morning + afternoon), but not a third.
  let realConflicts = blocking;
  if (input.halfDay) {
    const sameDayHalves = blocking.filter((o) => o.halfDay && o.startDate.getTime() === start.getTime());
    if (sameDayHalves.length < 2) realConflicts = blocking.filter((o) => !sameDayHalves.includes(o));
  }
  if (realConflicts.length) {
    const o = realConflicts[0];
    throw unprocessable(`Overlaps an existing ${o.leaveType.name} request (${isoDate(o.startDate)} to ${isoDate(o.endDate)})`, { conflictId: o.id });
  }

  let balanceAfter: number | null = null;
  if (type.accrualMethod !== 'NONE') {
    const bal = await ensureBalance(db, employee.id, type, start.getUTCFullYear(), end);
    const avail = available(bal).toNumber();
    balanceAfter = avail - days;
    if (balanceAfter < 0 && !type.allowNegativeBalance) {
      throw unprocessable(`Insufficient ${type.name} balance: ${avail} day(s) available, ${days} requested`, { available: avail, requested: days });
    }
  }
  return { employee, type, start, end, days, balanceAfter };
}

export async function createLeaveRequest(input: LeaveInput, requesterUserId: string, opts: { autoApprove?: boolean } = {}) {
  return prisma.$transaction(async (tx) => {
    // Serialize requests per employee so concurrent submissions cannot both pass the balance/overlap checks.
    await tx.$queryRaw`SELECT id FROM "Employee" WHERE id = ${input.employeeId} FOR UPDATE`;
    // HR recording leave on behalf of an employee is not bound by the notice period.
    const v = await validateLeave(tx, input, { skipNotice: opts.autoApprove });
    const request = await tx.leaveRequest.create({
      data: {
        employeeId: v.employee.id,
        leaveTypeId: v.type.id,
        startDate: v.start,
        endDate: v.end,
        halfDay: !!input.halfDay,
        days: v.days,
        reason: input.reason,
        attachmentPath: input.attachmentPath,
        status: 'PENDING',
      },
    });
    if (v.type.accrualMethod !== 'NONE') await changeBalance(tx, v.employee.id, v.type, v.start.getUTCFullYear(), { pending: v.days });
    await audit({ userId: requesterUserId, action: 'CREATE', entity: 'LeaveRequest', entityId: request.id, after: request }, tx);

    const title = `${v.type.name}: ${v.employee.firstName} ${v.employee.lastName}, ${isoDate(v.start)}${v.days > 1 ? ` to ${isoDate(v.end)}` : ''} (${v.days} day${v.days === 1 ? '' : 's'})`;
    if (opts.autoApprove) {
      await approveLeave(tx, request.id, requesterUserId);
      await tx.approvalRequest.create({
        data: {
          companyId: v.employee.companyId, requestType: 'LEAVE', entityId: request.id, requesterId: requesterUserId, employeeId: v.employee.id,
          title, status: 'APPROVED', completedAt: new Date(),
          actions: { create: [{ stepOrder: 0, actorId: requesterUserId, decision: 'APPROVED', comment: 'Recorded by HR on behalf of the employee' }] },
        },
      });
    } else {
      await submitForApproval(tx, {
        companyId: v.employee.companyId,
        requestType: 'LEAVE',
        entityId: request.id,
        requesterId: requesterUserId,
        employeeId: v.employee.id,
        title,
        summary: { leaveType: v.type.name, startDate: isoDate(v.start), endDate: isoDate(v.end), days: v.days, reason: input.reason, balanceAfter: v.balanceAfter },
        amount: v.days,
        context: { leaveTypeCode: v.type.code, departmentId: v.employee.departmentId, branchId: v.employee.branchId },
      });
    }
    return tx.leaveRequest.findUniqueOrThrow({ where: { id: request.id }, include: { leaveType: true } });
  });
}

async function approveLeave(tx: Tx, leaveRequestId: string, actorId: string | null) {
  const req = await tx.leaveRequest.findUniqueOrThrow({ where: { id: leaveRequestId }, include: { leaveType: true } });
  if (req.status !== 'PENDING') return;
  await tx.leaveRequest.update({ where: { id: req.id }, data: { status: 'APPROVED' } });
  if (req.leaveType.accrualMethod !== 'NONE') {
    await changeBalance(tx, req.employeeId, req.leaveType, req.startDate.getUTCFullYear(), { pending: req.days.neg(), used: req.days });
  }
  // Mark the leave on the attendance sheet (working days only, without overwriting real punches).
  const cal = await employeeCalendar(req.employeeId, req.startDate, req.endDate, tx);
  for (const day of cal) {
    if (!day.isWorkingDay && !req.leaveType.countWeekendsAndHolidays) continue;
    const existing = await tx.attendanceRecord.findUnique({ where: { employeeId_date: { employeeId: req.employeeId, date: day.date } } });
    if (existing?.checkIn && !req.halfDay) continue;
    if (existing) {
      if (!req.halfDay) await tx.attendanceRecord.update({ where: { id: existing.id }, data: { status: 'ON_LEAVE', notes: `Leave: ${req.leaveType.name}` } });
    } else {
      await tx.attendanceRecord.create({
        data: { employeeId: req.employeeId, date: day.date, status: req.halfDay ? 'HALF_DAY' : 'ON_LEAVE', source: 'MANUAL', notes: `Leave: ${req.leaveType.name}`, shiftId: day.shift?.id },
      });
    }
  }
  await audit({ userId: actorId, action: 'APPROVE', entity: 'LeaveRequest', entityId: req.id }, tx);
}

async function releaseLeave(tx: Tx, leaveRequestId: string, status: 'REJECTED' | 'CANCELLED') {
  const req = await tx.leaveRequest.findUniqueOrThrow({ where: { id: leaveRequestId }, include: { leaveType: true } });
  if (req.status === 'PENDING') {
    await tx.leaveRequest.update({ where: { id: req.id }, data: { status } });
    if (req.leaveType.accrualMethod !== 'NONE') {
      await changeBalance(tx, req.employeeId, req.leaveType, req.startDate.getUTCFullYear(), { pending: req.days.neg() });
    }
  }
}

registerWorkflowHandler('LEAVE', {
  onApproved: (tx, r, actorId) => approveLeave(tx, r.entityId, actorId),
  onRejected: (tx, r) => releaseLeave(tx, r.entityId, 'REJECTED'),
  onCancelled: (tx, r) => releaseLeave(tx, r.entityId, 'CANCELLED'),
  link: () => '/leave',
});

/**
 * Cancels a leave request. Pending requests are withdrawn from approval. Approved requests can only be
 * cancelled before they start (or by HR at any time); the used days are returned to the balance.
 */
export async function cancelLeave(leaveRequestId: string, actorUserId: string, opts: { isHr: boolean; reason?: string }) {
  return prisma.$transaction(async (tx) => {
    const req = await tx.leaveRequest.findUnique({ where: { id: leaveRequestId }, include: { leaveType: true, employee: { select: { user: { select: { id: true } } } } } });
    if (!req) throw notFound('Leave request');
    if (req.status === 'PENDING') {
      const res = await cancelRequest(tx, 'LEAVE', req.id, actorUserId, { force: opts.isHr, comment: opts.reason });
      if (!res) await releaseLeave(tx, req.id, 'CANCELLED');
    } else if (req.status === 'APPROVED') {
      const today = toDateOnly(new Date());
      if (!opts.isHr && req.startDate <= today) throw unprocessable('Leave that has already started can only be cancelled by HR');
      const locked = await tx.payslip.findFirst({
        where: {
          employeeId: req.employeeId,
          run: { status: { in: ['APPROVED', 'PAID'] }, periodStart: { lte: req.endDate }, periodEnd: { gte: req.startDate } },
        },
      });
      if (locked) throw unprocessable('This leave falls in an approved payroll period. Reopen the payroll first.');
      await tx.leaveRequest.update({ where: { id: req.id }, data: { status: 'CANCELLED' } });
      if (req.leaveType.accrualMethod !== 'NONE') {
        await changeBalance(tx, req.employeeId, req.leaveType, req.startDate.getUTCFullYear(), { used: req.days.neg() });
      }
      await tx.attendanceRecord.deleteMany({ where: { employeeId: req.employeeId, date: { gte: req.startDate, lte: req.endDate }, status: { in: ['ON_LEAVE', 'HALF_DAY'] }, checkIn: null } });
      const ownerUserId = req.employee.user?.id;
      if (ownerUserId && ownerUserId !== actorUserId) {
        await notify([ownerUserId], { type: 'LEAVE', title: `Your ${req.leaveType.name} on ${isoDate(req.startDate)} was cancelled`, body: opts.reason, link: '/leave' }, tx);
      }
    } else {
      throw badRequest(`This request is already ${req.status.toLowerCase()}`);
    }
    await audit({ userId: actorUserId, action: 'CANCEL', entity: 'LeaveRequest', entityId: req.id, after: { reason: opts.reason } }, tx);
    return tx.leaveRequest.findUniqueOrThrow({ where: { id: req.id } });
  });
}

export async function adjustBalance(input: { employeeId: string; leaveTypeId: string; year: number; delta: number; reason: string }, actorUserId: string) {
  return prisma.$transaction(async (tx) => {
    const type = await tx.leaveType.findUniqueOrThrow({ where: { id: input.leaveTypeId } });
    const bal = await changeBalance(tx, input.employeeId, type, input.year, { adjusted: new Prisma.Decimal(input.delta) });
    await audit({ userId: actorUserId, action: 'ADJUST', entity: 'LeaveBalance', entityId: bal.id, after: input }, tx);
    return bal;
  });
}
