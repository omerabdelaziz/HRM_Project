import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Copy, KeyRound, Pencil, Plus, Trash2 } from 'lucide-react';
import { toast } from '@/lib/toast';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useApiMutation, useGet } from '@/lib/hooks';
import { localized } from '@/lib/i18n';
import { fmtDate, fmtNumber } from '@/lib/format';
import { Button } from '@/components/ui/button';
import { Checkbox, Field, FieldErrors, FormGrid, FormSection, Input, Select, Switch } from '@/components/ui/form';
import { Alert, Badge, Card, PageHeader, Spinner } from '@/components/ui/display';
import { Dialog, useConfirm } from '@/components/ui/dialog';
import { Tabs } from '@/components/ui/nav';
import { DataTable } from '@/components/ui/table';
import { OrgSelect } from '@/components/ui/pickers';
import { Settings as PageIcon } from 'lucide-react';

type Tab = 'company' | 'attendance' | 'shifts' | 'holidays' | 'leave';
const DAYS = [0, 1, 2, 3, 4, 5, 6];

export default function Settings() {
  const { t } = useTranslation();
  const { can } = useAuth();
  const first: Tab = can('settings.manage') ? 'company' : can('shift.manage') ? 'shifts' : can('holiday.manage') ? 'holidays' : 'leave';
  const [tab, setTab] = useState<Tab>(first);
  return (
    <div>
      <PageHeader icon={<PageIcon />}
        title={t('nav.settings')}
        subtitle={t('settings.subtitle')}
        actions={
          can('paycomponent.manage') && (
            <Link to="/payroll">
              <Button>{t('settings.payrollRules')}</Button>
            </Link>
          )
        }
      />
      <Tabs
        className="mb-4"
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'company', label: t('settings.company'), hidden: !can('settings.manage') },
          { id: 'attendance', label: t('settings.attendancePolicy'), hidden: !can('settings.manage') },
          { id: 'shifts', label: t('settings.shifts'), hidden: !can('shift.manage') },
          { id: 'holidays', label: t('settings.holidays'), hidden: !can('holiday.manage') },
          { id: 'leave', label: t('settings.leaveTypes'), hidden: !can('leavetype.manage') },
        ]}
      />
      {tab === 'company' && <CompanySettings />}
      {tab === 'attendance' && <AttendancePolicy />}
      {tab === 'shifts' && <Shifts />}
      {tab === 'holidays' && <Holidays />}
      {tab === 'leave' && <LeaveTypes />}
    </div>
  );
}

function dayName(d: number, locale: string) {
  return new Intl.DateTimeFormat(locale === 'ar' ? 'ar' : 'en', { weekday: 'short', timeZone: 'UTC' }).format(new Date(Date.UTC(2024, 0, 7 + d)));
}

function DayPicker({ value, onChange }: { value: number[]; onChange: (v: number[]) => void }) {
  const { i18n } = useTranslation();
  return (
    <div className="flex flex-wrap gap-1.5">
      {DAYS.map((d) => (
        <button
          key={d}
          type="button"
          aria-pressed={value.includes(d)}
          onClick={() => onChange(value.includes(d) ? value.filter((x) => x !== d) : [...value, d].sort())}
          className={`rounded-lg border px-3 py-1.5 text-sm ${value.includes(d) ? 'border-primary bg-primary-soft text-primary-ink' : 'border-line text-ink-2 hover:bg-subtle'}`}
        >
          {dayName(d, i18n.language)}
        </button>
      ))}
    </div>
  );
}

interface CompanyData {
  id: string;
  code: string;
  name: string;
  nameAr: string | null;
  legalName: string | null;
  registrationNo: string | null;
  taxNo: string | null;
  email: string | null;
  phone: string | null;
  address: string | null;
  baseCurrency: string;
  timezone: string;
  locale: string;
  dateFormat: string;
  weekendDays: number[];
  fiscalYearStartMonth: number;
  employeeNoPrefix: string;
  employeeNoPadding: number;
  probationMonths: number;
  minEmployeeAge: number;
}

function CompanySettings() {
  const { t } = useTranslation();
  const { company, reload } = useAuth();
  const { data } = useGet<CompanyData>(company ? `/org/companies/${company.id}` : null);
  const { data: currencies = [] } = useGet<{ code: string; name: string }[]>('/payroll/currencies');
  const [c, setC] = useState<CompanyData | null>(null);
  if (data && (!c || c.id !== data.id)) setC(data);
  const zones = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.('timeZone') ?? [c?.timezone ?? 'UTC'];
  const save = useApiMutation(() => {
    const { id, ...body } = c!;
    void id;
    return api.put(`/org/companies/${c!.id}`, { ...body, email: body.email || null });
  }, { invalidate: ['/org/companies'], onSuccess: () => void reload() });
  if (!c) return <Spinner />;
  const set = <K extends keyof CompanyData>(k: K, v: CompanyData[K]) => setC({ ...c, [k]: v });
  return (
    <Card>
      <div className="space-y-8">
        <FormSection title={t('settings.companyInfo')}>
          <FormGrid cols={3}>
            <Field label={t('common.name')} required><Input value={c.name} onChange={(e) => set('name', e.target.value)} /></Field>
            <Field label={t('org.nameAr')}><Input dir="rtl" value={c.nameAr ?? ''} onChange={(e) => set('nameAr', e.target.value)} /></Field>
            <Field label={t('settings.legalName')}><Input value={c.legalName ?? ''} onChange={(e) => set('legalName', e.target.value)} /></Field>
            <Field label={t('settings.registrationNo')}><Input value={c.registrationNo ?? ''} onChange={(e) => set('registrationNo', e.target.value)} /></Field>
            <Field label={t('settings.taxNo')}><Input value={c.taxNo ?? ''} onChange={(e) => set('taxNo', e.target.value)} /></Field>
            <Field label={t('login.email')}><Input type="email" value={c.email ?? ''} onChange={(e) => set('email', e.target.value)} /></Field>
            <Field label={t('employees.phone')}><Input value={c.phone ?? ''} onChange={(e) => set('phone', e.target.value)} /></Field>
            <Field label={t('employees.address')} className="sm:col-span-2"><Input value={c.address ?? ''} onChange={(e) => set('address', e.target.value)} /></Field>
          </FormGrid>
        </FormSection>
        <FormSection title={t('settings.regional')} description={t('settings.regionalHint')}>
          <FormGrid cols={3}>
            <Field label={t('salary.currency')}>
              <Select value={c.baseCurrency} onChange={(e) => set('baseCurrency', e.target.value)}>
                {currencies.map((x) => <option key={x.code} value={x.code}>{x.code} · {x.name}</option>)}
              </Select>
            </Field>
            <Field label={t('org.timezone')}>
              <Select value={c.timezone} onChange={(e) => set('timezone', e.target.value)}>
                {zones.map((z) => <option key={z} value={z}>{z}</option>)}
              </Select>
            </Field>
            <Field label={t('settings.defaultLanguage')}>
              <Select value={c.locale} onChange={(e) => set('locale', e.target.value)}>
                <option value="en">English</option>
                <option value="ar">العربية</option>
              </Select>
            </Field>
            <Field label={t('settings.fiscalYearStart')}>
              <Input type="number" min={1} max={12} value={c.fiscalYearStartMonth} onChange={(e) => set('fiscalYearStartMonth', Number(e.target.value))} />
            </Field>
          </FormGrid>
          <Field label={t('settings.weekend')} hint={t('settings.weekendHint')}>
            <DayPicker value={c.weekendDays} onChange={(v) => set('weekendDays', v)} />
          </Field>
        </FormSection>
        <FormSection title={t('settings.employeeNumbers')}>
          <FormGrid cols={3}>
            <Field label={t('settings.prefix')}><Input value={c.employeeNoPrefix} onChange={(e) => set('employeeNoPrefix', e.target.value.toUpperCase())} /></Field>
            <Field label={t('settings.padding')} hint={t('settings.paddingExample', { example: `${c.employeeNoPrefix}${'1'.padStart(c.employeeNoPadding, '0')}` })}>
              <Input type="number" min={3} max={10} value={c.employeeNoPadding} onChange={(e) => set('employeeNoPadding', Number(e.target.value))} />
            </Field>
            <Field label={t('settings.probationMonths')}><Input type="number" min={0} max={24} value={c.probationMonths} onChange={(e) => set('probationMonths', Number(e.target.value))} /></Field>
            <Field label={t('settings.minEmployeeAge')} hint={t('settings.minEmployeeAgeHint')}><Input type="number" min={15} max={30} value={c.minEmployeeAge} onChange={(e) => set('minEmployeeAge', Number(e.target.value))} /></Field>
          </FormGrid>
        </FormSection>
        <div className="flex justify-end">
          <Button variant="primary" loading={save.isPending} onClick={() => save.mutate(undefined)}>{t('common.save')}</Button>
        </div>
      </div>
    </Card>
  );
}

interface Policy {
  minOvertimeMinutes: number;
  overtimeRequiresApproval: boolean;
  halfDayThresholdMinutes: number;
  allowMobileCheckIn: boolean;
  allowWebCheckIn: boolean;
  geofenceLat: number | null;
  geofenceLng: number | null;
  geofenceRadiusMeters: number | null;
  hasDeviceKey: boolean;
}

function AttendancePolicy() {
  const { t } = useTranslation();
  const { company } = useAuth();
  const confirm = useConfirm();
  const { data } = useGet<Policy>('/shifts/policy');
  const [p, setP] = useState<Policy | null>(null);
  const [key, setKey] = useState<string | null>(null);
  if (data && !p) setP(data);
  const save = useApiMutation(() => api.put('/shifts/policy', { minOvertimeMinutes: p!.minOvertimeMinutes, overtimeRequiresApproval: p!.overtimeRequiresApproval, halfDayThresholdMinutes: p!.halfDayThresholdMinutes, allowMobileCheckIn: p!.allowMobileCheckIn, allowWebCheckIn: p!.allowWebCheckIn, geofenceLat: p!.geofenceLat, geofenceLng: p!.geofenceLng, geofenceRadiusMeters: p!.geofenceRadiusMeters }), { invalidate: ['/shifts/policy'] });
  const rotate = useApiMutation(() => api.post<{ deviceKey: string }>('/shifts/policy/device-key', {}), { success: '', onSuccess: (r) => setKey(r.deviceKey), invalidate: ['/shifts/policy'] });
  if (!p) return <Spinner />;
  const set = <K extends keyof Policy>(k: K, v: Policy[K]) => setP({ ...p, [k]: v });
  const num = (v: string) => (v === '' ? null : Number(v));
  return (
    <div className="space-y-6">
      <Card>
        <div className="space-y-8">
          <FormSection title={t('settings.calculation')}>
            <FormGrid cols={3}>
              <Field label={t('settings.minOvertime')} hint={t('settings.minutes')}><Input type="number" value={p.minOvertimeMinutes} onChange={(e) => set('minOvertimeMinutes', Number(e.target.value))} /></Field>
              <Field label={t('settings.halfDayThreshold')} hint={t('settings.halfDayHint')}><Input type="number" value={p.halfDayThresholdMinutes} onChange={(e) => set('halfDayThresholdMinutes', Number(e.target.value))} /></Field>
            </FormGrid>
            <Switch checked={p.overtimeRequiresApproval} onChange={(v) => set('overtimeRequiresApproval', v)} label={t('settings.otApproval')} />
          </FormSection>
          <FormSection title={t('settings.checkInMethods')}>
            <div className="flex flex-col gap-3">
              <Switch checked={p.allowWebCheckIn} onChange={(v) => set('allowWebCheckIn', v)} label={t('settings.webCheckIn')} />
              <Switch checked={p.allowMobileCheckIn} onChange={(v) => set('allowMobileCheckIn', v)} label={t('settings.mobileCheckIn')} />
            </div>
            <FormGrid cols={3}>
              <Field label={t('settings.geoLat')}><Input type="number" step="0.000001" value={p.geofenceLat ?? ''} onChange={(e) => set('geofenceLat', num(e.target.value))} /></Field>
              <Field label={t('settings.geoLng')}><Input type="number" step="0.000001" value={p.geofenceLng ?? ''} onChange={(e) => set('geofenceLng', num(e.target.value))} /></Field>
              <Field label={t('settings.geoRadius')} hint={t('settings.geoHint')}><Input type="number" value={p.geofenceRadiusMeters ?? ''} onChange={(e) => set('geofenceRadiusMeters', num(e.target.value))} /></Field>
            </FormGrid>
          </FormSection>
          <div className="flex justify-end">
            <Button variant="primary" loading={save.isPending} onClick={() => save.mutate(undefined)}>{t('common.save')}</Button>
          </div>
        </div>
      </Card>
      <Card>
        <FormSection title={t('settings.devices')} description={t('settings.devicesHint', { code: company?.code })}>
          <div className="flex items-center gap-3">
            {p.hasDeviceKey ? <Badge tone="success">{t('settings.keyConfigured')}</Badge> : <Badge>{t('settings.noKey')}</Badge>}
            <Button icon={<KeyRound className="h-4 w-4" />} onClick={async () => (!p.hasDeviceKey || (await confirm({ title: t('settings.rotateKey'), message: t('settings.rotateWarning'), tone: 'danger' }))) && rotate.mutate(undefined)}>
              {p.hasDeviceKey ? t('settings.rotateKey') : t('settings.generateKey')}
            </Button>
          </div>
          {key && (
            <Alert tone="warning" title={t('settings.keyOnce')}>
              <div className="mt-1 flex items-center gap-2 font-mono text-xs break-all">
                {key}
                <Button size="sm" variant="ghost" icon={<Copy className="h-4 w-4" />} onClick={() => (navigator.clipboard.writeText(key), toast.success(t('common.copied')))} />
              </div>
            </Alert>
          )}
          <pre className="overflow-x-auto rounded-lg bg-subtle p-3 text-xs" dir="ltr">{`POST /api/attendance/device/punches
X-Device-Key: <key>
{ "companyCode": "${company?.code ?? 'ACME'}", "punches": [{ "employeeNo": "ACM0001", "timestamp": "2026-03-02T09:01:00+04:00" }] }`}</pre>
        </FormSection>
      </Card>
    </div>
  );
}

interface Shift {
  id: string;
  code: string;
  name: string;
  nameAr: string | null;
  startTime: string;
  endTime: string;
  breakMinutes: number;
  graceMinutes: number;
  earlyLeaveGraceMinutes: number;
  isFlexible: boolean;
  requiredMinutes: number | null;
  workDays: number[];
  isDefault: boolean;
  isActive: boolean;
  _count?: { employees: number };
}

function Shifts() {
  const { t, i18n } = useTranslation();
  const [editing, setEditing] = useState<Partial<Shift> | null>(null);
  const { data, isLoading } = useGet<Shift[]>('/shifts');
  return (
    <Card padded={false}>
      <div className="flex items-center justify-between border-b border-line p-4">
        <p className="text-sm text-ink-3">{t('settings.shiftsHint')}</p>
        <Button variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => setEditing({ startTime: '09:00', endTime: '18:00', breakMinutes: 60, graceMinutes: 10, earlyLeaveGraceMinutes: 0, workDays: [1, 2, 3, 4, 5], isActive: true })}>
          {t('settings.addShift')}
        </Button>
      </div>
      <DataTable
        rows={data}
        loading={isLoading}
        rowKey={(s) => s.id}
        onRowClick={setEditing}
        columns={[
          { key: 'name', header: t('common.name'), cell: (s) => <span className="font-medium">{localized(s as unknown as Record<string, unknown>, 'name')} {s.isDefault && <Badge tone="primary">{t('settings.default')}</Badge>}</span> },
          { key: 'time', header: t('settings.hours'), cell: (s) => <span className="tabular">{s.isFlexible ? t('settings.flexible', { hours: (s.requiredMinutes ?? 0) / 60 }) : `${s.startTime}–${s.endTime}`}</span> },
          { key: 'days', header: t('settings.workDays'), hideBelow: 'md', cell: (s) => s.workDays.map((d) => dayName(d, i18n.language)).join(' ') },
          { key: 'grace', header: t('settings.grace'), hideBelow: 'lg', align: 'end', cell: (s) => `${s.graceMinutes}m` },
          { key: 'emps', header: t('org.employees'), align: 'end', cell: (s) => fmtNumber(s._count?.employees ?? 0) },
          { key: 'e', header: '', align: 'end', cell: () => <Pencil className="ms-auto h-4 w-4 text-ink-3" /> },
        ]}
      />
      <ShiftDialog shift={editing} onClose={() => setEditing(null)} />
    </Card>
  );
}

function ShiftDialog({ shift, onClose }: { shift: Partial<Shift> | null; onClose: () => void }) {
  const { t } = useTranslation();
  const [s, setS] = useState<Partial<Shift>>({});
  const [last, setLast] = useState<Partial<Shift> | null>(null);
  if (shift !== last) {
    setLast(shift);
    setS(shift ?? {});
  }
  const save = useApiMutation(() => {
    const body = { code: s.code, name: s.name, nameAr: s.nameAr || null, startTime: s.startTime, endTime: s.endTime, breakMinutes: Number(s.breakMinutes), graceMinutes: Number(s.graceMinutes), earlyLeaveGraceMinutes: Number(s.earlyLeaveGraceMinutes ?? 0), isFlexible: !!s.isFlexible, requiredMinutes: s.isFlexible ? Number(s.requiredMinutes ?? 480) : null, workDays: s.workDays, isDefault: !!s.isDefault, isActive: s.isActive !== false };
    return s.id ? api.put(`/shifts/${s.id}`, body) : api.post('/shifts', body);
  }, { invalidate: ['/shifts'], onSuccess: onClose });
  const set = <K extends keyof Shift>(k: K, v: Shift[K]) => setS({ ...s, [k]: v });
  return (
    <Dialog open={!!shift} onClose={onClose} size="lg" title={s.id ? t('settings.editShift') : t('settings.addShift')} footer={<><Button onClick={onClose}>{t('common.cancel')}</Button><Button variant="primary" disabled={!s.code || !s.name || !s.workDays?.length} loading={save.isPending} onClick={() => save.mutate(undefined)}>{t('common.save')}</Button></>}>
      <FieldErrors errors={save.fieldErrors}>
      <div className="space-y-4">
        <FormGrid cols={3}>
          <Field name="code" label={t('org.code')} required><Input value={s.code ?? ''} onChange={(e) => set('code', e.target.value.toUpperCase())} /></Field>
          <Field label={t('common.name')} required><Input value={s.name ?? ''} onChange={(e) => set('name', e.target.value)} /></Field>
          <Field label={t('org.nameAr')}><Input dir="rtl" value={s.nameAr ?? ''} onChange={(e) => set('nameAr', e.target.value)} /></Field>
          <Field name="startTime" label={t('settings.start')}><Input type="time" value={s.startTime} onChange={(e) => set('startTime', e.target.value)} /></Field>
          <Field name="endTime" label={t('settings.end')} hint={t('settings.overnightHint')}><Input type="time" value={s.endTime} onChange={(e) => set('endTime', e.target.value)} /></Field>
          <Field label={t('settings.break')}><Input type="number" value={s.breakMinutes} onChange={(e) => set('breakMinutes', Number(e.target.value))} /></Field>
          <Field label={t('settings.grace')} hint={t('settings.minutes')}><Input type="number" value={s.graceMinutes} onChange={(e) => set('graceMinutes', Number(e.target.value))} /></Field>
          <Field label={t('settings.earlyGrace')} hint={t('settings.minutes')}><Input type="number" value={s.earlyLeaveGraceMinutes} onChange={(e) => set('earlyLeaveGraceMinutes', Number(e.target.value))} /></Field>
          {s.isFlexible && <Field label={t('settings.requiredHours')}><Input type="number" step={0.5} value={(s.requiredMinutes ?? 480) / 60} onChange={(e) => set('requiredMinutes', Math.round(Number(e.target.value) * 60))} /></Field>}
        </FormGrid>
        <Field name="workDays" label={t('settings.workDays')}>
          <DayPicker value={s.workDays ?? []} onChange={(v) => set('workDays', v)} />
        </Field>
        <div className="flex flex-col gap-2">
          <Checkbox label={t('settings.flexibleShift')} checked={!!s.isFlexible} onChange={(e) => set('isFlexible', e.target.checked)} />
          <Checkbox label={t('settings.defaultShift')} checked={!!s.isDefault} onChange={(e) => set('isDefault', e.target.checked)} />
          <Checkbox label={t('common.active')} checked={s.isActive !== false} onChange={(e) => set('isActive', e.target.checked)} />
        </div>
      </div>
      </FieldErrors>
    </Dialog>
  );
}

function Holidays() {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const [year, setYear] = useState(new Date().getFullYear());
  const [open, setOpen] = useState(false);
  const { data, isLoading } = useGet<{ id: string; date: string; name: string; nameAr: string | null; branch: { name: string } | null }[]>('/shifts/holidays', { year });
  const remove = useApiMutation((id: string) => api.delete(`/shifts/holidays/${id}`), { success: t('common.deleted'), invalidate: ['/shifts/holidays'] });
  const [h, setH] = useState({ date: '', name: '', nameAr: '', branchId: null as string | null });
  const add = useApiMutation(() => api.post('/shifts/holidays', { ...h, nameAr: h.nameAr || null }), { invalidate: ['/shifts/holidays'], onSuccess: () => (setH({ date: '', name: '', nameAr: '', branchId: null }), setOpen(false)) });
  return (
    <Card padded={false}>
      <div className="flex items-center justify-between gap-3 border-b border-line p-4">
        <Select value={year} onChange={(e) => setYear(Number(e.target.value))} className="w-28" aria-label={t('common.year')}>
          {[year - 1, year, year + 1, year + 2].map((y) => <option key={y} value={y}>{y}</option>)}
        </Select>
        <Button variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => setOpen(true)}>{t('settings.addHoliday')}</Button>
      </div>
      <DataTable
        rows={data}
        loading={isLoading}
        rowKey={(x) => x.id}
        empty={{ title: t('settings.noHolidays') }}
        columns={[
          { key: 'date', header: t('common.date'), cell: (x) => fmtDate(x.date, { weekday: 'short', day: '2-digit', month: 'long' }) },
          { key: 'name', header: t('common.name'), cell: (x) => localized(x as unknown as Record<string, unknown>, 'name') },
          { key: 'branch', header: t('common.branch'), cell: (x) => x.branch?.name ?? t('settings.allBranches') },
          { key: 'a', header: '', align: 'end', cell: (x) => <Button size="icon" variant="ghost" aria-label={t('common.delete')} icon={<Trash2 className="h-4 w-4 text-danger" />} onClick={async () => (await confirm({ title: t('settings.deleteHoliday'), message: x.name, tone: 'danger' })) && remove.mutate(x.id)} /> },
        ]}
      />
      <Dialog open={open} onClose={() => setOpen(false)} title={t('settings.addHoliday')} footer={<><Button onClick={() => setOpen(false)}>{t('common.cancel')}</Button><Button variant="primary" disabled={!h.date || !h.name} loading={add.isPending} onClick={() => add.mutate(undefined)}>{t('common.add')}</Button></>}>
        <FormGrid>
          <Field label={t('common.date')} required><Input type="date" value={h.date} onChange={(e) => setH({ ...h, date: e.target.value })} /></Field>
          <Field label={t('common.branch')} hint={t('settings.holidayBranchHint')}><OrgSelect entity="branches" value={h.branchId} onChange={(v) => setH({ ...h, branchId: v })} placeholder={t('settings.allBranches')} /></Field>
          <Field label={t('common.name')} required><Input value={h.name} onChange={(e) => setH({ ...h, name: e.target.value })} /></Field>
          <Field label={t('org.nameAr')}><Input dir="rtl" value={h.nameAr} onChange={(e) => setH({ ...h, nameAr: e.target.value })} /></Field>
        </FormGrid>
      </Dialog>
    </Card>
  );
}

interface LeaveTypeFull {
  id: string;
  code: string;
  name: string;
  nameAr: string | null;
  color: string;
  isPaid: boolean;
  annualEntitlement: string | number;
  accrualMethod: string;
  prorateFirstYear: boolean;
  maxCarryForward: string | number;
  allowNegativeBalance: boolean;
  allowHalfDay: boolean;
  countWeekendsAndHolidays: boolean;
  requiresAttachment: boolean;
  maxConsecutiveDays: number | null;
  minNoticeDays: number;
  minServiceMonths: number;
  genderRestriction: string | null;
  allowOverlap: boolean;
  isActive: boolean;
}

function LeaveTypes() {
  const { t } = useTranslation();
  const [editing, setEditing] = useState<Partial<LeaveTypeFull> | null>(null);
  const { data, isLoading } = useGet<LeaveTypeFull[]>('/leave/types', { all: 'true' });
  return (
    <Card padded={false}>
      <div className="flex items-center justify-between border-b border-line p-4">
        <p className="text-sm text-ink-3">{t('settings.leaveHint')}</p>
        <Button variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => setEditing({ color: '#2a78d6', isPaid: true, annualEntitlement: 0, accrualMethod: 'ANNUAL', prorateFirstYear: true, maxCarryForward: 0, allowHalfDay: true, minNoticeDays: 0, minServiceMonths: 0, isActive: true })}>
          {t('settings.addLeaveType')}
        </Button>
      </div>
      <DataTable
        rows={data}
        loading={isLoading}
        rowKey={(x) => x.id}
        onRowClick={setEditing}
        columns={[
          { key: 'name', header: t('common.name'), cell: (x) => <span className="inline-flex items-center gap-2 font-medium"><span className="h-2.5 w-2.5 rounded-full" style={{ background: x.color }} aria-hidden />{localized(x as unknown as Record<string, unknown>, 'name')}</span> },
          { key: 'ent', header: t('settings.entitlement'), align: 'end', cell: (x) => (x.accrualMethod === 'NONE' ? '—' : t('settings.daysPerYear', { days: Number(x.annualEntitlement) })) },
          { key: 'acc', header: t('settings.accrual'), hideBelow: 'md', cell: (x) => t(`settings.accrualMethod.${x.accrualMethod}`) },
          { key: 'carry', header: t('settings.carryForward'), hideBelow: 'lg', align: 'end', cell: (x) => Number(x.maxCarryForward) || '—' },
          { key: 'paid', header: t('settings.paid'), cell: (x) => (x.isPaid ? <Badge tone="success">{t('common.yes')}</Badge> : <Badge tone="warning">{t('leave.unpaid')}</Badge>) },
          { key: 'st', header: t('common.status'), hideBelow: 'sm', cell: (x) => (x.isActive ? <Badge tone="success">{t('common.active')}</Badge> : <Badge>{t('common.inactive')}</Badge>) },
        ]}
      />
      <LeaveTypeDialog lt={editing} onClose={() => setEditing(null)} />
    </Card>
  );
}

function LeaveTypeDialog({ lt, onClose }: { lt: Partial<LeaveTypeFull> | null; onClose: () => void }) {
  const { t } = useTranslation();
  const [v, setV] = useState<Partial<LeaveTypeFull>>({});
  const [last, setLast] = useState<Partial<LeaveTypeFull> | null>(null);
  if (lt !== last) {
    setLast(lt);
    setV(lt ?? {});
  }
  const set = <K extends keyof LeaveTypeFull>(k: K, val: LeaveTypeFull[K]) => setV({ ...v, [k]: val });
  const save = useApiMutation(() => {
    const body = {
      code: v.code, name: v.name, nameAr: v.nameAr || null, color: v.color, isPaid: !!v.isPaid, annualEntitlement: Number(v.annualEntitlement ?? 0), accrualMethod: v.accrualMethod,
      prorateFirstYear: !!v.prorateFirstYear, maxCarryForward: Number(v.maxCarryForward ?? 0), allowNegativeBalance: !!v.allowNegativeBalance, allowHalfDay: !!v.allowHalfDay,
      countWeekendsAndHolidays: !!v.countWeekendsAndHolidays, requiresAttachment: !!v.requiresAttachment, maxConsecutiveDays: v.maxConsecutiveDays ? Number(v.maxConsecutiveDays) : null,
      minNoticeDays: Number(v.minNoticeDays ?? 0), minServiceMonths: Number(v.minServiceMonths ?? 0), genderRestriction: v.genderRestriction || null, allowOverlap: !!v.allowOverlap, isActive: v.isActive !== false,
    };
    if (v.id) {
      const { code, ...rest } = body;
      void code;
      return api.put(`/leave/types/${v.id}`, rest);
    }
    return api.post('/leave/types', body);
  }, { invalidate: ['/leave'], onSuccess: onClose });
  return (
    <Dialog open={!!lt} onClose={onClose} size="lg" title={v.id ? t('settings.editLeaveType') : t('settings.addLeaveType')} footer={<><Button onClick={onClose}>{t('common.cancel')}</Button><Button variant="primary" disabled={!v.code || !v.name} loading={save.isPending} onClick={() => save.mutate(undefined)}>{t('common.save')}</Button></>}>
      <FieldErrors errors={save.fieldErrors}>
      <div className="space-y-6">
        <FormGrid cols={3}>
          <Field name="code" label={t('org.code')} required><Input value={v.code ?? ''} disabled={!!v.id} onChange={(e) => set('code', e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, ''))} /></Field>
          <Field label={t('common.name')} required><Input value={v.name ?? ''} onChange={(e) => set('name', e.target.value)} /></Field>
          <Field label={t('org.nameAr')}><Input dir="rtl" value={v.nameAr ?? ''} onChange={(e) => set('nameAr', e.target.value)} /></Field>
          <Field label={t('settings.accrual')}>
            <Select value={v.accrualMethod} onChange={(e) => set('accrualMethod', e.target.value)}>
              {['ANNUAL', 'MONTHLY', 'NONE'].map((x) => <option key={x} value={x}>{t(`settings.accrualMethod.${x}`)}</option>)}
            </Select>
          </Field>
          <Field name="annualEntitlement" label={t('settings.entitlement')} hint={t('settings.daysPerYearHint')}><Input type="number" step={0.5} value={v.annualEntitlement ?? 0} disabled={v.accrualMethod === 'NONE'} onChange={(e) => set('annualEntitlement', e.target.value)} /></Field>
          <Field label={t('settings.carryForward')} hint={t('settings.carryHint')}><Input type="number" step={0.5} value={v.maxCarryForward ?? 0} onChange={(e) => set('maxCarryForward', e.target.value)} /></Field>
          <Field label={t('settings.maxConsecutive')}><Input type="number" value={v.maxConsecutiveDays ?? ''} onChange={(e) => set('maxConsecutiveDays', e.target.value ? Number(e.target.value) : null)} /></Field>
          <Field label={t('settings.minNotice')}><Input type="number" value={v.minNoticeDays ?? 0} onChange={(e) => set('minNoticeDays', Number(e.target.value))} /></Field>
          <Field label={t('settings.minService')}><Input type="number" value={v.minServiceMonths ?? 0} onChange={(e) => set('minServiceMonths', Number(e.target.value))} /></Field>
          <Field label={t('settings.gender')}>
            <Select value={v.genderRestriction ?? ''} onChange={(e) => set('genderRestriction', e.target.value || null)} placeholder={t('settings.anyone')}>
              <option value="FEMALE">{t('employees.female')}</option>
              <option value="MALE">{t('employees.male')}</option>
            </Select>
          </Field>
          <Field label={t('settings.color')}><Input type="color" value={v.color ?? '#2a78d6'} onChange={(e) => set('color', e.target.value)} className="h-9 p-1" /></Field>
        </FormGrid>
        <div className="grid gap-2 sm:grid-cols-2">
          <Checkbox label={t('settings.paid')} checked={!!v.isPaid} onChange={(e) => set('isPaid', e.target.checked)} />
          <Checkbox label={t('settings.prorate')} checked={!!v.prorateFirstYear} onChange={(e) => set('prorateFirstYear', e.target.checked)} />
          <Checkbox label={t('settings.halfDays')} checked={!!v.allowHalfDay} onChange={(e) => set('allowHalfDay', e.target.checked)} />
          <Checkbox label={t('settings.countWeekends')} checked={!!v.countWeekendsAndHolidays} onChange={(e) => set('countWeekendsAndHolidays', e.target.checked)} />
          <Checkbox label={t('settings.attachment')} checked={!!v.requiresAttachment} onChange={(e) => set('requiresAttachment', e.target.checked)} />
          <Checkbox label={t('settings.negative')} checked={!!v.allowNegativeBalance} onChange={(e) => set('allowNegativeBalance', e.target.checked)} />
          <Checkbox label={t('settings.overlap')} checked={!!v.allowOverlap} onChange={(e) => set('allowOverlap', e.target.checked)} />
          <Checkbox label={t('common.active')} checked={v.isActive !== false} onChange={(e) => set('isActive', e.target.checked)} />
        </div>
      </div>
      </FieldErrors>
    </Dialog>
  );
}
