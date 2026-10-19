import { beforeAll, describe, expect, it } from 'vitest';
import { makeCompany, makeEmployee, prisma } from '../helpers';
import { closePendingDays } from '../../src/modules/attendance/service';
import { zonedTimeToUtc } from '../../src/lib/dates';

const TZ = 'Asia/Dubai';
const d = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
const at = (iso: string, hhmm: string) => zonedTimeToUtc(d(iso), hhmm, TZ);

let ctx: Awaited<ReturnType<typeof makeCompany>>;
const people: Record<string, string> = {};

beforeAll(async () => {
  ctx = await makeCompany(); // Mon–Fri 09:00–18:00 default shift, weekend Sat/Sun, Asia/Dubai
  for (const name of ['absent', 'openPunch', 'complete', 'onLeave', 'nightWorker']) {
    people[name] = (await makeEmployee(ctx.company.id, { hireDate: '2026-01-01' })).employee.id;
  }
  const night = await prisma.shift.create({ data: { companyId: ctx.company.id, code: 'NIGHT', name: 'Night', startTime: '22:00', endTime: '06:00', breakMinutes: 30, workDays: [1, 2, 3, 4, 5] } });
  await prisma.employee.update({ where: { id: people.nightWorker }, data: { shiftId: night.id } });

  // The job last ran successfully for Wed 14 Oct; Thu 15 and Fri 16 were never closed.
  await prisma.company.update({ where: { id: ctx.company.id }, data: { attendanceLastClosedDate: d('2026-10-14') } });

  // Thu 15: a check-in with no check-out (like James Carter) and a complete day.
  await prisma.attendanceRecord.create({ data: { employeeId: people.openPunch, date: d('2026-10-15'), checkIn: at('2026-10-15', '09:32'), status: 'LATE', lateMinutes: 32, source: 'WEB' } });
  for (const day of ['2026-10-15', '2026-10-16']) {
    await prisma.attendanceRecord.create({ data: { employeeId: people.complete, date: d(day), checkIn: at(day, '08:58'), checkOut: at(day, '18:05'), status: 'PRESENT', source: 'DEVICE' } });
    await prisma.attendanceRecord.create({ data: { employeeId: people.openPunch, date: d(day), checkIn: at(day, '09:00'), checkOut: at(day, '18:00'), status: 'PRESENT', source: 'DEVICE' } }).catch(() => undefined);
    await prisma.attendanceRecord.create({ data: { employeeId: people.onLeave, date: d(day), checkIn: at(day, '09:00'), checkOut: at(day, '18:00'), status: 'PRESENT', source: 'DEVICE' } }).catch(() => undefined);
  }
  // Fri 16: approved leave, no punches.
  await prisma.attendanceRecord.deleteMany({ where: { employeeId: people.onLeave, date: d('2026-10-16') } });
  await prisma.leaveRequest.create({ data: { employeeId: people.onLeave, leaveTypeId: ctx.annual.id, startDate: d('2026-10-16'), endDate: d('2026-10-16'), days: 1, status: 'APPROVED' } });
  // The night worker checked in Thu 22:00 and out Fri 06:05; on Fri 22:00 checked in and is still working.
  await prisma.attendanceRecord.create({ data: { employeeId: people.nightWorker, date: d('2026-10-15'), checkIn: at('2026-10-15', '22:00'), checkOut: at('2026-10-16', '06:05'), status: 'PRESENT', source: 'DEVICE' } });
  await prisma.attendanceRecord.create({ data: { employeeId: people.nightWorker, date: d('2026-10-16'), checkIn: at('2026-10-16', '22:00'), status: 'PRESENT', source: 'DEVICE' } });
});

const rec = (employeeId: string, day: string) => prisma.attendanceRecord.findUnique({ where: { employeeId_date: { employeeId, date: d(day) } } });

describe('attendance close-day job', () => {
  it('closes every unclosed day since the last successful run, not only yesterday', async () => {
    // Saturday 17 Oct, 07:00 Dubai: the night shift (ends 06:00 + grace) is still open.
    const result = await closePendingDays(ctx.company.id, at('2026-10-17', '07:00'));
    expect(result.days.map((x) => x.date)).toEqual(['2026-10-15', '2026-10-16']);

    for (const day of ['2026-10-15', '2026-10-16']) {
      const a = await rec(people.absent, day);
      expect(a).toMatchObject({ status: 'ABSENT', source: 'SYSTEM' });
    }
    // The open punch is finalised as a missed punch, not left as "Late".
    expect(await rec(people.openPunch, '2026-10-15')).toMatchObject({ status: 'MISSED_PUNCH', checkOut: null });
    expect((await rec(people.complete, '2026-10-15'))!.status).toBe('PRESENT');
    expect(await rec(people.onLeave, '2026-10-16')).toMatchObject({ status: 'ON_LEAVE', source: 'SYSTEM' });
    // The night shift that has not ended yet is deferred, so the day is not marked closed.
    expect((await rec(people.nightWorker, '2026-10-16'))!.status).toBe('PRESENT');
    expect(result.lastClosedDate).toBe('2026-10-15');
    expect(result.days[1].deferred).toBe(1);
  });

  it('finishes the deferred day on a later run and never touches weekends', async () => {
    const result = await closePendingDays(ctx.company.id, at('2026-10-17', '12:00'));
    expect(result.days.map((x) => x.date)).toEqual(['2026-10-16']);
    expect((await rec(people.nightWorker, '2026-10-16'))!.status).toBe('MISSED_PUNCH');
    expect(result.lastClosedDate).toBe('2026-10-16');
    // Saturday and Sunday are weekend days for the default shift: no absences.
    await closePendingDays(ctx.company.id, at('2026-10-19', '12:00'));
    expect(await rec(people.absent, '2026-10-17')).toBeNull();
    expect(await rec(people.absent, '2026-10-18')).toBeNull();
    expect((await prisma.company.findUniqueOrThrow({ where: { id: ctx.company.id } })).attendanceLastClosedDate?.toISOString().slice(0, 10)).toBe('2026-10-18');
  });

  it('is idempotent: running again for the same days changes nothing', async () => {
    const before = await prisma.attendanceRecord.findMany({ where: { employee: { companyId: ctx.company.id } }, orderBy: { id: 'asc' } });
    await prisma.company.update({ where: { id: ctx.company.id }, data: { attendanceLastClosedDate: d('2026-10-14') } });
    const again = await closePendingDays(ctx.company.id, at('2026-10-19', '12:00'));
    expect(again.days.every((x) => x.absent === 0 && x.missed === 0 && x.onLeave === 0)).toBe(true);
    const after = await prisma.attendanceRecord.findMany({ where: { employee: { companyId: ctx.company.id } }, orderBy: { id: 'asc' } });
    expect(after.map((r) => [r.id, r.status, r.source])).toEqual(before.map((r) => [r.id, r.status, r.source]));
  });
});
