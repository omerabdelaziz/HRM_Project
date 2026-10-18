import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { CalendarPlus, Paperclip, Scale, UserPlus } from 'lucide-react';
import { api, download } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useApiMutation, useGet, usePaged } from '@/lib/hooks';
import { localized } from '@/lib/i18n';
import { fmtDate, fmtNumber } from '@/lib/format';
import { Button } from '@/components/ui/button';
import { Field, FormGrid, Input, SearchInput, Select } from '@/components/ui/form';
import { Card, PageHeader, StatusBadge } from '@/components/ui/display';
import { Dialog, useConfirm } from '@/components/ui/dialog';
import { Tabs } from '@/components/ui/nav';
import { Column, DataTable, Pagination } from '@/components/ui/table';
import { EmployeePicker, OrgSelect, PersonCell } from '@/components/ui/pickers';
import { LeaveRequestDialog, type LeaveType } from './LeaveRequestDialog';
import { CalendarDays as PageIcon } from 'lucide-react';

interface LeaveReq {
  id: string;
  employeeId: string;
  startDate: string;
  endDate: string;
  days: string;
  halfDay: boolean;
  status: string;
  reason: string | null;
  attachmentPath: string | null;
  createdAt: string;
  leaveType: { id: string; name: string; nameAr: string | null; color: string; code: string };
  employee: { id: string; employeeNo: string; firstName: string; lastName: string; firstNameAr: string | null; lastNameAr: string | null; department: { name: string } | null };
}
interface Balance {
  id: string;
  entitled: string;
  carriedOver: string;
  adjusted: string;
  used: string;
  pending: string;
  available: number;
  leaveType: LeaveType;
}

export default function Leave() {
  const { t } = useTranslation();
  const { me, can } = useAuth();
  const hasEmployee = !!me?.employee;
  const [tab, setTab] = useState<'mine' | 'all'>(hasEmployee ? 'mine' : 'all');
  const [requesting, setRequesting] = useState(false);
  const [onBehalf, setOnBehalf] = useState(false);
  const [adjusting, setAdjusting] = useState(false);
  return (
    <div>
      <PageHeader icon={<PageIcon />}
        title={t('nav.leave')}
        actions={
          <>
            {can('leave.read') && (
              <Link to="/leave/calendar">
                <Button>{t('nav.leaveCalendar')}</Button>
              </Link>
            )}
            {can('leave.manage') && (
              <>
                <Button icon={<Scale className="h-4 w-4" />} onClick={() => setAdjusting(true)}>
                  {t('leave.adjustBalance')}
                </Button>
                <Button icon={<UserPlus className="h-4 w-4" />} onClick={() => setOnBehalf(true)}>
                  {t('leave.recordForEmployee')}
                </Button>
              </>
            )}
            {hasEmployee && can('leave.request') && (
              <Button variant="primary" icon={<CalendarPlus className="h-4 w-4" />} onClick={() => setRequesting(true)}>
                {t('leave.newRequest')}
              </Button>
            )}
          </>
        }
      />
      <Tabs className="mb-4" value={tab} onChange={setTab} tabs={[{ id: 'mine', label: t('leave.myLeave'), hidden: !hasEmployee }, { id: 'all', label: t('leave.teamRequests'), hidden: !can('leave.read') }]} />
      {tab === 'mine' ? <MyLeave /> : <AllRequests />}
      <LeaveRequestDialog open={requesting} onClose={() => setRequesting(false)} />
      <LeaveRequestDialog open={onBehalf} onClose={() => setOnBehalf(false)} onBehalf />
      <AdjustDialog open={adjusting} onClose={() => setAdjusting(false)} />
    </div>
  );
}

function useCancel() {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const cancel = useApiMutation(({ id, reason }: { id: string; reason: string }) => api.post(`/leave/requests/${id}/cancel`, { reason }), { success: t('leave.cancelled'), invalidate: ['/leave', '/approvals', '/attendance'] });
  return async (r: LeaveReq) => {
    const res = await confirm({ title: t('leave.cancelTitle'), message: `${localized(r.leaveType as unknown as Record<string, unknown>, 'name')} · ${fmtDate(r.startDate)} – ${fmtDate(r.endDate)}`, tone: 'danger', confirmLabel: t('leave.cancelRequest'), reason: { label: t('leave.reason') } });
    if (res) cancel.mutate({ id: r.id, reason: res.reason });
  };
}

function requestColumns(t: (k: string, o?: Record<string, unknown>) => string, opts: { withEmployee: boolean; onCancel: (r: LeaveReq) => void; canCancel: (r: LeaveReq) => boolean }): Column<LeaveReq>[] {
  return [
    ...(opts.withEmployee ? [{ key: 'emp', header: t('common.employee'), cell: (r: LeaveReq) => <PersonCell employee={r.employee} sub={r.employee.department?.name} /> }] : []),
    {
      key: 'type',
      header: t('leave.type'),
      cell: (r) => (
        <span className="inline-flex items-center gap-2">
          <span className="h-2.5 w-2.5 rounded-full" style={{ background: r.leaveType.color }} aria-hidden />
          {localized(r.leaveType as unknown as Record<string, unknown>, 'name')}
          {r.attachmentPath && (
            <button onClick={(e) => (e.stopPropagation(), download(`/leave/requests/${r.id}/attachment`))} aria-label={t('leave.attachment')} className="text-ink-3 hover:text-ink">
              <Paperclip className="h-3.5 w-3.5" />
            </button>
          )}
        </span>
      ),
    },
    { key: 'dates', header: t('leave.dates'), sort: 'startDate', cell: (r) => (r.startDate === r.endDate ? fmtDate(r.startDate) : `${fmtDate(r.startDate)} – ${fmtDate(r.endDate)}`) },
    { key: 'days', header: t('leave.days'), sort: 'days', align: 'end', cell: (r) => `${fmtNumber(Number(r.days), Number(r.days) % 1 ? 1 : 0)}${r.halfDay ? ` (${t('leave.half')})` : ''}` },
    { key: 'reason', header: t('leave.reason'), hideBelow: 'lg', cell: (r) => <span className="line-clamp-1 text-ink-2">{r.reason ?? '—'}</span> },
    { key: 'submitted', header: t('leave.submittedOn'), sort: 'createdAt', hideBelow: 'md', cell: (r) => fmtDate(r.createdAt) },
    { key: 'status', header: t('common.status'), sort: 'status', cell: (r) => <StatusBadge status={r.status} /> },
    {
      key: 'actions',
      header: '',
      align: 'end',
      cell: (r) =>
        opts.canCancel(r) && (
          <Button size="sm" variant="ghost" onClick={() => opts.onCancel(r)}>
            {t('common.cancel')}
          </Button>
        ),
    },
  ];
}

function MyLeave() {
  const { t } = useTranslation();
  const year = new Date().getFullYear();
  const [y, setY] = useState(year);
  const { data: balances = [] } = useGet<Balance[]>('/leave/balances', { year: y });
  const list = usePaged<LeaveReq>('/leave/requests', { mine: 'true' }, { sort: 'startDate:desc', pageSize: 10 });
  const cancel = useCancel();
  const today = new Date().toISOString().slice(0, 10);
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="font-semibold">{t('leave.balances')}</h2>
        <Select value={y} onChange={(e) => setY(Number(e.target.value))} className="w-28" aria-label={t('common.year')}>
          {[year - 1, year, year + 1].map((x) => (
            <option key={x} value={x}>
              {x}
            </option>
          ))}
        </Select>
      </div>
      <div className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-5">
        {balances.map((b) => {
          const total = Number(b.entitled) + Number(b.carriedOver) + Number(b.adjusted);
          const usedPct = total ? Math.min(100, ((Number(b.used) + Number(b.pending)) / total) * 100) : 0;
          return (
            <Card key={b.id}>
              <p className="flex items-center gap-2 text-sm text-ink-2">
                <span className="h-2.5 w-2.5 rounded-full" style={{ background: b.leaveType.color }} aria-hidden />
                {localized(b.leaveType as unknown as Record<string, unknown>, 'name')}
              </p>
              {b.leaveType.accrualMethod === 'NONE' ? (
                <>
                  <p className="mt-2 text-2xl font-semibold">{fmtNumber(Number(b.used))}</p>
                  <p className="text-xs text-ink-3">{t('leave.daysTaken')}</p>
                </>
              ) : (
                <>
                  <p className="mt-2 text-2xl font-semibold tabular">
                    {fmtNumber(b.available, b.available % 1 ? 1 : 0)} <span className="text-sm font-normal text-ink-3">/ {fmtNumber(total, total % 1 ? 1 : 0)}</span>
                  </p>
                  <div className="mt-2 h-1.5 rounded-full bg-primary-soft" aria-hidden>
                    <div className="h-full rounded-full bg-primary" style={{ width: `${usedPct}%` }} />
                  </div>
                  <p className="mt-1.5 text-xs text-ink-3">{t('leave.usedPending', { used: fmtNumber(Number(b.used), 1), pending: fmtNumber(Number(b.pending), 1) })}</p>
                </>
              )}
            </Card>
          );
        })}
      </div>
      <Card padded={false}>
        <div className="border-b border-line p-4">
          <h2 className="font-semibold">{t('leave.myRequests')}</h2>
        </div>
        <DataTable
          columns={requestColumns(t, { withEmployee: false, onCancel: cancel, canCancel: (r) => r.status === 'PENDING' || (r.status === 'APPROVED' && r.startDate.slice(0, 10) > today) })}
          rows={list.data?.items}
          rowKey={(r) => r.id}
          loading={list.isLoading}
          sort={list.sort}
          onSort={list.setSort}
          empty={{ title: t('leave.noRequests') }}
        />
        {list.data && <Pagination page={list.page} pageCount={list.data.pageCount} total={list.data.total} pageSize={list.pageSize} onPage={list.setPage} />}
      </Card>
    </div>
  );
}

function AllRequests() {
  const { t } = useTranslation();
  const { can } = useAuth();
  const [status, setStatus] = useState('PENDING');
  const [leaveTypeId, setType] = useState('');
  const [departmentId, setDept] = useState<string | null>(null);
  const { data: types = [] } = useGet<LeaveType[]>('/leave/types');
  const list = usePaged<LeaveReq>('/leave/requests', { status: status || undefined, leaveTypeId: leaveTypeId || undefined, departmentId }, { sort: 'startDate:asc' });
  const cancel = useCancel();
  return (
    <Card padded={false}>
      <div className="flex flex-col gap-3 border-b border-line p-4 lg:flex-row lg:items-center">
        <SearchInput className="lg:max-w-xs flex-1" placeholder={t('employees.searchPlaceholder')} value={list.search} onChange={(e) => list.setSearch(e.target.value)} />
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3 lg:flex">
          <Select value={status} onChange={(e) => setStatus(e.target.value)} placeholder={t('attendance.allStatuses')} aria-label={t('common.status')}>
            {['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED'].map((s) => (
              <option key={s} value={s}>
                {t(`status.${s}`)}
              </option>
            ))}
          </Select>
          <Select value={leaveTypeId} onChange={(e) => setType(e.target.value)} placeholder={t('leave.allTypes')} aria-label={t('leave.type')}>
            {types.map((x) => (
              <option key={x.id} value={x.id}>
                {localized(x as unknown as Record<string, unknown>, 'name')}
              </option>
            ))}
          </Select>
          <OrgSelect entity="departments" value={departmentId} onChange={setDept} placeholder={t('employees.allDepartments')} />
        </div>
      </div>
      <DataTable
        columns={requestColumns(t, { withEmployee: true, onCancel: cancel, canCancel: (r) => can('leave.manage') && ['PENDING', 'APPROVED'].includes(r.status) })}
        rows={list.data?.items}
        rowKey={(r) => r.id}
        loading={list.isLoading}
        error={list.error}
        sort={list.sort}
        onSort={list.setSort}
        empty={{ title: t('leave.noRequests') }}
      />
      {list.data && <Pagination page={list.page} pageCount={list.data.pageCount} total={list.data.total} pageSize={list.pageSize} onPage={list.setPage} onPageSize={list.setPageSize} />}
    </Card>
  );
}

function AdjustDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const { data: types = [] } = useGet<LeaveType[]>('/leave/types');
  const [employeeId, setEmp] = useState<string | null>(null);
  const [leaveTypeId, setType] = useState('');
  const [year, setYear] = useState(new Date().getFullYear());
  const [delta, setDelta] = useState('');
  const [reason, setReason] = useState('');
  const save = useApiMutation(() => api.post('/leave/balances/adjust', { employeeId, leaveTypeId, year, delta: Number(delta), reason }), { success: t('leave.adjusted'), invalidate: ['/leave'], onSuccess: () => (setDelta(''), setReason(''), onClose()) });
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t('leave.adjustBalance')}
      description={t('leave.adjustHint')}
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" disabled={!employeeId || !leaveTypeId || !Number(delta) || reason.trim().length < 3} loading={save.isPending} onClick={() => save.mutate(undefined)}>
            {t('common.save')}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label={t('common.employee')} required>
          <EmployeePicker value={employeeId} onChange={(id) => setEmp(id)} />
        </Field>
        <FormGrid cols={3}>
          <Field label={t('leave.type')} required>
            <Select value={leaveTypeId} onChange={(e) => setType(e.target.value)} placeholder={t('leave.chooseType')}>
              {types.filter((x) => x.accrualMethod !== 'NONE').map((x) => (
                <option key={x.id} value={x.id}>
                  {localized(x as unknown as Record<string, unknown>, 'name')}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t('common.year')}>
            <Input type="number" value={year} onChange={(e) => setYear(Number(e.target.value))} />
          </Field>
          <Field label={t('leave.daysDelta')} required hint={t('leave.daysDeltaHint')}>
            <Input type="number" step={0.5} value={delta} onChange={(e) => setDelta(e.target.value)} />
          </Field>
        </FormGrid>
        <Field label={t('leave.reason')} required>
          <Input value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
      </div>
    </Dialog>
  );
}
