import type { LeaveBalance, LeaveType } from '@prisma/client';
import { Db, prisma, Prisma } from '../../lib/prisma';
import { toDateOnly } from '../../lib/dates';

const D = (v: Prisma.Decimal.Value) => new Prisma.Decimal(v);
const roundHalf = (n: number) => Math.round(n * 2) / 2;

/**
 * Entitlement for a leave type in a year, as of `asOf`.
 * ANNUAL grants the full amount on Jan 1 (pro-rated in the joining year when configured);
 * MONTHLY accrues 1/12 per completed month of service in the year; NONE is not balance-tracked.
 */
export function computeEntitlement(type: LeaveType, hireDate: Date, year: number, asOf: Date = new Date()): number {
  const annual = Number(type.annualEntitlement);
  if (type.accrualMethod === 'NONE' || annual <= 0) return 0;
  const yearStart = new Date(Date.UTC(year, 0, 1));
  const yearEnd = new Date(Date.UTC(year, 11, 31));
  if (hireDate > yearEnd) return 0;
  const from = hireDate > yearStart ? hireDate : yearStart;

  if (type.accrualMethod === 'MONTHLY') {
    // One twelfth is credited at the end of each completed month of service.
    // The joining month counts when the employee joined on or before the 15th.
    const until = toDateOnly(asOf < yearEnd ? asOf : yearEnd);
    let months = 0;
    for (let m = 0; m < 12; m++) {
      const mStart = new Date(Date.UTC(year, m, 1));
      const mEnd = new Date(Date.UTC(year, m + 1, 0));
      if (mEnd > until) break;
      if (mEnd < from) continue;
      if (from > mStart && from.getUTCDate() > 15) continue;
      months++;
    }
    return roundHalf((annual / 12) * months);
  }

  if (type.prorateFirstYear && hireDate > yearStart) {
    const remainingDays = (yearEnd.getTime() - from.getTime()) / 86_400_000 + 1;
    const daysInYear = (yearEnd.getTime() - yearStart.getTime()) / 86_400_000 + 1;
    return roundHalf((annual * remainingDays) / daysInYear);
  }
  return annual;
}

export function available(b: Pick<LeaveBalance, 'entitled' | 'carriedOver' | 'adjusted' | 'used' | 'pending'>) {
  return D(b.entitled).plus(b.carriedOver).plus(b.adjusted).minus(b.used).minus(b.pending);
}

/**
 * Returns the balance row for (employee, type, year), creating it if needed with carry-forward
 * from the previous year, and refreshing the accrued entitlement.
 */
export async function ensureBalance(db: Db, employeeId: string, leaveType: LeaveType, year: number, asOf = new Date()) {
  const emp = await db.employee.findUniqueOrThrow({ where: { id: employeeId }, select: { hireDate: true } });
  const entitled = computeEntitlement(leaveType, emp.hireDate, year, asOf);
  const existing = await db.leaveBalance.findUnique({
    where: { employeeId_leaveTypeId_year: { employeeId, leaveTypeId: leaveType.id, year } },
  });
  if (existing) {
    if (Number(existing.entitled) !== entitled) {
      return db.leaveBalance.update({ where: { id: existing.id }, data: { entitled } });
    }
    return existing;
  }
  let carriedOver = D(0);
  const maxCarry = D(leaveType.maxCarryForward);
  if (maxCarry.gt(0)) {
    const prev = await db.leaveBalance.findUnique({
      where: { employeeId_leaveTypeId_year: { employeeId, leaveTypeId: leaveType.id, year: year - 1 } },
    });
    if (prev) {
      const left = available(prev);
      carriedOver = left.gt(0) ? Prisma.Decimal.min(left, maxCarry) : D(0);
    }
  }
  return db.leaveBalance.upsert({
    where: { employeeId_leaveTypeId_year: { employeeId, leaveTypeId: leaveType.id, year } },
    create: { employeeId, leaveTypeId: leaveType.id, year, entitled, carriedOver },
    update: {},
  });
}

/** Creates/refreshes balances for every active leave type of the employee's company. */
export async function ensureAllBalances(db: Db, employeeId: string, year = new Date().getUTCFullYear()) {
  const emp = await db.employee.findUniqueOrThrow({ where: { id: employeeId }, select: { companyId: true, gender: true } });
  const types = await db.leaveType.findMany({ where: { companyId: emp.companyId, isActive: true } });
  const out = [];
  for (const t of types) {
    if (t.genderRestriction && emp.gender && t.genderRestriction !== emp.gender) continue;
    out.push(await ensureBalance(db, employeeId, t, year));
  }
  return out;
}

export async function changeBalance(
  db: Db,
  employeeId: string,
  leaveType: LeaveType,
  year: number,
  delta: { used?: Prisma.Decimal.Value; pending?: Prisma.Decimal.Value; adjusted?: Prisma.Decimal.Value },
) {
  const bal = await ensureBalance(db, employeeId, leaveType, year);
  return db.leaveBalance.update({
    where: { id: bal.id },
    data: {
      used: delta.used !== undefined ? { increment: delta.used } : undefined,
      pending: delta.pending !== undefined ? { increment: delta.pending } : undefined,
      adjusted: delta.adjusted !== undefined ? { increment: delta.adjusted } : undefined,
    },
  });
}

export { toDateOnly };
