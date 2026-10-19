import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CalendarCheck, Pencil, Plus, TimerReset, Wrench } from 'lucide-react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useApiMutation, useGet, usePaged } from '@/lib/hooks';
import { personName } from '@/lib/i18n';
import { fmtDate, fmtMinutes, fmtNumber, fmtTime } from '@/lib/format';
import { addDaysIso, isoToLocalInput, localInputToIso, monthStartIso, todayIso } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Field, FormGrid, Input, SearchInput, Select, Textarea } from '@/components/ui/form';
import { Alert, Card, PageHeader, StatTile, StatusBadge } from '@/components/ui/display';
import { Dialog } from '@/components/ui/dialog';
import { Tabs } from '@/components/ui/nav';
import { Column, DataTable, Pagination } from '@/components/ui/table';
import { EmployeePicker, OrgSelect, PersonCell } from '@/components/ui/pickers';
import { Clock as PageIcon } from 'lucide-react';

interface AttRecord {
  id: string;
  employeeId: string;
  date: string;
  checkIn: string | null;
  checkOut: string | null;
  status: string;
  source: string;
  workedMinutes: number;
  lateMinutes: number;
  earlyLeaveMinutes: number;
  overtimeMinutes: number;
  notes: string | null;
  employee?: { id: string; employeeNo: string; firstName: string; lastName: string; firstNameAr: string | null; lastNameAr: string | null; department: { name: string } | null };
}

const STATUSES = ['PRESENT', 'LATE', 'ABSENT', 'HALF_DAY', 'ON_LEAVE', 'HOLIDAY', 'WEEKEND', 'MISSED_PUNCH'];
type Tab = 'mine' | 'team' | 'summary' | 'corrections' | 'overtime';

export default function Attendance() {
  const { t } = useTranslation();
  const { me, can } = useAuth();
  const hasEmployee = !!me?.employee;
  const [tab, setTab] = useState<Tab>(hasEmployee ? 'mine' : 'team');
  const [corr, setCorr] = useState(false);
  const [ot, setOt] = useState(false);
  return (
    <div>
      <PageHeader icon={<PageIcon />}
        title={t('nav.attendance')}
        subtitle={t('attendance.subtitle')}
        actions={
          hasEmployee && (
            <>
              <Button icon={<Wrench className="h-4 w-4" />} onClick={() => setCorr(true)}>
                {t('attendance.requestCorrection')}
              </Button>
              <Button icon={<TimerReset className="h-4 w-4" />} onClick={() => setOt(true)}>
                {t('attendance.requestOvertime')}
              </Button>
            </>
          )
        }
      />
      <Tabs
        className="mb-4"
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'mine', label: t('attendance.tabs.mine'), hidden: !hasEmployee },
          { id: 'team', label: t('attendance.tabs.team'), hidden: !can('attendance.read') },
          { id: 'summary', label: t('attendance.tabs.summary'), hidden: !can('attendance.read') },
          { id: 'corrections', label: t('attendance.tabs.corrections') },
          { id: 'overtime', label: t('attendance.tabs.overtime') },
        ]}
      />
      {tab === 'mine' && <Records mine />}
      {tab === 'team' && <Records />}
      {tab === 'summary' && <Summary />}
      {tab === 'corrections' && <Requests kind="corrections" />}
      {tab === 'overtime' && <Requests kind="overtime" />}
      <CorrectionDialog open={corr} onClose={() => setCorr(false)} />
      <OvertimeDialog open={ot} onClose={() => setOt(false)} />
    </div>
  );
}

function Records({ mine }: { mine?: boolean }) {
  const { t } = useTranslation();
  const { can } = useAuth();
  const [from, setFrom] = useState(mine ? monthStartIso() : addDaysIso(todayIso(), -6));
  const [to, setTo] = useState(todayIso());
  const [status, setStatus] = useState('');
  const [departmentId, setDept] = useState<string | null>(null);
  const [editing, setEditing] = useState<AttRecord | 'new' | null>(null);
  const list = usePaged<AttRecord>('/attendance/records', { mine: mine ? 'true' : undefined, from, to, status: status || undefined, departmentId }, { sort: 'date:desc', pageSize: mine ? 31 : 25 });
  const { data: summary } = useGet<{ workedMinutes: number; lateMinutes: number; overtimeMinutes: number; byStatus: Record<string, number> }[]>(mine ? '/attendance/summary' : null, { from, to });
  const s = summary?.[0];
  const canEdit = can('attendance.manage') && !mine;

  const columns: Column<AttRecord>[] = [
    ...(!mine ? [{ key: 'emp', header: t('common.employee'), cell: (r: AttRecord) => r.employee && <PersonCell employee={r.employee} sub={r.employee.department?.name} /> }] : []),
    { key: 'date', header: t('common.date'), sort: 'date', cell: (r) => fmtDate(r.date, { weekday: 'short', day: '2-digit', month: 'short' }) },
    { key: 'in', header: t('attendance.checkIn'), sort: 'checkIn', cell: (r) => <span className="tabular">{fmtTime(r.checkIn)}</span> },
    { key: 'out', header: t('attendance.checkOut'), cell: (r) => <span className="tabular">{fmtTime(r.checkOut)}</span> },
    { key: 'worked', header: t('attendance.worked'), sort: 'workedMinutes', align: 'end', hideBelow: 'sm', cell: (r) => fmtMinutes(r.workedMinutes) },
    { key: 'late', header: t('attendance.late'), sort: 'lateMinutes', align: 'end', hideBelow: 'md', cell: (r) => (r.lateMinutes ? `${r.lateMinutes}m` : '—') },
    { key: 'early', header: t('attendance.early'), align: 'end', hideBelow: 'lg', cell: (r) => (r.earlyLeaveMinutes ? `${r.earlyLeaveMinutes}m` : '—') },
    { key: 'ot', header: t('attendance.overtime'), sort: 'overtimeMinutes', align: 'end', hideBelow: 'md', cell: (r) => (r.overtimeMinutes ? fmtMinutes(r.overtimeMinutes) : '—') },
    { key: 'status', header: t('common.status'), sort: 'status', cell: (r) => <StatusBadge status={r.status} /> },
    { key: 'source', header: t('attendance.source'), hideBelow: 'lg', cell: (r) => <span className="text-xs text-ink-3">{t(`attendance.sources.${r.source}`, r.source)}</span> },
    ...(canEdit ? [{ key: 'edit', header: '', align: 'end' as const, cell: (r: AttRecord) => <Button size="icon" variant="ghost" aria-label={t('common.edit')} icon={<Pencil className="h-4 w-4" />} onClick={() => setEditing(r)} /> }] : []),
  ];

  return (
    <div className="space-y-4">
      {mine && s && (
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          <StatTile label={t('attendance.worked')} value={fmtMinutes(s.workedMinutes)} />
          <StatTile label={t('attendance.daysPresent')} value={fmtNumber((s.byStatus.PRESENT ?? 0) + (s.byStatus.LATE ?? 0) + (s.byStatus.HALF_DAY ?? 0))} caption={t('attendance.absentDays', { count: s.byStatus.ABSENT ?? 0 })} />
          <StatTile label={t('attendance.lateArrivals')} value={fmtNumber(s.byStatus.LATE ?? 0)} caption={fmtMinutes(s.lateMinutes)} />
          <StatTile label={t('attendance.overtime')} value={fmtMinutes(s.overtimeMinutes)} />
        </div>
      )}
      <Card padded={false}>
        <div className="flex flex-col gap-3 border-b border-line p-4 lg:flex-row lg:items-end">
          {!mine && <SearchInput className="lg:max-w-xs flex-1" placeholder={t('employees.searchPlaceholder')} value={list.search} onChange={(e) => list.setSearch(e.target.value)} />}
          <div className="grid flex-1 grid-cols-2 gap-3 sm:grid-cols-4">
            <Input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} aria-label={t('common.from')} />
            <Input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} aria-label={t('common.to')} />
            <Select value={status} onChange={(e) => setStatus(e.target.value)} placeholder={t('attendance.allStatuses')} aria-label={t('common.status')}>
              {STATUSES.map((x) => (
                <option key={x} value={x}>
                  {t(`status.${x}`)}
                </option>
              ))}
            </Select>
            {!mine && <OrgSelect entity="departments" value={departmentId} onChange={setDept} placeholder={t('employees.allDepartments')} />}
          </div>
          {canEdit && (
            <Button variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => setEditing('new')}>
              {t('attendance.addRecord')}
            </Button>
          )}
        </div>
        <DataTable columns={columns} rows={list.data?.items} rowKey={(r) => r.id} loading={list.isLoading} error={list.error} sort={list.sort} onSort={list.setSort} dense empty={{ title: t('attendance.none'), description: t('attendance.noneHint') }} />
        {list.data && <Pagination page={list.page} pageCount={list.data.pageCount} total={list.data.total} pageSize={list.pageSize} onPage={list.setPage} onPageSize={list.setPageSize} />}
      </Card>
      {canEdit && <RecordDialog record={editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

function RecordDialog({ record, onClose }: { record: AttRecord | 'new' | null; onClose: () => void }) {
  const { t } = useTranslation();
  const isNew = record === 'new';
  const r = record && record !== 'new' ? record : null;
  const [employeeId, setEmp] = useState<string | null>(null);
  const [date, setDate] = useState(todayIso());
  const [checkIn, setIn] = useState('');
  const [checkOut, setOut] = useState('');
  const [notes, setNotes] = useState('');
  const [last, setLast] = useState<typeof record>(null);
  if (record !== last) {
    setLast(record);
    setEmp(r?.employeeId ?? null);
    setDate(r?.date.slice(0, 10) ?? todayIso());
    setIn(isoToLocalInput(r?.checkIn));
    setOut(isoToLocalInput(r?.checkOut));
    setNotes(r?.notes ?? '');
  }
  const save = useApiMutation(() => api.put('/attendance/records', { employeeId, date, checkIn: localInputToIso(checkIn), checkOut: localInputToIso(checkOut), notes: notes || null }), { invalidate: ['/attendance'], onSuccess: onClose });
  return (
    <Dialog
      open={!!record}
      onClose={onClose}
      title={isNew ? t('attendance.addRecord') : t('attendance.editRecord')}
      description={r?.employee ? `${personName(r.employee)} · ${fmtDate(r.date)}` : undefined}
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" disabled={!employeeId} loading={save.isPending} onClick={() => save.mutate(undefined)}>
            {t('common.save')}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {isNew && (
          <FormGrid>
            <Field label={t('common.employee')} required>
              <EmployeePicker value={employeeId} onChange={(id) => setEmp(id)} />
            </Field>
            <Field label={t('common.date')} required>
              <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            </Field>
          </FormGrid>
        )}
        <FormGrid>
          <Field label={t('attendance.checkIn')}>
            <Input type="datetime-local" value={checkIn} onChange={(e) => setIn(e.target.value)} />
          </Field>
          <Field label={t('attendance.checkOut')}>
            <Input type="datetime-local" value={checkOut} min={checkIn} onChange={(e) => setOut(e.target.value)} />
          </Field>
        </FormGrid>
        <Field label={t('attendance.notes')}>
          <Input value={notes} onChange={(e) => setNotes(e.target.value)} />
        </Field>
        <p className="text-xs text-ink-3">{t('attendance.recalcHint')}</p>
      </div>
    </Dialog>
  );
}

function Summary() {
  const { t } = useTranslation();
  const [from, setFrom] = useState(monthStartIso());
  const [to, setTo] = useState(todayIso());
  const [departmentId, setDept] = useState<string | null>(null);
  const { data, isLoading } = useGet<{ employee: AttRecord['employee']; days: number; workedMinutes: number; lateMinutes: number; earlyLeaveMinutes: number; overtimeMinutes: number; byStatus: Record<string, number> }[]>('/attendance/summary', { from, to, departmentId });
  return (
    <Card padded={false}>
      <div className="grid grid-cols-1 gap-3 border-b border-line p-4 sm:grid-cols-3">
        <Input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} aria-label={t('common.from')} />
        <Input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} aria-label={t('common.to')} />
        <OrgSelect entity="departments" value={departmentId} onChange={setDept} placeholder={t('employees.allDepartments')} />
      </div>
      <DataTable
        rows={data?.filter((r) => r.employee)}
        loading={isLoading}
        rowKey={(r) => r.employee!.id}
        empty={{ title: t('attendance.none') }}
        columns={[
          { key: 'emp', header: t('common.employee'), cell: (r) => <PersonCell employee={r.employee!} sub={r.employee!.department?.name} /> },
          { key: 'present', header: t('attendance.daysPresent'), align: 'end', cell: (r) => fmtNumber((r.byStatus.PRESENT ?? 0) + (r.byStatus.LATE ?? 0) + (r.byStatus.HALF_DAY ?? 0)) },
          { key: 'absent', header: t('status.ABSENT'), align: 'end', cell: (r) => fmtNumber(r.byStatus.ABSENT ?? 0) },
          { key: 'leave', header: t('status.ON_LEAVE'), align: 'end', hideBelow: 'md', cell: (r) => fmtNumber(r.byStatus.ON_LEAVE ?? 0) },
          { key: 'late', header: t('attendance.late'), align: 'end', hideBelow: 'sm', cell: (r) => `${fmtNumber(r.byStatus.LATE ?? 0)} · ${fmtMinutes(r.lateMinutes)}` },
          { key: 'worked', header: t('attendance.worked'), align: 'end', hideBelow: 'md', cell: (r) => fmtMinutes(r.workedMinutes) },
          { key: 'ot', header: t('attendance.overtime'), align: 'end', cell: (r) => fmtMinutes(r.overtimeMinutes) },
          { key: 'missed', header: t('status.MISSED_PUNCH'), align: 'end', hideBelow: 'lg', cell: (r) => fmtNumber(r.byStatus.MISSED_PUNCH ?? 0) },
        ]}
      />
    </Card>
  );
}

function Requests({ kind }: { kind: 'corrections' | 'overtime' }) {
  const { t } = useTranslation();
  const { can } = useAuth();
  const list = usePaged<{ id: string; date: string; reason: string; status: string; minutes?: number; requestedCheckIn?: string | null; requestedCheckOut?: string | null; employee: { id: string; employeeNo: string; firstName: string; lastName: string } }>(`/attendance/${kind}`, { mine: can('attendance.read') ? undefined : 'true' }, { pageSize: 25 });
  return (
    <Card padded={false}>
      <DataTable
        rows={list.data?.items}
        loading={list.isLoading}
        rowKey={(r) => r.id}
        empty={{ title: t('attendance.noRequests'), description: t('attendance.noRequestsHint'), action: <CalendarCheck className="h-5 w-5 text-ink-3" /> }}
        columns={[
          { key: 'emp', header: t('common.employee'), cell: (r) => <PersonCell employee={r.employee} /> },
          { key: 'date', header: t('common.date'), cell: (r) => fmtDate(r.date) },
          kind === 'overtime'
            ? { key: 'hours', header: t('attendance.hours'), align: 'end', cell: (r) => fmtMinutes(r.minutes ?? 0) }
            : { key: 'times', header: t('attendance.requestedTimes'), cell: (r) => <span className="tabular">{fmtTime(r.requestedCheckIn)} – {fmtTime(r.requestedCheckOut)}</span> },
          { key: 'reason', header: t('leave.reason'), hideBelow: 'md', cell: (r) => <span className="line-clamp-1">{r.reason}</span> },
          { key: 'status', header: t('common.status'), cell: (r) => <StatusBadge status={r.status} /> },
        ]}
      />
      {list.data && <Pagination page={list.page} pageCount={list.data.pageCount} total={list.data.total} pageSize={list.pageSize} onPage={list.setPage} />}
    </Card>
  );
}

export function CorrectionDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const yesterday = addDaysIso(todayIso(), -1);
  const [date, setDate] = useState(yesterday);
  const [checkIn, setIn] = useState('');
  const [checkOut, setOut] = useState('');
  const [reason, setReason] = useState('');
  const save = useApiMutation(
    () => api.post('/attendance/corrections', { date, checkIn: checkIn ? localInputToIso(`${date}T${checkIn}`) : null, checkOut: checkOut ? localInputToIso(`${date}T${checkOut}`) : null, reason }),
    {
      success: t('attendance.correctionSubmitted'),
      invalidate: ['/attendance', '/approvals'],
      onSuccess: () => {
        setReason('');
        setIn('');
        setOut('');
        onClose();
      },
    },
  );
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t('attendance.requestCorrection')}
      description={t('attendance.correctionHint')}
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" disabled={(!checkIn && !checkOut) || reason.trim().length < 3} loading={save.isPending} onClick={() => save.mutate(undefined)}>
            {t('common.submit')}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label={t('common.date')} required>
          <Input type="date" value={date} max={todayIso()} onChange={(e) => setDate(e.target.value)} />
        </Field>
        <FormGrid>
          <Field label={t('attendance.correctCheckIn')}>
            <Input type="time" value={checkIn} onChange={(e) => setIn(e.target.value)} />
          </Field>
          <Field label={t('attendance.correctCheckOut')}>
            <Input type="time" value={checkOut} onChange={(e) => setOut(e.target.value)} />
          </Field>
        </FormGrid>
        <Field label={t('leave.reason')} required>
          <Textarea value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
      </div>
    </Dialog>
  );
}

function OvertimeDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const { me } = useAuth();
  // Managerial grades are not paid overtime; the API also refuses the request.
  const eligible = me?.employee ? (me.employee.overtimeEligible ?? me.employee.grade?.overtimeEligible ?? true) : true;
  const [date, setDate] = useState(todayIso());
  const [hours, setHours] = useState('2');
  const [reason, setReason] = useState('');
  const save = useApiMutation(() => api.post('/attendance/overtime', { date, minutes: Math.round(Number(hours) * 60), reason }), { success: t('attendance.overtimeSubmitted'), invalidate: ['/attendance', '/approvals'], onSuccess: () => (setReason(''), onClose()) });
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t('attendance.requestOvertime')}
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" disabled={!eligible || !Number(hours) || reason.trim().length < 3} loading={save.isPending} onClick={() => save.mutate(undefined)}>
            {t('common.submit')}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {!eligible && <Alert tone="warning">{t('employees.notEligibleForOvertime')}</Alert>}
        <FormGrid>
          <Field label={t('common.date')} required>
            <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </Field>
          <Field label={t('attendance.hours')} required>
            <Input type="number" min={0.25} max={16} step={0.25} value={hours} onChange={(e) => setHours(e.target.value)} />
          </Field>
        </FormGrid>
        <Field label={t('leave.reason')} required>
          <Textarea value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
      </div>
    </Dialog>
  );
}
