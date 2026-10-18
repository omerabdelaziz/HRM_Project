import type { AttendanceStatus, Shift } from '@prisma/client';
import { zonedTimeToUtc, addDays } from '../../lib/dates';

export interface DayComputationInput {
  date: Date; // the attendance date (UTC midnight)
  shift: Pick<Shift, 'startTime' | 'endTime' | 'breakMinutes' | 'graceMinutes' | 'earlyLeaveGraceMinutes' | 'isFlexible' | 'requiredMinutes'> | null;
  timeZone: string;
  checkIn: Date | null;
  checkOut: Date | null;
  isWorkingDay: boolean;
  isHoliday: boolean;
  onLeave?: boolean;
  /** When false (the day is still in progress), a lone check-in is not yet a missed punch. */
  dayClosed?: boolean;
  policy: { minOvertimeMinutes: number; halfDayThresholdMinutes: number };
}

export interface DayComputation {
  workedMinutes: number;
  lateMinutes: number;
  earlyLeaveMinutes: number;
  overtimeMinutes: number;
  status: AttendanceStatus;
}

const minutes = (ms: number) => Math.floor(ms / 60_000);

/** Start/end instants of a shift on a date; overnight shifts end on the next day. */
export function shiftWindow(date: Date, shift: Pick<Shift, 'startTime' | 'endTime'>, timeZone: string) {
  const start = zonedTimeToUtc(date, shift.startTime, timeZone);
  let end = zonedTimeToUtc(date, shift.endTime, timeZone);
  if (end <= start) end = zonedTimeToUtc(addDays(date, 1), shift.endTime, timeZone);
  return { start, end };
}

/** Required worked minutes for a shift (span minus break, or the explicit requirement for flexible shifts). */
export function requiredMinutes(shift: DayComputationInput['shift'], date: Date, timeZone: string) {
  if (!shift) return 8 * 60;
  if (shift.isFlexible && shift.requiredMinutes) return shift.requiredMinutes;
  const { start, end } = shiftWindow(date, shift, timeZone);
  return Math.max(0, minutes(end.getTime() - start.getTime()) - shift.breakMinutes);
}

export function computeDay(input: DayComputationInput): DayComputation {
  const { shift, checkIn, checkOut, isWorkingDay, isHoliday, policy } = input;
  const empty = { workedMinutes: 0, lateMinutes: 0, earlyLeaveMinutes: 0, overtimeMinutes: 0 };

  if (!checkIn && !checkOut) {
    if (input.onLeave) return { ...empty, status: 'ON_LEAVE' };
    if (isHoliday) return { ...empty, status: 'HOLIDAY' };
    if (!isWorkingDay) return { ...empty, status: 'WEEKEND' };
    return { ...empty, status: 'ABSENT' };
  }
  if (checkIn && !checkOut && input.dayClosed === false) {
    let late = 0;
    if (isWorkingDay && shift && !shift.isFlexible) {
      const lateBy = minutes(checkIn.getTime() - shiftWindow(input.date, shift, input.timeZone).start.getTime());
      if (lateBy > shift.graceMinutes) late = lateBy;
    }
    return { ...empty, lateMinutes: late, status: late > 0 ? 'LATE' : 'PRESENT' };
  }
  if (!checkIn || !checkOut || checkOut <= checkIn) {
    return { ...empty, status: 'MISSED_PUNCH' };
  }

  const span = minutes(checkOut.getTime() - checkIn.getTime());
  const breakMin = shift?.breakMinutes ?? 0;
  // The break is only deducted when the employee was present long enough to take it (over 5 hours).
  const worked = Math.max(0, span > 300 ? span - breakMin : span);

  if (!isWorkingDay) {
    const ot = worked >= policy.minOvertimeMinutes ? worked : 0;
    return { workedMinutes: worked, lateMinutes: 0, earlyLeaveMinutes: 0, overtimeMinutes: ot, status: 'PRESENT' };
  }

  const required = requiredMinutes(shift, input.date, input.timeZone);
  let late = 0;
  let early = 0;
  if (shift && !shift.isFlexible) {
    const { start, end } = shiftWindow(input.date, shift, input.timeZone);
    const lateBy = minutes(checkIn.getTime() - start.getTime());
    if (lateBy > shift.graceMinutes) late = lateBy;
    const earlyBy = minutes(end.getTime() - checkOut.getTime());
    if (earlyBy > shift.earlyLeaveGraceMinutes) early = earlyBy;
  } else if (worked < required) {
    // Flexible shifts have no fixed start; a shortfall is reported as early leave.
    early = required - worked;
  }

  const extra = worked - required;
  const overtime = extra >= policy.minOvertimeMinutes ? extra : 0;

  let status: AttendanceStatus = 'PRESENT';
  if (worked < policy.halfDayThresholdMinutes) status = 'HALF_DAY';
  else if (late > 0) status = 'LATE';

  return { workedMinutes: worked, lateMinutes: late, earlyLeaveMinutes: early, overtimeMinutes: overtime, status };
}

/** Great-circle distance in meters (for mobile check-in geofencing). */
export function distanceMeters(lat1: number, lng1: number, lat2: number, lng2: number) {
  const R = 6_371_000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
