import { ReactNode, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  AlertTriangle, BarChart3, Briefcase, Cake, CalendarClock, CalendarDays, CalendarPlus, CheckSquare, ChevronRight, Clock, FileWarning, LayoutDashboard as PageIcon,
  PartyPopper, RotateCcw, SlidersHorizontal, TrendingUp, UserMinus, UserPlus, Users, Wallet,
} from 'lucide-react';
import { useGet } from '@/lib/hooks';
import { useAuth } from '@/lib/auth';
import { localized, personName } from '@/lib/i18n';
import { fmtCompact, fmtDate, fmtDateShort, fmtMoney, fmtMonth, fmtNumber, fmtPercent } from '@/lib/format';
import { cn, monthStartIso, todayIso } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Field, Input, Select } from '@/components/ui/form';
import { Badge, Card, CardHeader, ErrorState, PageHeader, Skeleton, StatTile } from '@/components/ui/display';
import { EmployeePicker, OrgSelect } from '@/components/ui/pickers';
import { BarList, ChartCard, ColumnChart, LineSeriesChart } from '@/components/charts';
import { LeaveRequestDialog } from './leave/LeaveRequestDialog';

interface Named { id: string | null; name: string; nameAr?: string | null; count: number }
interface Person { id: string; firstName: string; lastName: string; firstNameAr?: string | null; lastNameAr?: string | null }
interface DashboardData {
  filters: { from: string; to: string; today: string };
  headcount: { total: number; active: number; probation: number; current: number; byStatus: { status: string; count: number }[]; byDepartment: Named[]; byBranch: Named[]; byPosition: Named[]; byGender: { gender: string; count: number }[]; trend: { month: string; headcount: number; hires: number; separations: number }[] };
  movement: { hires: number; separations: number; turnoverRate: number };
  attendanceToday: { present: number; late: number; absent: number; missedPunch: number; onLeave: number; notRecorded: number; absenteeismRate: number };
  attendancePeriod: { lateArrivals: number; lateHours: number; overtimeHours: number; approvedOvertimeHours: number; absences: number; absenteeismRate: number };
  attendanceTrend: { date: string; present: number; late: number; absent: number; onLeave: number; absenteeismRate: number }[];
  leave: { onLeaveToday: number; byType: { name?: string; nameAr?: string | null; days: number }[] };
  payroll: null | { currency: string; latest: null | { year: number; month: number; totalGross: string; totalNet: string; totalEmployerCost: string; employeeCount: number }; trend: { month: string; gross: number; net: number; employerCost: number }[]; byDepartment: { name: string; cost: number }[]; salaryDistribution: { band: string; count: number }[]; averageBasic: number | null };
  expirations: { contracts: (Person & { contractEndDate: string })[]; documents: { id: string; title: string; expiryDate: string; employee: Person }[]; probations: (Person & { probationEndDate: string })[]; expiredDocuments: number };
  approvals: { pending: number; byType: { type: string; count: number }[] };
  events: { holidays: { id: string; date: string; name: string; nameAr: string | null }[]; leavesStarting: { id: string; startDate: string; endDate: string; leaveType: { name: string; nameAr: string | null }; employee: Person }[]; birthdays: (Person & { date: string })[] };
  workforce: { budgeted: number; openPositions: number };
}

const monthLabel = (m: string) => {
  const [y, mo] = m.split('-').map(Number);
  return fmtMonth(y, mo).replace(/\s\d{4}$/, '').slice(0, 3) + ` ${String(y).slice(2)}`;
};
const named = (x: { name: string; nameAr?: string | null }) => localized(x as unknown as Record<string, unknown>, 'name');

export default function Dashboard() {
  const { t } = useTranslation();
  const { company, can, me } = useAuth();
  const [from, setFrom] = useState(monthStartIso());
  const [to, setTo] = useState(todayIso());
  const [branchId, setBranch] = useState<string | null>(null);
  const [departmentId, setDept] = useState<string | null>(null);
  const [managerId, setManager] = useState<string | null>(null);
  const [status, setStatus] = useState('');
  const [leaveOpen, setLeaveOpen] = useState(false);
  const [showFilters, setShowFilters] = useState(() => typeof window === 'undefined' || window.innerWidth >= 768);
  const { data, isLoading, isFetching, error, refetch } = useGet<DashboardData>('/dashboard', { from, to, branchId, departmentId, managerId, status: status || undefined, companyId: company?.id });
  const filtered = !!(branchId || departmentId || managerId || status || from !== monthStartIso() || to !== todayIso());
  const reset = () => {
    setFrom(monthStartIso());
    setTo(todayIso());
    setBranch(null);
    setDept(null);
    setManager(null);
    setStatus('');
  };

  const actions: { to?: string; onClick?: () => void; label: string; icon: ReactNode; show: boolean }[] = [
    { to: '/employees?new=1', label: t('dashboard.qa.addEmployee'), icon: <UserPlus />, show: can('employee.create') },
    { onClick: () => setLeaveOpen(true), label: t('dashboard.qa.requestLeave'), icon: <CalendarPlus />, show: !!me?.employee && can('leave.request') },
    { to: '/approvals', label: t('dashboard.qa.approvals'), icon: <CheckSquare />, show: can('approval.act') },
    { to: '/payroll', label: t('dashboard.qa.payroll'), icon: <Wallet />, show: can('payroll.read') },
    { to: '/attendance', label: t('dashboard.qa.attendance'), icon: <Clock />, show: can('attendance.read') },
    { to: '/reports', label: t('dashboard.qa.reports'), icon: <BarChart3 />, show: can('report.read') },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        icon={<PageIcon />}
        title={t('dashboard.title')}
        subtitle={t('dashboard.subtitle')}
        actions={
          <>
            {filtered && (
              <Button variant="ghost" icon={<RotateCcw className="h-4 w-4" />} onClick={reset}>
                {t('common.reset')}
              </Button>
            )}
            <Button icon={<SlidersHorizontal className="h-4 w-4" />} onClick={() => setShowFilters(!showFilters)} aria-expanded={showFilters}>
              {t('dashboard.filters')}
            </Button>
          </>
        }
      />

      {/* Quick actions */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 2xl:grid-cols-6">
        {actions
          .filter((a) => a.show)
          .map((a) => {
            const inner = (
              <>
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary-soft text-primary transition-colors group-hover:bg-primary group-hover:text-white [&_svg]:h-[18px] [&_svg]:w-[18px]">{a.icon}</span>
                <span className="min-w-0 flex-1 text-sm font-medium leading-tight text-ink sm:truncate">{a.label}</span>
                <ChevronRight className="hidden h-4 w-4 shrink-0 text-ink-3 rtl:rotate-180 sm:block" aria-hidden />
              </>
            );
            const cls = 'group flex flex-col items-start gap-2 rounded-xl sm:flex-row sm:items-center sm:gap-3 border border-line bg-surface p-3 shadow-card transition-shadow hover:shadow-lift focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40';
            return a.to ? (
              <Link key={a.label} to={a.to} className={cls}>
                {inner}
              </Link>
            ) : (
              <button key={a.label} onClick={a.onClick} className={cn(cls, 'text-start')}>
                {inner}
              </button>
            );
          })}
      </div>

      {showFilters && (
        <Card padded={false} className="p-4">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
            <Field label={t('common.from')} htmlFor="df">
              <Input id="df" type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} />
            </Field>
            <Field label={t('common.to')} htmlFor="dt">
              <Input id="dt" type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} />
            </Field>
            <Field label={t('common.branch')}>
              <OrgSelect entity="branches" value={branchId} onChange={setBranch} placeholder={t('common.all')} />
            </Field>
            <Field label={t('common.department')}>
              <OrgSelect entity="departments" value={departmentId} onChange={setDept} placeholder={t('common.all')} />
            </Field>
            <Field label={t('common.manager')}>
              <EmployeePicker value={managerId} onChange={(id) => setManager(id)} placeholder={t('common.all')} />
            </Field>
            <Field label={t('common.status')}>
              <Select value={status} onChange={(e) => setStatus(e.target.value)} placeholder={t('dashboard.currentStaff')}>
                {['ACTIVE', 'PROBATION', 'SUSPENDED', 'RESIGNED', 'TERMINATED', 'RETIRED'].map((s) => (
                  <option key={s} value={s}>
                    {t(`status.${s}`)}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
        </Card>
      )}

      {error ? (
        <ErrorState error={error} onRetry={() => refetch()} />
      ) : isLoading || !data ? (
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} className="h-32 rounded-xl" />
          ))}
        </div>
      ) : (
        <div className={cn('space-y-6 transition-opacity', isFetching && 'opacity-70')} aria-busy={isFetching}>
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            <StatTile tone="navy" label={t('dashboard.headcount')} value={fmtNumber(data.headcount.current)} caption={t('dashboard.activeProbation', { active: data.headcount.active, probation: data.headcount.probation })} icon={<Users />} />
            <StatTile tone="success" label={t('dashboard.newHires')} value={fmtNumber(data.movement.hires)} caption={t('dashboard.inPeriod')} icon={<UserPlus />} />
            <StatTile tone="warning" label={t('dashboard.turnover')} value={fmtPercent(data.movement.turnoverRate)} caption={t('dashboard.separations', { count: data.movement.separations })} icon={<UserMinus />} />
            <StatTile tone="primary" label={t('dashboard.openPositions')} value={fmtNumber(data.workforce.openPositions)} caption={t('dashboard.ofBudgeted', { count: data.workforce.budgeted })} icon={<Briefcase />} />
            <StatTile tone="success" label={t('dashboard.presentToday')} value={fmtNumber(data.attendanceToday.present)} caption={t('dashboard.lateToday', { count: data.attendanceToday.late })} icon={<Clock />} />
            <StatTile tone="danger" label={t('dashboard.absentToday')} value={fmtNumber(data.attendanceToday.absent)} caption={t('dashboard.absenteeism', { rate: fmtPercent(data.attendancePeriod.absenteeismRate) })} icon={<AlertTriangle />} />
            <StatTile tone="info" label={t('dashboard.onLeaveToday')} value={fmtNumber(data.leave.onLeaveToday)} caption={t('dashboard.notRecorded', { count: data.attendanceToday.notRecorded })} icon={<CalendarClock />} />
            <StatTile tone="primary" label={t('dashboard.overtimeHours')} value={fmtNumber(data.attendancePeriod.overtimeHours, 1)} caption={t('dashboard.lateArrivals', { count: data.attendancePeriod.lateArrivals })} icon={<TrendingUp />} />
          </div>

          <div className="grid gap-6 xl:grid-cols-3">
            <ChartCard
              className="xl:col-span-2"
              title={t('dashboard.attendanceTrend')}
              subtitle={t('dashboard.attendanceTrendHint', { rate: fmtPercent(data.attendancePeriod.absenteeismRate) })}
              empty={!data.attendanceTrend.length}
              table={{ columns: [t('common.date'), t('status.PRESENT'), t('status.LATE'), t('status.ABSENT'), t('status.ON_LEAVE'), t('dashboard.absenteeismRate')], rows: data.attendanceTrend.map((d) => [fmtDateShort(d.date), d.present, d.late, d.absent, d.onLeave, fmtPercent(d.absenteeismRate)]) }}
            >
              <ColumnChart
                data={data.attendanceTrend}
                x="date"
                xFormat={(d) => fmtDateShort(d)}
                bars={[
                  { key: 'absent', label: t('status.ABSENT'), slot: 1 },
                  { key: 'late', label: t('status.LATE'), slot: 2 },
                ]}
                format={(v) => fmtNumber(v)}
              />
            </ChartCard>
            <Card>
              <CardHeader title={t('dashboard.pendingApprovals')} subtitle={t('dashboard.pendingTotal', { count: data.approvals.pending })} actions={<Link to="/approvals" className="text-sm font-medium text-primary-ink hover:underline">{t('common.viewAll')}</Link>} />
              {data.approvals.byType.length === 0 ? (
                <p className="py-6 text-center text-sm text-ink-3">{t('dashboard.allClear')}</p>
              ) : (
                <ul className="space-y-2">
                  {data.approvals.byType.map((b) => (
                    <li key={b.type}>
                      <Link to="/approvals" className="flex items-center justify-between rounded-lg border border-line px-3 py-2.5 text-sm hover:border-primary/40 hover:bg-primary-soft/40">
                        <span className="font-medium">{t(`requestType.${b.type}`)}</span>
                        <Badge tone="warning">{b.count}</Badge>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>

          <div className="grid gap-6 xl:grid-cols-2">
            <ChartCard title={t('dashboard.headcountTrend')} subtitle={t('dashboard.last12')} table={{ columns: [t('common.month'), t('dashboard.headcount')], rows: data.headcount.trend.map((p) => [monthLabel(p.month), p.headcount]) }}>
              <LineSeriesChart data={data.headcount.trend} x="month" xFormat={monthLabel} lines={[{ key: 'headcount', label: t('dashboard.headcount'), slot: 1 }]} format={(v) => fmtNumber(v)} />
            </ChartCard>
            <ChartCard title={t('dashboard.hiresSeparations')} subtitle={t('dashboard.last12')} table={{ columns: [t('common.month'), t('dashboard.hires'), t('dashboard.separationsLabel')], rows: data.headcount.trend.map((p) => [monthLabel(p.month), p.hires, p.separations]) }}>
              <ColumnChart
                data={data.headcount.trend}
                x="month"
                xFormat={monthLabel}
                bars={[
                  { key: 'hires', label: t('dashboard.hires'), slot: 1 },
                  { key: 'separations', label: t('dashboard.separationsLabel'), slot: 2 },
                ]}
                format={(v) => fmtNumber(v)}
              />
            </ChartCard>
          </div>

          <div className="grid gap-6 lg:grid-cols-3">
            <ChartCard title={t('dashboard.byDepartment')} empty={!data.headcount.byDepartment.length} table={{ columns: [t('common.department'), t('dashboard.headcount')], rows: data.headcount.byDepartment.map((d) => [named(d), d.count]) }}>
              <BarList items={data.headcount.byDepartment.map((d) => ({ label: named(d), value: d.count }))} format={(v) => fmtNumber(v)} />
            </ChartCard>
            <ChartCard title={t('dashboard.byBranch')} empty={!data.headcount.byBranch.length} table={{ columns: [t('common.branch'), t('dashboard.headcount')], rows: data.headcount.byBranch.map((d) => [named(d), d.count]) }}>
              <BarList items={data.headcount.byBranch.map((d) => ({ label: named(d), value: d.count }))} format={(v) => fmtNumber(v)} />
            </ChartCard>
            <ChartCard title={t('dashboard.byPosition')} subtitle={t('dashboard.top10')} empty={!data.headcount.byPosition.length} table={{ columns: [t('common.position'), t('dashboard.headcount')], rows: data.headcount.byPosition.map((d) => [named(d), d.count]) }}>
              <BarList items={data.headcount.byPosition.map((d) => ({ label: named(d), value: d.count }))} format={(v) => fmtNumber(v)} />
            </ChartCard>
          </div>

          {data.payroll && (
            <div className="grid gap-6 xl:grid-cols-3">
              <ChartCard
                className="xl:col-span-2"
                title={t('dashboard.payrollTrend')}
                subtitle={data.payroll.latest ? t('dashboard.latestRun', { month: fmtMonth(data.payroll.latest.year, data.payroll.latest.month), amount: fmtMoney(data.payroll.latest.totalEmployerCost, data.payroll.currency) }) : undefined}
                empty={!data.payroll.trend.length}
                table={{ columns: [t('common.month'), t('payroll.gross'), t('payroll.net'), t('payroll.employerCost')], rows: data.payroll.trend.map((p) => [monthLabel(p.month), fmtMoney(p.gross, data.payroll!.currency), fmtMoney(p.net, data.payroll!.currency), fmtMoney(p.employerCost, data.payroll!.currency)]) }}
              >
                <LineSeriesChart
                  data={data.payroll.trend}
                  x="month"
                  xFormat={monthLabel}
                  format={(v) => fmtMoney(v, data.payroll!.currency)}
                  lines={[
                    { key: 'employerCost', label: t('payroll.employerCost'), slot: 1 },
                    { key: 'gross', label: t('payroll.gross'), slot: 2 },
                    { key: 'net', label: t('payroll.net'), slot: 3 },
                  ]}
                />
              </ChartCard>
              <ChartCard title={t('dashboard.payrollByDepartment')} empty={!data.payroll.byDepartment.length} table={{ columns: [t('common.department'), t('payroll.employerCost')], rows: data.payroll.byDepartment.map((d) => [d.name, fmtMoney(d.cost, data.payroll!.currency)]) }}>
                <BarList items={data.payroll.byDepartment.map((d) => ({ label: d.name, value: d.cost }))} format={(v) => fmtMoney(v, data.payroll!.currency, { compact: true })} />
              </ChartCard>
            </div>
          )}

          <div className="grid gap-6 lg:grid-cols-3">
            {data.payroll && (
              <ChartCard title={t('dashboard.salaryDistribution')} subtitle={data.payroll.averageBasic ? t('dashboard.averageBasic', { amount: fmtMoney(data.payroll.averageBasic, data.payroll.currency) }) : undefined} empty={!data.payroll.salaryDistribution.length} table={{ columns: [t('dashboard.band'), t('dashboard.employees')], rows: data.payroll.salaryDistribution.map((b) => [b.band, b.count]) }}>
                <ColumnChart data={data.payroll.salaryDistribution} x="band" bars={[{ key: 'count', label: t('dashboard.employees'), slot: 1 }]} format={(v) => fmtNumber(v)} />
              </ChartCard>
            )}
            <ChartCard title={t('dashboard.leaveByType')} subtitle={t('dashboard.daysInPeriod')} empty={!data.leave.byType.length} table={{ columns: [t('leave.type'), t('leave.days')], rows: data.leave.byType.map((l) => [named({ name: l.name ?? '', nameAr: l.nameAr }), l.days]) }}>
              <BarList items={data.leave.byType.map((l) => ({ label: named({ name: l.name ?? '', nameAr: l.nameAr }), value: l.days }))} format={(v) => fmtNumber(v, v % 1 ? 1 : 0)} />
            </ChartCard>
            <ChartCard
              title={t('dashboard.attendanceToday')}
              table={{ columns: [t('common.status'), t('dashboard.employees')], rows: [[t('status.PRESENT'), data.attendanceToday.present], [t('status.LATE'), data.attendanceToday.late], [t('status.ABSENT'), data.attendanceToday.absent], [t('status.ON_LEAVE'), data.attendanceToday.onLeave], [t('status.MISSED_PUNCH'), data.attendanceToday.missedPunch], [t('dashboard.notRecordedLabel'), data.attendanceToday.notRecorded]] }}
            >
              <BarList
                max={data.headcount.current || 1}
                items={[
                  { label: t('status.PRESENT'), value: data.attendanceToday.present },
                  { label: t('status.ON_LEAVE'), value: data.attendanceToday.onLeave },
                  { label: t('status.ABSENT'), value: data.attendanceToday.absent },
                  { label: t('dashboard.notRecordedLabel'), value: data.attendanceToday.notRecorded },
                ]}
                format={(v) => `${fmtNumber(v)} · ${fmtPercent(data.headcount.current ? v / data.headcount.current : 0, 0)}`}
              />
            </ChartCard>
          </div>

          <div className="grid gap-6 lg:grid-cols-2 xl:grid-cols-4">
            <Card>
              <CardHeader title={t('dashboard.upcomingEvents')} subtitle={t('dashboard.next30')} />
              <EventList
                items={[
                  ...data.events.holidays.map((h) => ({ key: `h${h.id}`, icon: <PartyPopper />, tone: 'bg-primary-soft text-primary', title: named(h), date: h.date })),
                  ...data.events.leavesStarting.map((l) => ({ key: `l${l.id}`, icon: <CalendarDays />, tone: 'bg-info-soft text-info', title: `${personName(l.employee)} · ${named(l.leaveType)}`, date: l.startDate, href: `/employees/${l.employee.id}?tab=leave` })),
                  ...data.events.birthdays.map((b) => ({ key: `b${b.id}`, icon: <Cake />, tone: 'bg-warning-soft text-warning', title: t('dashboard.birthday', { name: personName(b) }), date: b.date, href: `/employees/${b.id}` })),
                ].sort((a, b) => a.date.localeCompare(b.date))}
              />
            </Card>
            <Card>
              <CardHeader title={t('dashboard.contractsEnding')} subtitle={t('dashboard.next60')} />
              <ExpiryList items={data.expirations.contracts.map((c) => ({ id: c.id, href: `/employees/${c.id}`, title: personName(c), date: c.contractEndDate }))} />
            </Card>
            <Card>
              <CardHeader title={t('dashboard.documentsExpiring')} subtitle={t('dashboard.next60')} actions={data.expirations.expiredDocuments > 0 && <Badge tone="danger">{t('dashboard.expired', { count: data.expirations.expiredDocuments })}</Badge>} />
              <ExpiryList items={data.expirations.documents.map((d) => ({ id: d.id, href: `/employees/${d.employee.id}?tab=documents`, title: `${d.title} · ${personName(d.employee)}`, date: d.expiryDate }))} />
            </Card>
            <Card>
              <CardHeader title={t('dashboard.probationsEnding')} subtitle={t('dashboard.next60')} />
              <ExpiryList items={data.expirations.probations.map((p) => ({ id: p.id, href: `/employees/${p.id}`, title: personName(p), date: p.probationEndDate }))} />
            </Card>
          </div>
          <p className="text-xs text-ink-3">{t('dashboard.footnote', { from: fmtDate(data.filters.from), to: fmtDate(data.filters.to), compact: fmtCompact(data.headcount.total) })}</p>
        </div>
      )}
      <LeaveRequestDialog open={leaveOpen} onClose={() => setLeaveOpen(false)} />
    </div>
  );
}

function EventList({ items }: { items: { key: string; icon: ReactNode; tone: string; title: string; date: string; href?: string }[] }) {
  const { t } = useTranslation();
  if (!items.length) return <p className="py-6 text-center text-sm text-ink-3">{t('dashboard.noEvents')}</p>;
  return (
    <ul className="space-y-2.5">
      {items.slice(0, 7).map((i) => {
        const body = (
          <>
            <span className={cn('flex h-8 w-8 shrink-0 items-center justify-center rounded-lg [&_svg]:h-4 [&_svg]:w-4', i.tone)}>{i.icon}</span>
            <span className="min-w-0 flex-1 truncate text-sm">{i.title}</span>
            <span className="shrink-0 text-xs font-medium text-ink-3">{fmtDateShort(i.date)}</span>
          </>
        );
        return (
          <li key={i.key}>
            {i.href ? (
              <Link to={i.href} className="flex items-center gap-3 rounded-lg hover:text-primary-ink">
                {body}
              </Link>
            ) : (
              <div className="flex items-center gap-3">{body}</div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function ExpiryList({ items }: { items: { id: string; href: string; title: string; date: string }[] }) {
  const { t } = useTranslation();
  if (!items.length) return <p className="py-6 text-center text-sm text-ink-3">{t('dashboard.nothingDue')}</p>;
  return (
    <ul className="divide-y divide-line">
      {items.map((i) => {
        const days = Math.round((new Date(i.date).getTime() - Date.now()) / 86_400_000);
        return (
          <li key={i.id + i.title}>
            <Link to={i.href} className="flex items-center justify-between gap-3 py-2 text-sm hover:text-primary-ink">
              <span className="flex min-w-0 items-center gap-2">
                <FileWarning className="h-4 w-4 shrink-0 text-ink-3" aria-hidden />
                <span className="truncate">{i.title}</span>
              </span>
              <span className={cn('shrink-0 rounded-full px-2 py-0.5 text-xs font-medium', days <= 14 ? 'bg-danger-soft text-danger-ink' : 'bg-subtle text-ink-2')}>{t('dashboard.inDays', { count: Math.max(0, days) })}</span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
