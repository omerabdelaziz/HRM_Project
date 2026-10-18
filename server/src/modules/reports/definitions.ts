import { z } from 'zod';
import { prisma, Prisma } from '../../lib/prisma';
import { AuthUser, hasPermission } from '../../auth/context';
import { employeeScope } from '../../auth/scope';
import { addDays, daysBetweenInclusive, isoDate, toDateOnly } from '../../lib/dates';
import { PermissionCode } from '../../auth/permissions';
import { available } from '../leave/balances';

export interface Column {
  key: string;
  label: string;
  type?: 'text' | 'number' | 'percent' | 'date' | 'money' | 'hours';
}
export interface ReportResult {
  title: string;
  columns: Column[];
  rows: Record<string, unknown>[];
  /** Suggested chart: x = column key for categories, y = numeric column keys. */
  chart?: { type: 'bar' | 'line' | 'pie'; x: string; y: string[] };
}

const d = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const baseFilters = z.object({
  departmentId: z.string().uuid().optional(),
  branchId: z.string().uuid().optional(),
});
const range = baseFilters.extend({ from: d, to: d });

interface ReportDef<F extends z.ZodTypeAny> {
  key: string;
  title: string;
  description: string;
  category: 'Attendance' | 'Leave' | 'Workforce' | 'Payroll' | 'Compliance';
  permission: PermissionCode[];
  filters: F;
  run(user: AuthUser, companyId: string, f: z.infer<F>): Promise<ReportResult>;
}

async function empWhere(user: AuthUser, companyId: string, f: { departmentId?: string; branchId?: string }, extra: Prisma.EmployeeWhereInput = {}): Promise<Prisma.EmployeeWhereInput> {
  return {
    AND: [await employeeScope(user), { companyId, deletedAt: null }, f.departmentId ? { departmentId: f.departmentId } : {}, f.branchId ? { branchId: f.branchId } : {}, extra],
  };
}
const ACTIVE = { status: { in: ['ACTIVE', 'PROBATION', 'SUSPENDED'] as ('ACTIVE' | 'PROBATION' | 'SUSPENDED')[] } };
const name = (e: { firstName: string; lastName: string }) => `${e.firstName} ${e.lastName}`;

function def<F extends z.ZodTypeAny>(r: ReportDef<F>) {
  return r;
}

export const REPORTS = [
  def({
    key: 'attendance-summary',
    title: 'Attendance summary',
    description: 'Worked hours, late arrivals, early departures, overtime and absences per employee',
    category: 'Attendance',
    permission: ['attendance.read'],
    filters: range,
    async run(user, companyId, f) {
      const employee = await empWhere(user, companyId, f);
      const where = { date: { gte: toDateOnly(f.from), lte: toDateOnly(f.to) }, employee };
      const sums = await prisma.attendanceRecord.groupBy({ by: ['employeeId'], where, _sum: { workedMinutes: true, lateMinutes: true, earlyLeaveMinutes: true, overtimeMinutes: true } });
      const statuses = await prisma.attendanceRecord.groupBy({ by: ['employeeId', 'status'], where, _count: { _all: true } });
      const late = await prisma.attendanceRecord.groupBy({ by: ['employeeId'], where: { ...where, lateMinutes: { gt: 0 } }, _count: { _all: true } });
      const emps = await prisma.employee.findMany({ where: { id: { in: sums.map((s) => s.employeeId) } }, select: { id: true, employeeNo: true, firstName: true, lastName: true, department: { select: { name: true } } } });
      const count = (id: string, st: string) => statuses.find((s) => s.employeeId === id && s.status === st)?._count._all ?? 0;
      return {
        title: `Attendance summary ${f.from} to ${f.to}`,
        columns: [
          { key: 'employeeNo', label: 'Employee No' }, { key: 'name', label: 'Name' }, { key: 'department', label: 'Department' },
          { key: 'present', label: 'Present days', type: 'number' }, { key: 'absent', label: 'Absent days', type: 'number' }, { key: 'onLeave', label: 'Leave days', type: 'number' },
          { key: 'lateCount', label: 'Late arrivals', type: 'number' }, { key: 'lateHours', label: 'Late hours', type: 'hours' }, { key: 'earlyHours', label: 'Early leave hours', type: 'hours' },
          { key: 'workedHours', label: 'Worked hours', type: 'hours' }, { key: 'overtimeHours', label: 'Overtime hours', type: 'hours' }, { key: 'missedPunches', label: 'Missed punches', type: 'number' },
        ],
        rows: emps
          .map((e) => {
            const s = sums.find((x) => x.employeeId === e.id)!;
            return {
              employeeNo: e.employeeNo, name: name(e), department: e.department?.name ?? '',
              present: count(e.id, 'PRESENT') + count(e.id, 'LATE') + count(e.id, 'HALF_DAY'), absent: count(e.id, 'ABSENT'), onLeave: count(e.id, 'ON_LEAVE'),
              lateCount: late.find((x) => x.employeeId === e.id)?._count._all ?? 0,
              lateHours: (s._sum.lateMinutes ?? 0) / 60, earlyHours: (s._sum.earlyLeaveMinutes ?? 0) / 60,
              workedHours: (s._sum.workedMinutes ?? 0) / 60, overtimeHours: (s._sum.overtimeMinutes ?? 0) / 60, missedPunches: count(e.id, 'MISSED_PUNCH'),
            };
          })
          .sort((a, b) => a.employeeNo.localeCompare(b.employeeNo)),
      };
    },
  }),
  def({
    key: 'absenteeism',
    title: 'Absenteeism by department',
    description: 'Scheduled days, absences, absence rate and late arrivals per department',
    category: 'Attendance',
    permission: ['attendance.read'],
    filters: range,
    async run(user, companyId, f) {
      const employee = await empWhere(user, companyId, f);
      const records = await prisma.attendanceRecord.findMany({
        where: { date: { gte: toDateOnly(f.from), lte: toDateOnly(f.to) }, employee, status: { notIn: ['WEEKEND', 'HOLIDAY'] } },
        select: { status: true, lateMinutes: true, employee: { select: { department: { select: { name: true } } } } },
      });
      const m = new Map<string, { department: string; scheduled: number; absent: number; late: number; leave: number }>();
      for (const rec of records) {
        const k = rec.employee.department?.name ?? 'Unassigned';
        const g = m.get(k) ?? { department: k, scheduled: 0, absent: 0, late: 0, leave: 0 };
        g.scheduled++;
        if (rec.status === 'ABSENT') g.absent++;
        if (rec.status === 'ON_LEAVE') g.leave++;
        if (rec.lateMinutes > 0) g.late++;
        m.set(k, g);
      }
      return {
        title: `Absenteeism ${f.from} to ${f.to}`,
        columns: [
          { key: 'department', label: 'Department' }, { key: 'scheduled', label: 'Scheduled days', type: 'number' }, { key: 'absent', label: 'Absences', type: 'number' },
          { key: 'rate', label: 'Absence rate', type: 'percent' }, { key: 'leave', label: 'Leave days', type: 'number' }, { key: 'late', label: 'Late arrivals', type: 'number' },
        ],
        rows: [...m.values()].map((g) => ({ ...g, rate: g.scheduled ? g.absent / g.scheduled : 0 })).sort((a, b) => b.rate - a.rate),
        chart: { type: 'bar', x: 'department', y: ['absent', 'late'] },
      };
    },
  }),
  def({
    key: 'overtime',
    title: 'Overtime',
    description: 'Overtime hours (recorded and approved) per employee',
    category: 'Attendance',
    permission: ['attendance.read'],
    filters: range,
    async run(user, companyId, f) {
      const employee = await empWhere(user, companyId, f);
      const sums = await prisma.attendanceRecord.groupBy({
        by: ['employeeId'],
        where: { date: { gte: toDateOnly(f.from), lte: toDateOnly(f.to) }, employee, overtimeMinutes: { gt: 0 } },
        _sum: { overtimeMinutes: true, approvedOvertimeMinutes: true },
        _count: { _all: true },
      });
      const emps = await prisma.employee.findMany({ where: { id: { in: sums.map((s) => s.employeeId) } }, select: { id: true, employeeNo: true, firstName: true, lastName: true, department: { select: { name: true } } } });
      return {
        title: `Overtime ${f.from} to ${f.to}`,
        columns: [
          { key: 'employeeNo', label: 'Employee No' }, { key: 'name', label: 'Name' }, { key: 'department', label: 'Department' },
          { key: 'days', label: 'Days with overtime', type: 'number' }, { key: 'recorded', label: 'Recorded hours', type: 'hours' }, { key: 'approved', label: 'Approved hours', type: 'hours' },
        ],
        rows: sums
          .map((s) => {
            const e = emps.find((x) => x.id === s.employeeId)!;
            return { employeeNo: e.employeeNo, name: name(e), department: e.department?.name ?? '', days: s._count._all, recorded: (s._sum.overtimeMinutes ?? 0) / 60, approved: (s._sum.approvedOvertimeMinutes ?? 0) / 60 };
          })
          .sort((a, b) => b.recorded - a.recorded),
        chart: { type: 'bar', x: 'name', y: ['recorded', 'approved'] },
      };
    },
  }),
  def({
    key: 'leave-balances',
    title: 'Leave balances',
    description: 'Entitlement, carry-over, used, pending and available days per employee and leave type',
    category: 'Leave',
    permission: ['leave.read'],
    filters: baseFilters.extend({ year: z.coerce.number().int(), leaveTypeId: z.string().uuid().optional() }),
    async run(user, companyId, f) {
      const employee = await empWhere(user, companyId, f, ACTIVE);
      const rows = await prisma.leaveBalance.findMany({
        where: { year: f.year, employee, ...(f.leaveTypeId ? { leaveTypeId: f.leaveTypeId } : {}), leaveType: { accrualMethod: { not: 'NONE' } } },
        include: { leaveType: { select: { name: true } }, employee: { select: { employeeNo: true, firstName: true, lastName: true, department: { select: { name: true } } } } },
        orderBy: [{ employee: { employeeNo: 'asc' } }, { leaveType: { name: 'asc' } }],
      });
      return {
        title: `Leave balances ${f.year}`,
        columns: [
          { key: 'employeeNo', label: 'Employee No' }, { key: 'name', label: 'Name' }, { key: 'department', label: 'Department' }, { key: 'leaveType', label: 'Leave type' },
          { key: 'entitled', label: 'Entitled', type: 'number' }, { key: 'carriedOver', label: 'Carried over', type: 'number' }, { key: 'adjusted', label: 'Adjusted', type: 'number' },
          { key: 'used', label: 'Used', type: 'number' }, { key: 'pending', label: 'Pending', type: 'number' }, { key: 'available', label: 'Available', type: 'number' },
        ],
        rows: rows.map((b) => ({
          employeeNo: b.employee.employeeNo, name: name(b.employee), department: b.employee.department?.name ?? '', leaveType: b.leaveType.name,
          entitled: Number(b.entitled), carriedOver: Number(b.carriedOver), adjusted: Number(b.adjusted), used: Number(b.used), pending: Number(b.pending), available: available(b).toNumber(),
        })),
      };
    },
  }),
  def({
    key: 'leave-utilization',
    title: 'Leave utilization',
    description: 'Approved leave days by leave type and department',
    category: 'Leave',
    permission: ['leave.read'],
    filters: range,
    async run(user, companyId, f) {
      const employee = await empWhere(user, companyId, f);
      const reqs = await prisma.leaveRequest.findMany({
        where: { status: 'APPROVED', startDate: { lte: toDateOnly(f.to) }, endDate: { gte: toDateOnly(f.from) }, employee },
        select: { days: true, leaveType: { select: { name: true } }, employee: { select: { department: { select: { name: true } } } } },
      });
      const m = new Map<string, { department: string; leaveType: string; requests: number; days: number }>();
      for (const q of reqs) {
        const dept = q.employee.department?.name ?? 'Unassigned';
        const k = `${dept}|${q.leaveType.name}`;
        const g = m.get(k) ?? { department: dept, leaveType: q.leaveType.name, requests: 0, days: 0 };
        g.requests++;
        g.days += Number(q.days);
        m.set(k, g);
      }
      return {
        title: `Leave utilization ${f.from} to ${f.to}`,
        columns: [{ key: 'department', label: 'Department' }, { key: 'leaveType', label: 'Leave type' }, { key: 'requests', label: 'Requests', type: 'number' }, { key: 'days', label: 'Days', type: 'number' }],
        rows: [...m.values()].sort((a, b) => b.days - a.days),
        chart: { type: 'bar', x: 'leaveType', y: ['days'] },
      };
    },
  }),
  def({
    key: 'headcount',
    title: 'Headcount',
    description: 'Current headcount by department, with status breakdown and vacancies against budgeted positions',
    category: 'Workforce',
    permission: ['employee.read'],
    filters: baseFilters,
    async run(user, companyId, f) {
      const employee = await empWhere(user, companyId, f);
      const groups = await prisma.employee.groupBy({ by: ['departmentId', 'status'], where: employee, _count: { _all: true } });
      const depts = await prisma.department.findMany({ where: { companyId }, select: { id: true, name: true, positions: { where: { isActive: true }, select: { headcount: true } } } });
      const m = new Map<string, Record<string, number | string>>();
      for (const g of groups) {
        const dept = depts.find((x) => x.id === g.departmentId);
        const k = dept?.name ?? 'Unassigned';
        const row = m.get(k) ?? { department: k, ACTIVE: 0, PROBATION: 0, SUSPENDED: 0, separated: 0, budgeted: dept?.positions.reduce((a, p) => a + p.headcount, 0) ?? 0 };
        if (['RESIGNED', 'TERMINATED', 'RETIRED'].includes(g.status)) row.separated = (row.separated as number) + g._count._all;
        else row[g.status] = (row[g.status] as number) + g._count._all;
        m.set(k, row);
      }
      const rows = [...m.values()].map((r) => {
        const current = (r.ACTIVE as number) + (r.PROBATION as number) + (r.SUSPENDED as number);
        return { ...r, current, vacancies: Math.max(0, (r.budgeted as number) - current) };
      });
      return {
        title: 'Headcount by department',
        columns: [
          { key: 'department', label: 'Department' }, { key: 'current', label: 'Current headcount', type: 'number' }, { key: 'ACTIVE', label: 'Active', type: 'number' },
          { key: 'PROBATION', label: 'On probation', type: 'number' }, { key: 'SUSPENDED', label: 'Suspended', type: 'number' }, { key: 'budgeted', label: 'Budgeted positions', type: 'number' },
          { key: 'vacancies', label: 'Vacancies', type: 'number' }, { key: 'separated', label: 'Separated (all time)', type: 'number' },
        ],
        rows: rows.sort((a, b) => (b.current as number) - (a.current as number)),
        chart: { type: 'bar', x: 'department', y: ['current', 'budgeted'] },
      };
    },
  }),
  def({
    key: 'turnover',
    title: 'Hires and turnover',
    description: 'Monthly hires, separations, headcount and turnover rate',
    category: 'Workforce',
    permission: ['employee.read'],
    filters: range,
    async run(user, companyId, f) {
      const base = await empWhere(user, companyId, f);
      const start = toDateOnly(f.from);
      const end = toDateOnly(f.to);
      const rows = [];
      for (let m = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1)); m <= end; m = new Date(Date.UTC(m.getUTCFullYear(), m.getUTCMonth() + 1, 1))) {
        const mEnd = new Date(Date.UTC(m.getUTCFullYear(), m.getUTCMonth() + 1, 0));
        const [hires, separations, opening, closing] = await Promise.all([
          prisma.employee.count({ where: { AND: [base, { hireDate: { gte: m, lte: mEnd } }] } }),
          prisma.employee.count({ where: { AND: [base, { separationDate: { gte: m, lte: mEnd } }] } }),
          prisma.employee.count({ where: { AND: [base, { hireDate: { lt: m } }, { OR: [{ separationDate: null }, { separationDate: { gte: m } }] }] } }),
          prisma.employee.count({ where: { AND: [base, { hireDate: { lte: mEnd } }, { OR: [{ separationDate: null }, { separationDate: { gt: mEnd } }] }] } }),
        ]);
        const avg = (opening + closing) / 2;
        rows.push({ month: isoDate(m).slice(0, 7), opening, hires, separations, closing, turnoverRate: avg ? separations / avg : 0 });
      }
      return {
        title: `Hires and turnover ${f.from} to ${f.to}`,
        columns: [
          { key: 'month', label: 'Month' }, { key: 'opening', label: 'Opening headcount', type: 'number' }, { key: 'hires', label: 'Hires', type: 'number' },
          { key: 'separations', label: 'Separations', type: 'number' }, { key: 'closing', label: 'Closing headcount', type: 'number' }, { key: 'turnoverRate', label: 'Turnover rate', type: 'percent' },
        ],
        rows,
        chart: { type: 'line', x: 'month', y: ['hires', 'separations'] },
      };
    },
  }),
  def({
    key: 'contract-expiry',
    title: 'Contract expirations',
    description: 'Employment contracts and probation periods ending soon',
    category: 'Compliance',
    permission: ['employee.read'],
    filters: baseFilters.extend({ days: z.coerce.number().int().min(1).max(365).default(90) }),
    async run(user, companyId, f) {
      const today = toDateOnly(new Date());
      const until = addDays(today, f.days);
      const employee = await empWhere(user, companyId, f, ACTIVE);
      const rows = await prisma.employee.findMany({
        where: { AND: [employee, { OR: [{ contractEndDate: { lte: until } }, { status: 'PROBATION', probationEndDate: { lte: until } }] }] },
        select: { employeeNo: true, firstName: true, lastName: true, contractEndDate: true, probationEndDate: true, status: true, department: { select: { name: true } } },
        orderBy: { contractEndDate: 'asc' },
      });
      return {
        title: `Contracts and probations ending within ${f.days} days`,
        columns: [
          { key: 'employeeNo', label: 'Employee No' }, { key: 'name', label: 'Name' }, { key: 'department', label: 'Department' }, { key: 'item', label: 'Item' },
          { key: 'date', label: 'End date', type: 'date' }, { key: 'daysLeft', label: 'Days left', type: 'number' },
        ],
        rows: rows
          .flatMap((e) => [
            e.contractEndDate && e.contractEndDate <= until ? { item: 'Contract', date: e.contractEndDate } : null,
            e.status === 'PROBATION' && e.probationEndDate && e.probationEndDate <= until ? { item: 'Probation', date: e.probationEndDate } : null,
          ].filter(Boolean).map((x) => ({ employeeNo: e.employeeNo, name: name(e), department: e.department?.name ?? '', item: x!.item, date: isoDate(x!.date), daysLeft: daysBetweenInclusive(today, x!.date) - 1 })))
          .sort((a, b) => a.daysLeft - b.daysLeft),
      };
    },
  }),
  def({
    key: 'document-expiry',
    title: 'Document expirations',
    description: 'IDs, passports, visas and certificates expiring soon or already expired',
    category: 'Compliance',
    permission: ['document.read'],
    filters: baseFilters.extend({ days: z.coerce.number().int().min(1).max(365).default(60), includeExpired: z.enum(['true', 'false']).default('true') }),
    async run(user, companyId, f) {
      const today = toDateOnly(new Date());
      const until = addDays(today, f.days);
      const employee = await empWhere(user, companyId, f, ACTIVE);
      const docs = await prisma.employeeDocument.findMany({
        where: {
          deletedAt: null, employee, expiryDate: { lte: until, ...(f.includeExpired === 'true' ? {} : { gte: today }) },
          ...(hasPermission(user, 'document.confidential.read') ? {} : { confidential: false }),
        },
        select: { title: true, type: true, documentNo: true, expiryDate: true, employee: { select: { employeeNo: true, firstName: true, lastName: true } } },
        orderBy: { expiryDate: 'asc' },
      });
      return {
        title: `Documents expiring within ${f.days} days`,
        columns: [
          { key: 'employeeNo', label: 'Employee No' }, { key: 'name', label: 'Name' }, { key: 'type', label: 'Type' }, { key: 'title', label: 'Document' },
          { key: 'documentNo', label: 'Number' }, { key: 'expiryDate', label: 'Expiry date', type: 'date' }, { key: 'daysLeft', label: 'Days left', type: 'number' },
        ],
        rows: docs.map((x) => ({
          employeeNo: x.employee.employeeNo, name: name(x.employee), type: x.type, title: x.title, documentNo: x.documentNo ?? '',
          expiryDate: isoDate(x.expiryDate!), daysLeft: daysBetweenInclusive(today, x.expiryDate!) - 1,
        })),
      };
    },
  }),
  def({
    key: 'payroll-summary',
    title: 'Payroll summary',
    description: 'Totals per approved payroll run',
    category: 'Payroll',
    permission: ['payroll.read'],
    filters: z.object({ year: z.coerce.number().int() }),
    async run(_user, companyId, f) {
      const runs = await prisma.payrollRun.findMany({ where: { companyId, year: f.year, status: { not: 'CANCELLED' } }, orderBy: { month: 'asc' } });
      return {
        title: `Payroll summary ${f.year}`,
        columns: [
          { key: 'period', label: 'Period' }, { key: 'status', label: 'Status' }, { key: 'employees', label: 'Employees', type: 'number' }, { key: 'gross', label: 'Gross', type: 'money' },
          { key: 'deductions', label: 'Deductions', type: 'money' }, { key: 'net', label: 'Net', type: 'money' }, { key: 'employerCost', label: 'Employer cost', type: 'money' }, { key: 'currency', label: 'Currency' },
        ],
        rows: runs.map((x) => ({
          period: `${x.year}-${String(x.month).padStart(2, '0')}`, status: x.status, employees: x.employeeCount, gross: Number(x.totalGross), deductions: Number(x.totalDeductions),
          net: Number(x.totalNet), employerCost: Number(x.totalEmployerCost), currency: x.currency,
        })),
        chart: { type: 'line', x: 'period', y: ['gross', 'net', 'employerCost'] },
      };
    },
  }),
  def({
    key: 'payroll-by-department',
    title: 'Payroll cost by department',
    description: 'Gross, deductions, net and employer cost per department and branch for a month',
    category: 'Payroll',
    permission: ['payroll.read'],
    filters: z.object({ year: z.coerce.number().int(), month: z.coerce.number().int().min(1).max(12) }),
    async run(_user, companyId, f) {
      const slips = await prisma.payslip.findMany({
        where: { run: { companyId, year: f.year, month: f.month, status: { not: 'CANCELLED' } } },
        select: { snapshot: true, grossEarnings: true, totalDeductions: true, netPay: true, employerCost: true, currency: true },
      });
      const m = new Map<string, { department: string; branch: string; currency: string; employees: number; gross: number; deductions: number; net: number; employerCost: number }>();
      for (const s of slips) {
        const snap = s.snapshot as Record<string, string | null>;
        const k = `${snap.department}|${snap.branch}|${s.currency}`;
        const g = m.get(k) ?? { department: snap.department ?? 'Unassigned', branch: snap.branch ?? '—', currency: s.currency, employees: 0, gross: 0, deductions: 0, net: 0, employerCost: 0 };
        g.employees++;
        g.gross += Number(s.grossEarnings);
        g.deductions += Number(s.totalDeductions);
        g.net += Number(s.netPay);
        g.employerCost += Number(s.employerCost);
        m.set(k, g);
      }
      return {
        title: `Payroll by department ${f.year}-${String(f.month).padStart(2, '0')}`,
        columns: [
          { key: 'department', label: 'Department' }, { key: 'branch', label: 'Branch' }, { key: 'employees', label: 'Employees', type: 'number' }, { key: 'gross', label: 'Gross', type: 'money' },
          { key: 'deductions', label: 'Deductions', type: 'money' }, { key: 'net', label: 'Net', type: 'money' }, { key: 'employerCost', label: 'Employer cost', type: 'money' }, { key: 'currency', label: 'Currency' },
        ],
        rows: [...m.values()].sort((a, b) => b.employerCost - a.employerCost),
        chart: { type: 'bar', x: 'department', y: ['employerCost'] },
      };
    },
  }),
  def({
    key: 'department-comparison',
    title: 'Department and branch comparison',
    description: 'Headcount, tenure, absence, overtime and (with payroll access) cost side by side',
    category: 'Workforce',
    permission: ['employee.read'],
    filters: range.extend({ groupBy: z.enum(['department', 'branch']).default('department') }),
    async run(user, companyId, f) {
      const employee = await empWhere(user, companyId, f, ACTIVE);
      const emps = await prisma.employee.findMany({ where: employee, select: { id: true, hireDate: true, department: { select: { name: true } }, branch: { select: { name: true } } } });
      const keyOf = (e: (typeof emps)[number]) => (f.groupBy === 'branch' ? e.branch?.name : e.department?.name) ?? 'Unassigned';
      const records = await prisma.attendanceRecord.findMany({
        where: { date: { gte: toDateOnly(f.from), lte: toDateOnly(f.to) }, employeeId: { in: emps.map((e) => e.id) }, status: { notIn: ['WEEKEND', 'HOLIDAY'] } },
        select: { employeeId: true, status: true, overtimeMinutes: true },
      });
      const showPay = hasPermission(user, 'payroll.read');
      const lastRun = showPay ? await prisma.payrollRun.findFirst({ where: { companyId, status: { in: ['APPROVED', 'PAID'] } }, orderBy: [{ year: 'desc' }, { month: 'desc' }] }) : null;
      const slips = lastRun ? await prisma.payslip.findMany({ where: { runId: lastRun.id, employeeId: { in: emps.map((e) => e.id) } }, select: { employeeId: true, employerCost: true } }) : [];
      const today = new Date();
      const m = new Map<string, { group: string; headcount: number; tenureSum: number; scheduled: number; absent: number; overtime: number; cost: number }>();
      for (const e of emps) {
        const k = keyOf(e);
        const g = m.get(k) ?? { group: k, headcount: 0, tenureSum: 0, scheduled: 0, absent: 0, overtime: 0, cost: 0 };
        g.headcount++;
        g.tenureSum += (today.getTime() - e.hireDate.getTime()) / (365.25 * 86_400_000);
        for (const rec of records.filter((x) => x.employeeId === e.id)) {
          g.scheduled++;
          if (rec.status === 'ABSENT') g.absent++;
          g.overtime += rec.overtimeMinutes / 60;
        }
        g.cost += Number(slips.find((s) => s.employeeId === e.id)?.employerCost ?? 0);
        m.set(k, g);
      }
      const columns: Column[] = [
        { key: 'group', label: f.groupBy === 'branch' ? 'Branch' : 'Department' }, { key: 'headcount', label: 'Headcount', type: 'number' },
        { key: 'avgTenure', label: 'Average tenure (years)', type: 'number' }, { key: 'absenceRate', label: 'Absence rate', type: 'percent' }, { key: 'overtime', label: 'Overtime hours', type: 'hours' },
      ];
      if (showPay) columns.push({ key: 'cost', label: `Employer cost ${lastRun ? `(${lastRun.year}-${String(lastRun.month).padStart(2, '0')})` : ''}`, type: 'money' }, { key: 'costPerHead', label: 'Cost per head', type: 'money' });
      return {
        title: `Comparison by ${f.groupBy} ${f.from} to ${f.to}`,
        columns,
        rows: [...m.values()].map((g) => ({
          group: g.group, headcount: g.headcount, avgTenure: Math.round((g.tenureSum / g.headcount) * 10) / 10, absenceRate: g.scheduled ? g.absent / g.scheduled : 0,
          overtime: g.overtime, ...(showPay ? { cost: g.cost, costPerHead: g.headcount ? g.cost / g.headcount : 0 } : {}),
        })),
        chart: { type: 'bar', x: 'group', y: ['headcount'] },
      };
    },
  }),
];

export type AnyReport = (typeof REPORTS)[number];
export const findReport = (key: string) => REPORTS.find((r) => r.key === key) as ReportDef<z.ZodTypeAny> | undefined;
