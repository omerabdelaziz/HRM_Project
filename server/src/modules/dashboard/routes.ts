import { z } from 'zod';
import { createRouter, dateString } from '../../lib/http';
import { prisma, Prisma } from '../../lib/prisma';
import { employeeScope, resolveCompanyId } from '../../auth/scope';
import { hasPermission } from '../../auth/context';
import { addDays, isoDate, localDateOf, toDateOnly } from '../../lib/dates';

const r = createRouter('/api/dashboard', 'Dashboard');
export default r;

const ACTIVE: Prisma.EnumEmployeeStatusFilter = { in: ['ACTIVE', 'PROBATION', 'SUSPENDED'] };

export const dashboardFilters = z.object({
  companyId: z.string().uuid().optional(),
  branchId: z.string().uuid().optional(),
  departmentId: z.string().uuid().optional(),
  managerId: z.string().uuid().optional(),
  status: z.enum(['PROBATION', 'ACTIVE', 'SUSPENDED', 'RESIGNED', 'TERMINATED', 'RETIRED']).optional(),
  from: dateString.optional(),
  to: dateString.optional(),
});

r.get('/', { summary: 'Executive HR dashboard: KPIs and chart data for the selected filters', permission: 'dashboard.read', query: dashboardFilters }, async ({ user, query }) => {
  const companyId = await resolveCompanyId(user, query.companyId);
  const company = await prisma.company.findUniqueOrThrow({ where: { id: companyId }, select: { timezone: true, baseCurrency: true } });
  const today = localDateOf(new Date(), company.timezone);
  const to = query.to ? toDateOnly(query.to) : today;
  const from = query.from ? toDateOnly(query.from) : new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), 1));

  const scope = await employeeScope(user);
  const base: Prisma.EmployeeWhereInput = {
    AND: [
      scope,
      { companyId, deletedAt: null },
      query.branchId ? { branchId: query.branchId } : {},
      query.departmentId ? { departmentId: query.departmentId } : {},
      query.managerId ? { managerId: query.managerId } : {},
    ],
  };
  const current: Prisma.EmployeeWhereInput = { AND: [base, query.status ? { status: query.status } : { status: ACTIVE }] };

  const [total, active, probation, byStatus, hires, separations, startHeadcount] = await Promise.all([
    prisma.employee.count({ where: base }),
    prisma.employee.count({ where: { AND: [base, { status: 'ACTIVE' }] } }),
    prisma.employee.count({ where: { AND: [base, { status: 'PROBATION' }] } }),
    prisma.employee.groupBy({ by: ['status'], where: base, _count: { _all: true } }),
    prisma.employee.count({ where: { AND: [base, { hireDate: { gte: from, lte: to } }] } }),
    prisma.employee.count({ where: { AND: [base, { separationDate: { gte: from, lte: to } }] } }),
    prisma.employee.count({ where: { AND: [base, { hireDate: { lt: from } }, { OR: [{ separationDate: null }, { separationDate: { gte: from } }] }] } }),
  ]);
  const headcountNow = await prisma.employee.count({ where: current });
  const avgHeadcount = (startHeadcount + headcountNow) / 2 || 1;

  // Today's attendance.
  const todayRecords = await prisma.attendanceRecord.groupBy({ by: ['status'], where: { date: today, employee: current }, _count: { _all: true } });
  const t = Object.fromEntries(todayRecords.map((x) => [x.status, x._count._all])) as Record<string, number>;
  const onLeaveToday = await prisma.leaveRequest.count({ where: { status: 'APPROVED', startDate: { lte: today }, endDate: { gte: today }, employee: current } });
  const present = (t.PRESENT ?? 0) + (t.LATE ?? 0) + (t.HALF_DAY ?? 0) + (t.MISSED_PUNCH ?? 0);

  // Period attendance aggregates.
  const periodAgg = await prisma.attendanceRecord.aggregate({
    where: { date: { gte: from, lte: to }, employee: current },
    _sum: { lateMinutes: true, overtimeMinutes: true, approvedOvertimeMinutes: true, workedMinutes: true },
  });
  const [lateCount, absentCount, scheduledCount] = await Promise.all([
    prisma.attendanceRecord.count({ where: { date: { gte: from, lte: to }, employee: current, lateMinutes: { gt: 0 } } }),
    prisma.attendanceRecord.count({ where: { date: { gte: from, lte: to }, employee: current, status: 'ABSENT' } }),
    prisma.attendanceRecord.count({ where: { date: { gte: from, lte: to }, employee: current, status: { notIn: ['WEEKEND', 'HOLIDAY'] } } }),
  ]);

  // Headcount breakdowns.
  const [byDept, byBranch, byPosition, byGender] = await Promise.all([
    prisma.employee.groupBy({ by: ['departmentId'], where: current, _count: { _all: true } }),
    prisma.employee.groupBy({ by: ['branchId'], where: current, _count: { _all: true } }),
    prisma.employee.groupBy({ by: ['positionId'], where: current, _count: { _all: true }, orderBy: { _count: { positionId: 'desc' } }, take: 10 }),
    prisma.employee.groupBy({ by: ['gender'], where: current, _count: { _all: true } }),
  ]);
  const [depts, branches, positions] = await Promise.all([
    prisma.department.findMany({ where: { id: { in: byDept.map((d) => d.departmentId).filter(Boolean) as string[] } }, select: { id: true, name: true, nameAr: true } }),
    prisma.branch.findMany({ where: { id: { in: byBranch.map((d) => d.branchId).filter(Boolean) as string[] } }, select: { id: true, name: true, nameAr: true } }),
    prisma.position.findMany({ where: { id: { in: byPosition.map((d) => d.positionId).filter(Boolean) as string[] } }, select: { id: true, title: true, titleAr: true } }),
  ]);
  const label = <T extends { id: string }>(list: T[], id: string | null, f: (x: T) => { name: string; nameAr?: string | null }) => {
    const hit = id ? list.find((x) => x.id === id) : undefined;
    return hit ? f(hit) : { name: 'Unassigned', nameAr: 'غير محدد' };
  };

  // Headcount trend over the last 12 months (end-of-month).
  const trendPoints: { month: string; headcount: number; hires: number; separations: number }[] = [];
  for (let i = 11; i >= 0; i--) {
    const mStart = new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth() - i, 1));
    const mEnd = new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth() - i + 1, 0));
    const [hc, h, s] = await Promise.all([
      prisma.employee.count({ where: { AND: [base, { hireDate: { lte: mEnd } }, { OR: [{ separationDate: null }, { separationDate: { gt: mEnd } }] }] } }),
      prisma.employee.count({ where: { AND: [base, { hireDate: { gte: mStart, lte: mEnd } }] } }),
      prisma.employee.count({ where: { AND: [base, { separationDate: { gte: mStart, lte: mEnd } }] } }),
    ]);
    trendPoints.push({ month: isoDate(mStart).slice(0, 7), headcount: hc, hires: h, separations: s });
  }

  // Payroll (only for users who may see pay data).
  let payroll: unknown = null;
  if (hasPermission(user, 'payroll.read', 'employee.salary.read')) {
    const runs = await prisma.payrollRun.findMany({
      where: { companyId, status: { in: ['APPROVED', 'PAID'] }, ...(query.branchId ? { OR: [{ branchId: query.branchId }, { branchId: null }] } : {}) },
      orderBy: [{ year: 'desc' }, { month: 'desc' }],
      take: 12,
      select: { id: true, year: true, month: true, totalGross: true, totalNet: true, totalEmployerCost: true, employeeCount: true, currency: true },
    });
    const latest = runs[0];
    let byDepartment: { name: string; cost: number }[] = [];
    if (latest) {
      const slips = await prisma.payslip.findMany({ where: { runId: latest.id, employee: current }, select: { employerCost: true, snapshot: true } });
      const m = new Map<string, number>();
      for (const s of slips) {
        const name = ((s.snapshot as Record<string, string | null>).department ?? 'Unassigned') as string;
        m.set(name, (m.get(name) ?? 0) + Number(s.employerCost));
      }
      byDepartment = [...m.entries()].map(([name, cost]) => ({ name, cost })).sort((a, b) => b.cost - a.cost);
    }
    // Salary distribution of current basic salaries in base currency (bands).
    const structures = await prisma.salaryStructure.findMany({
      where: { status: 'ACTIVE', effectiveFrom: { lte: today }, OR: [{ effectiveTo: null }, { effectiveTo: { gte: today } }], employee: current, currency: company.baseCurrency },
      select: { basicSalary: true },
    });
    const values = structures.map((s) => Number(s.basicSalary)).sort((a, b) => a - b);
    const bands: { band: string; count: number }[] = [];
    if (values.length) {
      const max = values[values.length - 1];
      const step = niceStep(max / 6);
      for (let lo = 0; lo <= max; lo += step) bands.push({ band: `${fmtK(lo)}–${fmtK(lo + step)}`, count: values.filter((v) => v >= lo && v < lo + step).length });
    }
    payroll = {
      currency: company.baseCurrency,
      latest: latest ?? null,
      trend: [...runs].reverse().map((x) => ({ month: `${x.year}-${String(x.month).padStart(2, '0')}`, gross: Number(x.totalGross), net: Number(x.totalNet), employerCost: Number(x.totalEmployerCost) })),
      byDepartment,
      salaryDistribution: bands,
      averageBasic: values.length ? values.reduce((a, b) => a + b, 0) / values.length : null,
    };
  }

  // Expirations in the next 60 days.
  const horizon = addDays(today, 60);
  const [contracts, documents, probations] = await Promise.all([
    prisma.employee.findMany({ where: { AND: [current, { contractEndDate: { gte: today, lte: horizon } }] }, select: { id: true, employeeNo: true, firstName: true, lastName: true, contractEndDate: true }, orderBy: { contractEndDate: 'asc' }, take: 10 }),
    prisma.employeeDocument.findMany({
      where: { deletedAt: null, expiryDate: { gte: today, lte: horizon }, employee: current, ...(hasPermission(user, 'document.confidential.read') ? {} : { confidential: false }) },
      select: { id: true, title: true, type: true, expiryDate: true, employee: { select: { id: true, firstName: true, lastName: true } } },
      orderBy: { expiryDate: 'asc' },
      take: 10,
    }),
    prisma.employee.findMany({ where: { AND: [current, { status: 'PROBATION' }, { probationEndDate: { gte: today, lte: horizon } }] }, select: { id: true, firstName: true, lastName: true, probationEndDate: true }, orderBy: { probationEndDate: 'asc' }, take: 10 }),
  ]);
  const [expiredDocs] = await Promise.all([prisma.employeeDocument.count({ where: { deletedAt: null, expiryDate: { lt: today }, employee: current } })]);

  // Pending approvals.
  const pendingWhere: Prisma.ApprovalRequestWhereInput = hasPermission(user, 'approval.read.all')
    ? { companyId, status: 'PENDING' }
    : { status: 'PENDING', tasks: { some: { assigneeId: user.id, status: 'OPEN' } } };
  const pendingByType = await prisma.approvalRequest.groupBy({ by: ['requestType'], where: pendingWhere, _count: { _all: true } });

  // Leave in period by type.
  const leaveByType = await prisma.leaveRequest.groupBy({ by: ['leaveTypeId'], where: { status: 'APPROVED', startDate: { lte: to }, endDate: { gte: from }, employee: current }, _sum: { days: true } });
  const leaveTypes = await prisma.leaveType.findMany({ where: { id: { in: leaveByType.map((l) => l.leaveTypeId) } }, select: { id: true, name: true, nameAr: true, color: true } });

  // Daily attendance trend (last 31 days of the selected period).
  const trendFrom = from > addDays(to, -30) ? from : addDays(to, -30);
  const daily = await prisma.attendanceRecord.groupBy({ by: ['date', 'status'], where: { date: { gte: trendFrom, lte: to }, employee: current }, _count: { _all: true } });
  const byDay = new Map<string, { date: string; present: number; late: number; absent: number; onLeave: number }>();
  for (const d of daily) {
    if (d.status === 'WEEKEND' || d.status === 'HOLIDAY') continue;
    const k = isoDate(d.date);
    const row = byDay.get(k) ?? { date: k, present: 0, late: 0, absent: 0, onLeave: 0 };
    const n = d._count._all;
    if (['PRESENT', 'LATE', 'HALF_DAY', 'MISSED_PUNCH'].includes(d.status)) row.present += n;
    if (d.status === 'LATE') row.late += n;
    if (d.status === 'ABSENT') row.absent += n;
    if (d.status === 'ON_LEAVE') row.onLeave += n;
    byDay.set(k, row);
  }
  const attendanceTrend = [...byDay.values()]
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((r) => ({ ...r, absenteeismRate: r.present + r.absent + r.onLeave ? r.absent / (r.present + r.absent + r.onLeave) : 0 }));

  // Upcoming events in the next 30 days.
  const soon = addDays(today, 30);
  const [holidays, leavesStarting, people] = await Promise.all([
    prisma.holiday.findMany({ where: { companyId, date: { gte: today, lte: soon }, ...(query.branchId ? { OR: [{ branchId: null }, { branchId: query.branchId }] } : {}) }, orderBy: { date: 'asc' }, take: 5, select: { id: true, date: true, name: true, nameAr: true } }),
    prisma.leaveRequest.findMany({
      where: { status: 'APPROVED', startDate: { gt: today, lte: addDays(today, 14) }, employee: current },
      orderBy: { startDate: 'asc' },
      take: 6,
      select: { id: true, startDate: true, endDate: true, leaveType: { select: { name: true, nameAr: true } }, employee: { select: { id: true, firstName: true, lastName: true, firstNameAr: true, lastNameAr: true } } },
    }),
    prisma.employee.findMany({ where: { AND: [current, { dateOfBirth: { not: null } }] }, select: { id: true, firstName: true, lastName: true, firstNameAr: true, lastNameAr: true, dateOfBirth: true, hireDate: true } }),
  ]);
  const nextOccurrence = (d: Date) => {
    let n = new Date(Date.UTC(today.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
    if (n < today) n = new Date(Date.UTC(today.getUTCFullYear() + 1, d.getUTCMonth(), d.getUTCDate()));
    return n;
  };
  const birthdays = people
    .map((p) => ({ id: p.id, firstName: p.firstName, lastName: p.lastName, firstNameAr: p.firstNameAr, lastNameAr: p.lastNameAr, date: nextOccurrence(p.dateOfBirth!) }))
    .filter((p) => p.date <= addDays(today, 14))
    .sort((a, b) => a.date.getTime() - b.date.getTime())
    .slice(0, 6)
    .map((p) => ({ ...p, date: isoDate(p.date) }));

  // Open positions: budgeted headcount minus current holders, per position.
  const positionsBudget = await prisma.position.findMany({
    where: { companyId, isActive: true, ...(query.departmentId ? { departmentId: query.departmentId } : {}) },
    select: { headcount: true, _count: { select: { employees: { where: { deletedAt: null, status: { in: ['ACTIVE', 'PROBATION', 'SUSPENDED'] } } } } } },
  });
  const budgeted = positionsBudget.reduce((a, p) => a + p.headcount, 0);
  const openPositions = positionsBudget.reduce((a, p) => a + Math.max(0, p.headcount - p._count.employees), 0);

  return {
    filters: { from: isoDate(from), to: isoDate(to), today: isoDate(today) },
    headcount: {
      total, active, probation, current: headcountNow,
      byStatus: byStatus.map((s) => ({ status: s.status, count: s._count._all })),
      byDepartment: byDept.map((d) => ({ ...label(depts, d.departmentId, (x) => ({ name: x.name, nameAr: x.nameAr })), id: d.departmentId, count: d._count._all })).sort((a, b) => b.count - a.count),
      byBranch: byBranch.map((d) => ({ ...label(branches, d.branchId, (x) => ({ name: x.name, nameAr: x.nameAr })), id: d.branchId, count: d._count._all })).sort((a, b) => b.count - a.count),
      byPosition: byPosition.map((d) => ({ ...label(positions, d.positionId, (x) => ({ name: x.title, nameAr: x.titleAr })), id: d.positionId, count: d._count._all })),
      byGender: byGender.map((g) => ({ gender: g.gender ?? 'UNSPECIFIED', count: g._count._all })),
      trend: trendPoints,
    },
    movement: { hires, separations, turnoverRate: separations / avgHeadcount },
    attendanceToday: {
      present,
      late: t.LATE ?? 0,
      absent: t.ABSENT ?? 0,
      missedPunch: t.MISSED_PUNCH ?? 0,
      onLeave: onLeaveToday,
      notRecorded: Math.max(0, headcountNow - present - (t.ABSENT ?? 0) - onLeaveToday),
      absenteeismRate: headcountNow ? (t.ABSENT ?? 0) / headcountNow : 0,
    },
    attendancePeriod: {
      lateArrivals: lateCount,
      lateHours: (periodAgg._sum.lateMinutes ?? 0) / 60,
      overtimeHours: (periodAgg._sum.overtimeMinutes ?? 0) / 60,
      approvedOvertimeHours: (periodAgg._sum.approvedOvertimeMinutes ?? 0) / 60,
      absences: absentCount,
      absenteeismRate: scheduledCount ? absentCount / scheduledCount : 0,
    },
    leave: {
      onLeaveToday,
      byType: leaveByType.map((l) => ({ ...leaveTypes.find((x) => x.id === l.leaveTypeId), days: Number(l._sum.days ?? 0) })),
    },
    payroll,
    expirations: { contracts, documents, probations, expiredDocuments: expiredDocs },
    approvals: { pending: pendingByType.reduce((a, b) => a + b._count._all, 0), byType: pendingByType.map((p) => ({ type: p.requestType, count: p._count._all })) },
    attendanceTrend,
    events: { holidays: holidays.map((h) => ({ ...h, date: isoDate(h.date) })), leavesStarting, birthdays },
    workforce: { budgeted, openPositions },
    // Recruitment, training and performance metrics arrive with the Phase 4 modules.
    upcoming: { recruitment: null, training: null, performance: null },
  };
});

function niceStep(raw: number) {
  if (raw <= 0) return 1000;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const n = raw / pow;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * pow;
}
function fmtK(v: number) {
  return v >= 1000 ? `${Math.round(v / 100) / 10}k` : String(v);
}
