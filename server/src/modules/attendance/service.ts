import { Db, prisma, Tx } from '../../lib/prisma';
import { badRequest, notFound, unprocessable } from '../../lib/errors';
import { addDays, isoDate, localDateOf, toDateOnly, zonedTimeToUtc } from '../../lib/dates';
import { audit } from '../../lib/audit';
import { employeeCalendar } from './calendar';
import { computeDay, distanceMeters, shiftWindow } from './calc';
import { assertPayrollOpen } from '../payroll/locks';
import { registerWorkflowHandler, submitForApproval } from '../workflow/engine';

async function employeeContext(db: Db, employeeId: string) {
  const emp = await db.employee.findUnique({
    where: { id: employeeId },
    select: {
      id: true, companyId: true, firstName: true, lastName: true, status: true, deletedAt: true, departmentId: true, branchId: true,
      branch: { select: { timezone: true } },
      overtimeEligible: true,
      grade: { select: { overtimeEligible: true } },
      company: { select: { timezone: true, attendancePolicy: true, payrollSettings: { select: { nightOvertimeStart: true, nightOvertimeEnd: true } } } },
    },
  });
  if (!emp || emp.deletedAt) throw notFound('Employee');
  const policy = emp.company.attendancePolicy ?? { minOvertimeMinutes: 30, halfDayThresholdMinutes: 240, allowMobileCheckIn: true, allowWebCheckIn: true, geofenceLat: null, geofenceLng: null, geofenceRadiusMeters: null, overtimeRequiresApproval: true };
  const ps = emp.company.payrollSettings;
  const nightWindow = { start: ps?.nightOvertimeStart ?? '22:00', end: ps?.nightOvertimeEnd ?? '04:00' };
  return { emp, timeZone: emp.branch?.timezone || emp.company.timezone, policy, nightWindow, overtimeEligible: isOvertimeEligible(emp) };
}

/** Employee override, else the job grade's setting, else eligible. */
export function isOvertimeEligible(emp: { overtimeEligible: boolean | null; grade?: { overtimeEligible: boolean } | null }) {
  return emp.overtimeEligible ?? emp.grade?.overtimeEligible ?? true;
}

/** Recomputes derived fields (worked/late/early/overtime/status) of one day's record. */
export async function recalculateRecord(db: Db, employeeId: string, date: Date, now = new Date()) {
  const { timeZone, policy, nightWindow } = await employeeContext(db, employeeId);
  const record = await db.attendanceRecord.findUnique({ where: { employeeId_date: { employeeId, date } } });
  if (!record) return null;
  const [day] = await employeeCalendar(employeeId, date, date, db);
  if (record.status === 'ON_LEAVE' && !record.checkIn) return record;
  const result = computeDay({
    date,
    shift: day.shift,
    timeZone,
    checkIn: record.checkIn,
    checkOut: record.checkOut,
    isWorkingDay: day.isWorkingDay,
    isHoliday: !!day.holiday,
    policy,
    nightWindow,
    // A lone check-in stays "in progress" until the employee's own shift has ended (plus a grace period).
    dayClosed: now >= dayClosesAt(date, day.shift, timeZone),
  });
  const approvedOt = await approvedOvertimeFor(db, employeeId, date);
  return db.attendanceRecord.update({
    where: { id: record.id },
    data: {
      ...result,
      shiftId: day.shift?.id ?? null,
      approvedOvertimeMinutes: policy.overtimeRequiresApproval ? Math.min(approvedOt, result.overtimeMinutes) : result.overtimeMinutes,
    },
  });
}

async function approvedOvertimeFor(db: Db, employeeId: string, date: Date) {
  const rows = await db.overtimeRequest.findMany({ where: { employeeId, date, status: 'APPROVED' }, select: { minutes: true } });
  return rows.reduce((s, r) => s + r.minutes, 0);
}

export interface PunchInput {
  employeeId: string;
  at?: Date;
  source: 'WEB' | 'MOBILE' | 'DEVICE';
  lat?: number;
  lng?: number;
}

/**
 * Records a check-in or check-out. The first punch of the day is the check-in and the latest later
 * punch is the check-out. A punch shortly after midnight closes an open overnight record from the previous day.
 */
export async function punch(input: PunchInput) {
  const at = input.at ?? new Date();
  return prisma.$transaction(async (tx) => {
    const { emp, timeZone, policy } = await employeeContext(tx, input.employeeId);
    if (!['ACTIVE', 'PROBATION'].includes(emp.status)) throw unprocessable('Only active employees can check in');
    if (input.source === 'WEB' && !policy.allowWebCheckIn) throw unprocessable('Web check-in is disabled by policy');
    if (input.source === 'MOBILE') {
      if (!policy.allowMobileCheckIn) throw unprocessable('Mobile check-in is disabled by policy');
      if (policy.geofenceLat != null && policy.geofenceLng != null && policy.geofenceRadiusMeters) {
        if (input.lat == null || input.lng == null) throw badRequest('Location is required for mobile check-in');
        const dist = distanceMeters(input.lat, input.lng, policy.geofenceLat, policy.geofenceLng);
        if (dist > policy.geofenceRadiusMeters) throw unprocessable(`You are ${Math.round(dist)} m from the permitted location`);
      }
    }

    const today = localDateOf(at, timeZone);
    const yesterday = addDays(today, -1);
    const open = await tx.attendanceRecord.findUnique({ where: { employeeId_date: { employeeId: emp.id, date: yesterday } } });
    let date = today;
    if (open?.checkIn && !open.checkOut && at.getTime() - open.checkIn.getTime() < 16 * 3_600_000) {
      const [yDay] = await employeeCalendar(emp.id, yesterday, yesterday, tx);
      const overnight = yDay.shift && yDay.shift.endTime <= yDay.shift.startTime;
      if (overnight) date = yesterday;
    }
    await assertPayrollOpen(emp.id, date, tx);

    const existing = await tx.attendanceRecord.findUnique({ where: { employeeId_date: { employeeId: emp.id, date } } });
    let action: 'CHECK_IN' | 'CHECK_OUT';
    if (!existing || !existing.checkIn) {
      action = 'CHECK_IN';
      await tx.attendanceRecord.upsert({
        where: { employeeId_date: { employeeId: emp.id, date } },
        create: { employeeId: emp.id, date, checkIn: at, source: input.source, checkInLat: input.lat, checkInLng: input.lng },
        update: { checkIn: at, source: input.source, checkInLat: input.lat, checkInLng: input.lng },
      });
    } else {
      if (at.getTime() - existing.checkIn.getTime() < 60_000) throw unprocessable('You have just checked in');
      action = 'CHECK_OUT';
      if (!existing.checkOut || at > existing.checkOut) {
        await tx.attendanceRecord.update({ where: { id: existing.id }, data: { checkOut: at } });
      }
    }
    const record = await recalculateRecord(tx, emp.id, date);
    return { action, record };
  });
}

export async function upsertManualRecord(
  input: { employeeId: string; date: string; checkIn?: string | null; checkOut?: string | null; notes?: string | null },
  actorUserId: string,
) {
  const date = toDateOnly(input.date);
  return prisma.$transaction(async (tx) => {
    await assertPayrollOpen(input.employeeId, date, tx);
    const before = await tx.attendanceRecord.findUnique({ where: { employeeId_date: { employeeId: input.employeeId, date } } });
    const checkIn = input.checkIn ? new Date(input.checkIn) : null;
    const checkOut = input.checkOut ? new Date(input.checkOut) : null;
    if (checkIn && checkOut && checkOut <= checkIn) throw badRequest('Check-out must be after check-in');
    await tx.attendanceRecord.upsert({
      where: { employeeId_date: { employeeId: input.employeeId, date } },
      create: { employeeId: input.employeeId, date, checkIn, checkOut, notes: input.notes, source: 'MANUAL' },
      update: { checkIn, checkOut, notes: input.notes, source: 'MANUAL' },
    });
    const after = await recalculateRecord(tx, input.employeeId, date);
    await audit({ userId: actorUserId, action: before ? 'UPDATE' : 'CREATE', entity: 'AttendanceRecord', entityId: after?.id, before, after }, tx);
    return after;
  });
}

// ── Corrections ──

export async function requestCorrection(
  input: { employeeId: string; date: string; checkIn?: string | null; checkOut?: string | null; reason: string },
  requesterUserId: string,
) {
  const date = toDateOnly(input.date);
  if (date > toDateOnly(new Date())) throw badRequest('Corrections can only be requested for past dates');
  if (!input.checkIn && !input.checkOut) throw badRequest('Provide a corrected check-in and/or check-out time');
  return prisma.$transaction(async (tx) => {
    const { emp } = await employeeContext(tx, input.employeeId);
    await assertPayrollOpen(emp.id, date, tx);
    const pending = await tx.attendanceCorrection.findFirst({ where: { employeeId: emp.id, date, status: 'PENDING' } });
    if (pending) throw unprocessable('A correction for this date is already pending');
    const correction = await tx.attendanceCorrection.create({
      data: {
        employeeId: emp.id,
        date,
        requestedCheckIn: input.checkIn ? new Date(input.checkIn) : null,
        requestedCheckOut: input.checkOut ? new Date(input.checkOut) : null,
        reason: input.reason,
      },
    });
    const current = await tx.attendanceRecord.findUnique({ where: { employeeId_date: { employeeId: emp.id, date } } });
    await submitForApproval(tx, {
      companyId: emp.companyId,
      requestType: 'ATTENDANCE_CORRECTION',
      entityId: correction.id,
      requesterId: requesterUserId,
      employeeId: emp.id,
      title: `Attendance correction: ${emp.firstName} ${emp.lastName}, ${isoDate(date)}`,
      summary: {
        date: isoDate(date),
        currentCheckIn: current?.checkIn, currentCheckOut: current?.checkOut,
        requestedCheckIn: correction.requestedCheckIn, requestedCheckOut: correction.requestedCheckOut,
        reason: input.reason,
      },
      context: { departmentId: emp.departmentId, branchId: emp.branchId },
    });
    return tx.attendanceCorrection.findUniqueOrThrow({ where: { id: correction.id } });
  });
}

registerWorkflowHandler('ATTENDANCE_CORRECTION', {
  async onApproved(tx: Tx, r, actorId) {
    const c = await tx.attendanceCorrection.findUniqueOrThrow({ where: { id: r.entityId } });
    await tx.attendanceCorrection.update({ where: { id: c.id }, data: { status: 'APPROVED' } });
    await assertPayrollOpen(c.employeeId, c.date, tx);
    const existing = await tx.attendanceRecord.findUnique({ where: { employeeId_date: { employeeId: c.employeeId, date: c.date } } });
    await tx.attendanceRecord.upsert({
      where: { employeeId_date: { employeeId: c.employeeId, date: c.date } },
      create: { employeeId: c.employeeId, date: c.date, checkIn: c.requestedCheckIn, checkOut: c.requestedCheckOut, source: 'CORRECTION', notes: `Corrected: ${c.reason}` },
      update: {
        checkIn: c.requestedCheckIn ?? existing?.checkIn,
        checkOut: c.requestedCheckOut ?? existing?.checkOut,
        source: 'CORRECTION',
        notes: `Corrected: ${c.reason}`,
      },
    });
    const after = await recalculateRecord(tx, c.employeeId, c.date);
    await audit({ userId: actorId, action: 'CORRECTION_APPLIED', entity: 'AttendanceRecord', entityId: after?.id, before: existing, after }, tx);
  },
  async onRejected(tx, r) {
    await tx.attendanceCorrection.update({ where: { id: r.entityId }, data: { status: 'REJECTED' } });
  },
  async onCancelled(tx, r) {
    await tx.attendanceCorrection.update({ where: { id: r.entityId }, data: { status: 'CANCELLED' } });
  },
  link: () => '/attendance',
});

// ── Overtime ──

export async function requestOvertime(input: { employeeId: string; date: string; minutes: number; reason: string }, requesterUserId: string) {
  const date = toDateOnly(input.date);
  return prisma.$transaction(async (tx) => {
    const { emp, overtimeEligible } = await employeeContext(tx, input.employeeId);
    if (!overtimeEligible) throw unprocessable(`${emp.firstName} ${emp.lastName} is not eligible for overtime (managerial grade). Overtime cannot be requested.`, { code: 'OVERTIME_NOT_ELIGIBLE' });
    await assertPayrollOpen(emp.id, date, tx);
    const ot = await tx.overtimeRequest.create({ data: { employeeId: emp.id, date, minutes: input.minutes, reason: input.reason } });
    await submitForApproval(tx, {
      companyId: emp.companyId,
      requestType: 'OVERTIME',
      entityId: ot.id,
      requesterId: requesterUserId,
      employeeId: emp.id,
      title: `Overtime: ${emp.firstName} ${emp.lastName}, ${isoDate(date)} (${(input.minutes / 60).toFixed(1)} h)`,
      summary: { date: isoDate(date), minutes: input.minutes, reason: input.reason },
      amount: input.minutes / 60,
      context: { departmentId: emp.departmentId, branchId: emp.branchId },
    });
    return tx.overtimeRequest.findUniqueOrThrow({ where: { id: ot.id } });
  });
}

registerWorkflowHandler('OVERTIME', {
  async onApproved(tx, r) {
    const ot = await tx.overtimeRequest.update({ where: { id: r.entityId }, data: { status: 'APPROVED' } });
    await recalculateRecord(tx, ot.employeeId, ot.date);
  },
  async onRejected(tx, r) {
    await tx.overtimeRequest.update({ where: { id: r.entityId }, data: { status: 'REJECTED' } });
  },
  async onCancelled(tx, r) {
    await tx.overtimeRequest.update({ where: { id: r.entityId }, data: { status: 'CANCELLED' } });
  },
  link: () => '/attendance',
});

// ── Daily processing ──

/** A check-in without a check-out becomes a missed punch this long after the shift ends (time for late check-outs / overtime). */
export const MISSED_PUNCH_GRACE_HOURS = 4;
/** On the first run (no lastClosedDate yet) the job looks back this many days; it never back-fills more than MAX_CATCH_UP_DAYS. */
const FIRST_RUN_LOOKBACK_DAYS = 14;
const MAX_CATCH_UP_DAYS = 62;

/** The instant after which a day's attendance can be finalised for a shift (overnight shifts end the next morning). */
export function dayClosesAt(date: Date, shift: { startTime: string; endTime: string } | null, timeZone: string) {
  const end = shift ? shiftWindow(date, shift, timeZone).end : zonedTimeToUtc(addDays(date, 1), '00:00', timeZone);
  return new Date(end.getTime() + MISSED_PUNCH_GRACE_HOURS * 3_600_000);
}

/**
 * Closes one day for one company: a working day with no punches, no leave and no holiday becomes ABSENT;
 * a check-in without a check-out becomes MISSED_PUNCH once the employee's own shift has ended.
 * Each employee's shift and weekend pattern is respected. Idempotent: running it again changes nothing.
 * Employees whose shift has not ended yet are reported as `deferred` and handled by a later run.
 */
export async function processDay(companyId: string, dateInput: Date | string, now = new Date()) {
  const date = toDateOnly(dateInput);
  const employees = await prisma.employee.findMany({
    where: {
      companyId,
      deletedAt: null,
      hireDate: { lte: date },
      OR: [{ status: { in: ['ACTIVE', 'PROBATION'] }, separationDate: null }, { separationDate: { gte: date } }],
    },
    select: { id: true },
  });
  let absent = 0;
  let onLeave = 0;
  let missed = 0;
  let deferred = 0;
  for (const e of employees) {
    const [{ timeZone }, [day]] = await Promise.all([employeeContext(prisma, e.id), employeeCalendar(e.id, date, date)]);
    const record = await prisma.attendanceRecord.findUnique({ where: { employeeId_date: { employeeId: e.id, date } } });
    if (record && (record.checkOut || !record.checkIn)) continue; // complete, or already an absence/leave/holiday record
    if (now < dayClosesAt(date, day.shift, timeZone)) {
      deferred++;
      continue;
    }
    if (!record) {
      if (!day.isWorkingDay) continue;
      const leave = await prisma.leaveRequest.findFirst({ where: { employeeId: e.id, status: 'APPROVED', startDate: { lte: date }, endDate: { gte: date } }, include: { leaveType: true } });
      await prisma.attendanceRecord.create({
        data: {
          employeeId: e.id, date, source: 'SYSTEM', shiftId: day.shift?.id,
          status: leave ? (leave.halfDay ? 'HALF_DAY' : 'ON_LEAVE') : 'ABSENT',
          notes: leave ? `Leave: ${leave.leaveType.name}` : 'No punches recorded',
        },
      });
      if (leave) onLeave++;
      else absent++;
    } else if (record.status !== 'MISSED_PUNCH') {
      // Open punch whose shift is over: finalise it.
      await recalculateRecord(prisma, e.id, date, now);
      missed++;
    }
  }
  return { date: isoDate(date), employees: employees.length, absent, onLeave, missed, deferred };
}

/**
 * Closes every unclosed day of a company from the day after `attendanceLastClosedDate` up to yesterday
 * (company time zone), so a missed run never leaves a day open. `attendanceLastClosedDate` only advances
 * over days where no employee was deferred (overnight shifts still in progress).
 */
export async function closePendingDays(companyId: string, now = new Date()) {
  const company = await prisma.company.findUniqueOrThrow({ where: { id: companyId }, select: { timezone: true, attendanceLastClosedDate: true, createdAt: true } });
  const yesterday = addDays(localDateOf(now, company.timezone), -1);
  let from = company.attendanceLastClosedDate ? addDays(company.attendanceLastClosedDate, 1) : addDays(yesterday, -(FIRST_RUN_LOOKBACK_DAYS - 1));
  const floor = addDays(yesterday, -(MAX_CATCH_UP_DAYS - 1));
  if (from < floor) from = floor;
  const days = [];
  let lastClosed = company.attendanceLastClosedDate;
  let contiguous = true;
  for (let d = from; d <= yesterday; d = addDays(d, 1)) {
    const result = await processDay(companyId, d, now);
    days.push(result);
    if (contiguous && result.deferred === 0) lastClosed = d;
    else contiguous = false;
  }
  if (lastClosed && (!company.attendanceLastClosedDate || lastClosed > company.attendanceLastClosedDate)) {
    await prisma.company.update({ where: { id: companyId }, data: { attendanceLastClosedDate: lastClosed } });
  }
  return { companyId, from: isoDate(from), to: isoDate(yesterday), lastClosedDate: lastClosed ? isoDate(lastClosed) : null, days };
}
