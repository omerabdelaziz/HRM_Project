import type { Shift } from '@prisma/client';
import { Db, prisma } from '../../lib/prisma';
import { eachDay, isoDate } from '../../lib/dates';

export interface DayInfo {
  date: Date;
  shift: Shift | null;
  isWeekend: boolean;
  holiday: string | null;
  isWorkingDay: boolean;
}

/**
 * The working calendar of one employee over a date range: which shift applies on each day
 * (rotating assignments override the employee's regular shift, which overrides the company default),
 * and whether the day is a weekend or public holiday.
 */
export async function employeeCalendar(employeeId: string, start: Date, end: Date, db: Db = prisma): Promise<DayInfo[]> {
  const emp = await db.employee.findUniqueOrThrow({
    where: { id: employeeId },
    select: { companyId: true, branchId: true, shift: true, company: { select: { weekendDays: true } } },
  });
  const [assignments, holidays, defaultShift] = await Promise.all([
    db.shiftAssignment.findMany({
      where: { employeeId, startDate: { lte: end }, endDate: { gte: start } },
      include: { shift: true },
      orderBy: { createdAt: 'desc' },
    }),
    db.holiday.findMany({
      where: {
        companyId: emp.companyId,
        date: { gte: start, lte: end },
        OR: emp.branchId ? [{ branchId: null }, { branchId: emp.branchId }] : [{ branchId: null }],
      },
    }),
    emp.shift ? Promise.resolve(null) : db.shift.findFirst({ where: { companyId: emp.companyId, isDefault: true, isActive: true } }),
  ]);
  const holidayByDate = new Map(holidays.map((h) => [isoDate(h.date), h.name]));

  return eachDay(start, end).map((date) => {
    const assigned = assignments.find((a) => a.startDate <= date && a.endDate >= date)?.shift;
    const shift = assigned ?? emp.shift ?? defaultShift;
    const dow = date.getUTCDay();
    const isWeekend = shift ? !shift.workDays.includes(dow) : emp.company.weekendDays.includes(dow);
    const holiday = holidayByDate.get(isoDate(date)) ?? null;
    return { date, shift, isWeekend, holiday, isWorkingDay: !isWeekend && !holiday };
  });
}

export async function countWorkingDays(employeeId: string, start: Date, end: Date, db: Db = prisma) {
  return (await employeeCalendar(employeeId, start, end, db)).filter((d) => d.isWorkingDay).length;
}
