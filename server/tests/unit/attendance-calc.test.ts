import { describe, expect, it } from 'vitest';
import { computeDay, distanceMeters, shiftWindow } from '../../src/modules/attendance/calc';
import { toDateOnly, zonedTimeToUtc } from '../../src/lib/dates';

const TZ = 'Asia/Dubai'; // UTC+4, no DST
const date = toDateOnly('2026-03-02'); // Monday
const at = (hhmm: string, d = date) => zonedTimeToUtc(d, hhmm, TZ);
const shift = { startTime: '09:00', endTime: '18:00', breakMinutes: 60, graceMinutes: 10, earlyLeaveGraceMinutes: 5, isFlexible: false, requiredMinutes: null };
const policy = { minOvertimeMinutes: 30, halfDayThresholdMinutes: 240 };
const base = { date, shift, timeZone: TZ, isWorkingDay: true, isHoliday: false, policy };

describe('attendance day computation', () => {
  it('converts local shift times to UTC', () => {
    expect(at('09:00').toISOString()).toBe('2026-03-02T05:00:00.000Z');
  });

  it('on-time full day is PRESENT with 8 worked hours', () => {
    const r = computeDay({ ...base, checkIn: at('08:55'), checkOut: at('18:02') });
    expect(r).toMatchObject({ status: 'PRESENT', lateMinutes: 0, earlyLeaveMinutes: 0, overtimeMinutes: 0 });
    expect(r.workedMinutes).toBe(9 * 60 + 7 - 60);
  });

  it('arrival within grace is not late; beyond grace counts the full minutes late', () => {
    expect(computeDay({ ...base, checkIn: at('09:10'), checkOut: at('18:00') }).lateMinutes).toBe(0);
    const late = computeDay({ ...base, checkIn: at('09:25'), checkOut: at('18:00') });
    expect(late.lateMinutes).toBe(25);
    expect(late.status).toBe('LATE');
  });

  it('detects early departure beyond its grace', () => {
    expect(computeDay({ ...base, checkIn: at('09:00'), checkOut: at('17:56') }).earlyLeaveMinutes).toBe(0);
    expect(computeDay({ ...base, checkIn: at('09:00'), checkOut: at('17:30') }).earlyLeaveMinutes).toBe(30);
  });

  it('counts overtime only above the minimum threshold', () => {
    expect(computeDay({ ...base, checkIn: at('09:00'), checkOut: at('18:20') }).overtimeMinutes).toBe(0);
    expect(computeDay({ ...base, checkIn: at('09:00'), checkOut: at('19:30') }).overtimeMinutes).toBe(90);
  });

  it('all work on a weekend or holiday is overtime', () => {
    const r = computeDay({ ...base, isWorkingDay: false, checkIn: at('10:00'), checkOut: at('14:00') });
    expect(r).toMatchObject({ status: 'PRESENT', overtimeMinutes: 240, lateMinutes: 0 });
  });

  it('short days are HALF_DAY; no punches is ABSENT; single punch on a closed day is MISSED_PUNCH', () => {
    expect(computeDay({ ...base, checkIn: at('09:00'), checkOut: at('12:00') }).status).toBe('HALF_DAY');
    expect(computeDay({ ...base, checkIn: null, checkOut: null }).status).toBe('ABSENT');
    expect(computeDay({ ...base, checkIn: at('09:00'), checkOut: null }).status).toBe('MISSED_PUNCH');
  });

  it('a lone check-in while the day is still open is PRESENT (or LATE), not missed', () => {
    expect(computeDay({ ...base, checkIn: at('09:00'), checkOut: null, dayClosed: false }).status).toBe('PRESENT');
    expect(computeDay({ ...base, checkIn: at('09:40'), checkOut: null, dayClosed: false })).toMatchObject({ status: 'LATE', lateMinutes: 40 });
  });

  it('no punches on weekends/holidays/leave', () => {
    expect(computeDay({ ...base, isWorkingDay: false, checkIn: null, checkOut: null }).status).toBe('WEEKEND');
    expect(computeDay({ ...base, isWorkingDay: false, isHoliday: true, checkIn: null, checkOut: null }).status).toBe('HOLIDAY');
    expect(computeDay({ ...base, onLeave: true, checkIn: null, checkOut: null }).status).toBe('ON_LEAVE');
  });

  it('handles overnight shifts ending the next morning', () => {
    const night = { ...shift, startTime: '22:00', endTime: '06:00', breakMinutes: 30 };
    const w = shiftWindow(date, night, TZ);
    expect(w.end.getTime() - w.start.getTime()).toBe(8 * 3_600_000);
    const next = toDateOnly('2026-03-03');
    const r = computeDay({ ...base, shift: night, checkIn: at('22:05'), checkOut: at('06:10', next) });
    expect(r).toMatchObject({ status: 'PRESENT', lateMinutes: 0 });
    expect(r.workedMinutes).toBe(8 * 60 + 5 - 30);
  });

  it('flexible shifts have no lateness; shortfall is reported as early leave', () => {
    const flex = { ...shift, isFlexible: true, requiredMinutes: 480 };
    const r = computeDay({ ...base, shift: flex, checkIn: at('11:00'), checkOut: at('19:00') });
    expect(r.lateMinutes).toBe(0);
    expect(r.earlyLeaveMinutes).toBe(60); // 8h span − 1h break = 7h worked, 1h short
  });

  it('geofence distance', () => {
    expect(Math.round(distanceMeters(25.2048, 55.2708, 25.2048, 55.2708))).toBe(0);
    const d = distanceMeters(25.2048, 55.2708, 25.2148, 55.2708); // ~0.01° latitude
    expect(d).toBeGreaterThan(1100);
    expect(d).toBeLessThan(1120);
  });
});
