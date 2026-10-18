import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { CalendarPlus, CheckSquare, Clock, LogIn, LogOut, Megaphone, Receipt, Wrench } from 'lucide-react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useApiMutation, useGet } from '@/lib/hooks';
import { localized, personName } from '@/lib/i18n';
import { fmtDate, fmtMinutes, fmtMoney, fmtMonth, fmtNumber, fmtTime, relativeTime } from '@/lib/format';
import { todayIso } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Badge, Card, CardHeader, EmptyState, StatusBadge } from '@/components/ui/display';
import { LeaveRequestDialog } from './leave/LeaveRequestDialog';
import { CorrectionDialog } from './attendance/Attendance';

interface TodayRecord {
  date: string;
  checkIn: string | null;
  checkOut: string | null;
  status: string;
  workedMinutes: number;
  lateMinutes: number;
}
interface Balance {
  id: string;
  available: number;
  used: string;
  pending: string;
  leaveType: { name: string; nameAr: string | null; color: string; code: string };
}

export default function Home() {
  const { t, i18n } = useTranslation();
  const { me, can } = useAuth();
  const [leaveOpen, setLeaveOpen] = useState(false);
  const [corrOpen, setCorrOpen] = useState(false);
  const hasEmployee = !!me?.employee;
  const { data: today } = useGet<TodayRecord | null>(hasEmployee && can('attendance.self') ? '/attendance/today' : null);
  const { data: balances = [] } = useGet<Balance[]>(hasEmployee ? '/leave/balances' : null);
  const { data: myRequests } = useGet<{ items: { id: string; title: string; status: string; createdAt: string; requestType: string }[] }>('/approvals/requests', { view: 'mine', pageSize: 5 });
  const { data: inbox } = useGet<{ count: number }>(can('approval.act') ? '/approvals/inbox/count' : null);
  const { data: announcements = [] } = useGet<{ id: string; title: string; body: string; publishedAt: string }[]>('/announcements');
  const { data: payslips = [] } = useGet<{ id: string; netPay: string; currency: string; run: { year: number; month: number } }[]>(hasEmployee && can('payslip.self') ? '/payroll/my-payslips' : null);

  const isToday = today && today.date.slice(0, 10) === todayIso();
  const checkedIn = isToday && today?.checkIn;
  const punch = useApiMutation(
    async () => {
      let coords: { lat?: number; lng?: number } = {};
      const mobile = /Mobi|Android/i.test(navigator.userAgent);
      if (mobile && navigator.geolocation) {
        coords = await new Promise((resolve) =>
          navigator.geolocation.getCurrentPosition((p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude }), () => resolve({}), { timeout: 8000 }),
        );
      }
      return api.post<{ action: string }>('/attendance/punch', { source: mobile ? 'MOBILE' : 'WEB', ...coords });
    },
    { success: (r) => (r.action === 'CHECK_IN' ? t('home.checkedIn') : t('home.checkedOut')), invalidate: ['/attendance'] },
  );

  const hour = new Date().getHours();
  const greeting = hour < 12 ? t('home.morning') : hour < 18 ? t('home.afternoon') : t('home.evening');

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-sm text-ink-3">{fmtDate(new Date(), { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}</p>
          <h1 className="text-2xl font-semibold">
            {greeting}
            {i18n.language === 'ar' ? '، ' : ', '}
            {me?.employee ? (localized(me.employee as unknown as Record<string, unknown>, 'firstName') || me.employee.firstName) : me?.displayName}
          </h1>
          {me?.employee && (
            <p className="mt-1 text-sm text-ink-3">
              {[localized(me.employee.position as unknown as Record<string, unknown>, 'title'), localized(me.employee.department as unknown as Record<string, unknown>, 'name')].filter(Boolean).join(' · ')}
            </p>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          {hasEmployee && can('leave.request') && (
            <Button variant="primary" icon={<CalendarPlus className="h-4 w-4" />} onClick={() => setLeaveOpen(true)}>
              {t('home.requestLeave')}
            </Button>
          )}
          {hasEmployee && can('attendance.self') && (
            <Button icon={<Wrench className="h-4 w-4" />} onClick={() => setCorrOpen(true)}>
              {t('attendance.requestCorrection')}
            </Button>
          )}
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        {hasEmployee && can('attendance.self') && (
          <Card>
            <CardHeader title={t('home.todayAttendance')} actions={<Clock className="h-5 w-5 text-ink-3" />} />
            <div className="flex items-end justify-between gap-4">
              <div className="space-y-1 text-sm">
                <p>
                  <span className="text-ink-3">{t('attendance.checkIn')}:</span> <span className="font-medium tabular">{isToday ? fmtTime(today?.checkIn) : '—'}</span>
                </p>
                <p>
                  <span className="text-ink-3">{t('attendance.checkOut')}:</span> <span className="font-medium tabular">{isToday ? fmtTime(today?.checkOut) : '—'}</span>
                </p>
                {isToday && today && today.workedMinutes > 0 && (
                  <p>
                    <span className="text-ink-3">{t('attendance.worked')}:</span> <span className="font-medium">{fmtMinutes(today.workedMinutes)}</span>
                  </p>
                )}
                {isToday && today && <StatusBadge status={today.status} />}
              </div>
              <Button size="lg" variant={checkedIn ? 'secondary' : 'success'} loading={punch.isPending} icon={checkedIn ? <LogOut className="h-4 w-4" /> : <LogIn className="h-4 w-4" />} onClick={() => punch.mutate(undefined)}>
                {checkedIn ? t('home.checkOut') : t('home.checkIn')}
              </Button>
            </div>
          </Card>
        )}

        {hasEmployee && (
          <Card>
            <CardHeader title={t('home.leaveBalances')} actions={<Link to="/leave" className="text-sm text-primary-ink hover:underline">{t('common.viewAll')}</Link>} />
            {balances.filter((b) => b.leaveType.code !== 'UNPAID').length === 0 && <p className="text-sm text-ink-3">{t('home.noBalances')}</p>}
            <ul className="space-y-3">
              {balances.slice(0, 4).map((b) => (
                <li key={b.id} className="flex items-center justify-between gap-3 text-sm">
                  <span className="flex items-center gap-2">
                    <span className="h-2.5 w-2.5 rounded-full" style={{ background: b.leaveType.color }} aria-hidden />
                    {localized(b.leaveType as unknown as Record<string, unknown>, 'name')}
                  </span>
                  <span className="tabular">
                    <span className="font-semibold">{fmtNumber(b.available, b.available % 1 ? 1 : 0)}</span> <span className="text-ink-3">{t('leave.daysLeft')}</span>
                  </span>
                </li>
              ))}
            </ul>
          </Card>
        )}

        <Card>
          <CardHeader title={t('home.myRequests')} actions={can('approval.act') && !!inbox?.count && <Link to="/approvals"><Badge tone="warning">{t('home.toApprove', { count: inbox.count })}</Badge></Link>} />
          {!myRequests?.items.length ? (
            <p className="text-sm text-ink-3">{t('home.noRequests')}</p>
          ) : (
            <ul className="divide-y divide-line">
              {myRequests.items.map((r) => (
                <li key={r.id}>
                  <Link to={`/approvals/${r.id}`} className="flex items-center justify-between gap-3 py-2 text-sm hover:text-primary-ink">
                    <span className="min-w-0">
                      <span className="block truncate">{r.title}</span>
                      <span className="text-xs text-ink-3">{relativeTime(r.createdAt)}</span>
                    </span>
                    <StatusBadge status={r.status} />
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader title={t('nav.announcements')} actions={<Megaphone className="h-5 w-5 text-ink-3" />} />
          {!announcements.length ? (
            <EmptyState title={t('announcements.none')} />
          ) : (
            <ul className="space-y-4">
              {announcements.slice(0, 3).map((a) => (
                <li key={a.id} className="border-s-2 border-primary/60 ps-4">
                  <p className="font-medium">{a.title}</p>
                  <p className="mt-1 line-clamp-3 whitespace-pre-line text-sm text-ink-2">{a.body}</p>
                  <p className="mt-1 text-xs text-ink-3">{fmtDate(a.publishedAt)}</p>
                </li>
              ))}
            </ul>
          )}
        </Card>
        {hasEmployee && can('payslip.self') && (
          <Card>
            <CardHeader title={t('home.latestPayslip')} actions={<Receipt className="h-5 w-5 text-ink-3" />} />
            {payslips[0] ? (
              <div>
                <p className="text-sm text-ink-3">{fmtMonth(payslips[0].run.year, payslips[0].run.month)}</p>
                <p className="mt-1 text-3xl font-semibold tabular">{fmtMoney(payslips[0].netPay, payslips[0].currency)}</p>
                <p className="text-xs text-ink-3">{t('payroll.netPay')}</p>
                <Link to="/me/payslips" className="mt-4 inline-block text-sm text-primary-ink hover:underline">
                  {t('home.viewPayslips')}
                </Link>
              </div>
            ) : (
              <p className="text-sm text-ink-3">{t('home.noPayslips')}</p>
            )}
          </Card>
        )}
        {!hasEmployee && (
          <Card>
            <CardHeader title={t('home.quickLinks')} actions={<CheckSquare className="h-5 w-5 text-ink-3" />} />
            <ul className="space-y-2 text-sm">
              {can('dashboard.read') && <li><Link className="text-primary-ink hover:underline" to="/dashboard">{t('nav.dashboard')}</Link></li>}
              {can('employee.read') && <li><Link className="text-primary-ink hover:underline" to="/employees">{t('nav.employees')}</Link></li>}
              {can('payroll.read') && <li><Link className="text-primary-ink hover:underline" to="/payroll">{t('nav.payroll')}</Link></li>}
              {can('settings.manage') && <li><Link className="text-primary-ink hover:underline" to="/admin/settings">{t('nav.settings')}</Link></li>}
            </ul>
            <p className="mt-4 text-xs text-ink-3">{t('home.noEmployeeLink', { name: me ? personName(null) || me.displayName : '' })}</p>
          </Card>
        )}
      </div>
      <LeaveRequestDialog open={leaveOpen} onClose={() => setLeaveOpen(false)} />
      <CorrectionDialog open={corrOpen} onClose={() => setCorrOpen(false)} />
    </div>
  );
}
