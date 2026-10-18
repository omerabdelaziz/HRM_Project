import { Db, prisma } from '../../lib/prisma';
import { unprocessable } from '../../lib/errors';
import { isoDate } from '../../lib/dates';

/**
 * Attendance, leave and salary data feeding an approved or paid payroll period is frozen.
 * Throws if the employee has a payslip in such a run covering the date.
 */
export async function assertPayrollOpen(employeeId: string, date: Date, db: Db = prisma) {
  const locked = await db.payslip.findFirst({
    where: { employeeId, run: { status: { in: ['APPROVED', 'PAID'] }, periodStart: { lte: date }, periodEnd: { gte: date } } },
    select: { run: { select: { year: true, month: true } } },
  });
  if (locked) {
    throw unprocessable(
      `${isoDate(date)} belongs to the ${locked.run.year}-${String(locked.run.month).padStart(2, '0')} payroll, which is approved and locked. Reopen the payroll first.`,
    );
  }
}
