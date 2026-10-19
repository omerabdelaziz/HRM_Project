import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useApiMutation, useGet, usePaged } from '@/lib/hooks';
import { localized } from '@/lib/i18n';
import { fmtDate, fmtMoney, fmtMonth, fmtNumber } from '@/lib/format';
import { Button } from '@/components/ui/button';
import { Checkbox, Field, FormGrid, FormSection, Input, SearchInput, Select, Switch } from '@/components/ui/form';
import { Alert, Badge, Card, PageHeader, Spinner, StatusBadge } from '@/components/ui/display';
import { Dialog } from '@/components/ui/dialog';
import { Tabs } from '@/components/ui/nav';
import { DataTable, Pagination } from '@/components/ui/table';
import { OrgSelect, PersonCell } from '@/components/ui/pickers';
import { Wallet as PageIcon } from 'lucide-react';

export interface Run {
  id: string;
  year: number;
  month: number;
  periodStart: string;
  periodEnd: string;
  branchId: string | null;
  currency: string;
  status: string;
  employeeCount: number;
  totalGross: string;
  totalDeductions: string;
  totalNet: string;
  totalEmployerCost: string;
  calculatedAt: string | null;
  approvedAt: string | null;
  paidAt: string | null;
  lockedAt: string | null;
  reopenCount: number;
  notes: string | null;
}

type Tab = 'runs' | 'salaries' | 'components' | 'settings' | 'currencies';

export default function Payroll() {
  const { t } = useTranslation();
  const { can } = useAuth();
  const [tab, setTab] = useState<Tab>(can('payroll.read') ? 'runs' : 'components');
  return (
    <div>
      <PageHeader icon={<PageIcon />} title={t('nav.payroll')} subtitle={t('payroll.subtitle')} />
      <Tabs
        className="mb-4"
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'runs', label: t('payroll.runs'), hidden: !can('payroll.read') },
          { id: 'salaries', label: t('payroll.salaries'), hidden: !can('employee.salary.read') },
          { id: 'components', label: t('payroll.components') },
          { id: 'settings', label: t('payroll.rules') },
          { id: 'currencies', label: t('payroll.currencies') },
        ]}
      />
      {tab === 'runs' && <Runs />}
      {tab === 'salaries' && <Salaries />}
      {tab === 'components' && <Components />}
      {tab === 'settings' && <PayrollSettings />}
      {tab === 'currencies' && <Currencies />}
    </div>
  );
}

function Runs() {
  const { t } = useTranslation();
  const { can } = useAuth();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const list = usePaged<Run>('/payroll/runs', {}, { pageSize: 12 });
  return (
    <Card padded={false}>
      <div className="flex items-center justify-between border-b border-line p-4">
        <h2 className="font-semibold">{t('payroll.runs')}</h2>
        {can('payroll.run') && (
          <Button variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => setOpen(true)}>
            {t('payroll.newRun')}
          </Button>
        )}
      </div>
      <DataTable
        rows={list.data?.items}
        rowKey={(r) => r.id}
        loading={list.isLoading}
        error={list.error}
        onRowClick={(r) => navigate(`/payroll/runs/${r.id}`)}
        empty={{ title: t('payroll.noRuns'), description: t('payroll.noRunsHint') }}
        columns={[
          { key: 'period', header: t('payroll.period'), cell: (r) => <span className="font-medium">{fmtMonth(r.year, r.month)}</span> },
          { key: 'emps', header: t('dashboard.employees'), align: 'end', hideBelow: 'sm', cell: (r) => fmtNumber(r.employeeCount) },
          { key: 'gross', header: t('payroll.gross'), align: 'end', hideBelow: 'md', cell: (r) => fmtMoney(r.totalGross, r.currency) },
          { key: 'net', header: t('payroll.net'), align: 'end', cell: (r) => fmtMoney(r.totalNet, r.currency) },
          { key: 'cost', header: t('payroll.employerCost'), align: 'end', hideBelow: 'lg', cell: (r) => fmtMoney(r.totalEmployerCost, r.currency) },
          { key: 'status', header: t('common.status'), cell: (r) => <StatusBadge status={r.status} /> },
        ]}
      />
      {list.data && <Pagination page={list.page} pageCount={list.data.pageCount} total={list.data.total} pageSize={list.pageSize} onPage={list.setPage} />}
      <NewRunDialog open={open} onClose={() => setOpen(false)} />
    </Card>
  );
}

function NewRunDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth() + 1);
  const [branchId, setBranch] = useState<string | null>(null);
  const [notes, setNotes] = useState('');
  const create = useApiMutation(() => api.post<Run>('/payroll/runs', { year, month, branchId, notes: notes || undefined }), { success: t('payroll.runCreated'), invalidate: ['/payroll/runs'], onSuccess: (r) => (onClose(), navigate(`/payroll/runs/${r.id}`)) });
  return (
    <Dialog open={open} onClose={onClose} title={t('payroll.newRun')} footer={<><Button onClick={onClose}>{t('common.cancel')}</Button><Button variant="primary" loading={create.isPending} onClick={() => create.mutate(undefined)}>{t('common.create')}</Button></>}>
      <div className="space-y-4">
        <FormGrid>
          <Field label={t('common.month')}>
            <Select value={month} onChange={(e) => setMonth(Number(e.target.value))}>
              {Array.from({ length: 12 }, (_, i) => (
                <option key={i + 1} value={i + 1}>
                  {fmtMonth(2000, i + 1).replace(/\s?2000/, '')}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t('common.year')}>
            <Input type="number" value={year} onChange={(e) => setYear(Number(e.target.value))} />
          </Field>
        </FormGrid>
        <Field label={t('common.branch')} hint={t('payroll.branchHint')}>
          <OrgSelect entity="branches" value={branchId} onChange={setBranch} placeholder={t('payroll.allBranches')} />
        </Field>
        <Field label={t('payroll.notes')}>
          <Input value={notes} onChange={(e) => setNotes(e.target.value)} />
        </Field>
      </div>
    </Dialog>
  );
}

function Salaries() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const list = usePaged<{ id: string; employeeNo: string; firstName: string; lastName: string; status: string; department: { name: string } | null; salaryStructures: { basicSalary: string; currency: string; effectiveFrom: string; status: string }[] }>('/payroll/employees');
  return (
    <Card padded={false}>
      <div className="border-b border-line p-4">
        <SearchInput className="max-w-xs" placeholder={t('employees.searchPlaceholder')} value={list.search} onChange={(e) => list.setSearch(e.target.value)} />
      </div>
      <DataTable
        rows={list.data?.items}
        loading={list.isLoading}
        rowKey={(r) => r.id}
        onRowClick={(r) => navigate(`/employees/${r.id}?tab=salary`)}
        columns={[
          { key: 'emp', header: t('common.employee'), cell: (r) => <PersonCell employee={r} sub={r.department?.name} /> },
          {
            key: 'basic',
            header: t('salary.basic'),
            align: 'end',
            cell: (r) => {
              const active = r.salaryStructures.find((s) => s.status === 'ACTIVE');
              return active ? fmtMoney(active.basicSalary, active.currency) : <Badge tone="warning">{t('salary.notSet')}</Badge>;
            },
          },
          { key: 'since', header: t('salary.effectiveSince'), hideBelow: 'sm', cell: (r) => fmtDate(r.salaryStructures.find((s) => s.status === 'ACTIVE')?.effectiveFrom) },
          { key: 'pending', header: '', cell: (r) => r.salaryStructures.some((s) => s.status === 'PENDING') && <Badge tone="warning">{t('salary.changePending')}</Badge> },
          { key: 'status', header: t('common.status'), hideBelow: 'md', cell: (r) => <StatusBadge status={r.status} /> },
        ]}
      />
      {list.data && <Pagination page={list.page} pageCount={list.data.pageCount} total={list.data.total} pageSize={list.pageSize} onPage={list.setPage} />}
    </Card>
  );
}

interface Comp {
  id: string;
  code: string;
  name: string;
  nameAr: string | null;
  type: 'EARNING' | 'DEDUCTION' | 'EMPLOYER_CONTRIBUTION';
  calcType: 'FIXED' | 'PERCENT_OF_BASIC' | 'PERCENT_OF_GROSS' | 'BRACKET';
  defaultValue: string | null;
  brackets: { upTo: number | null; rate: number }[] | null;
  bracketBase: string | null;
  minAmount: string | null;
  maxAmount: string | null;
  baseCap: string | null;
  isTaxable: boolean;
  pensionable: boolean;
  includeInRateBase: boolean;
  appliesToAll: boolean;
  eligibility: { categoryCodes?: string[]; nationalities?: string[]; employmentTypeCodes?: string[] } | null;
  sortOrder: number;
  isActive: boolean;
}

function Components() {
  const { t } = useTranslation();
  const { can } = useAuth();
  const [editing, setEditing] = useState<Partial<Comp> | null>(null);
  const { data, isLoading } = useGet<Comp[]>('/payroll/components');
  const manage = can('paycomponent.manage');
  const valueOf = (c: Comp) => {
    if (c.calcType === 'BRACKET') return t('payComponent.bracketSummary', { count: c.brackets?.length ?? 0 });
    if (c.calcType === 'FIXED') return c.defaultValue ? fmtMoney(c.defaultValue) : t('payComponent.perEmployee');
    return c.defaultValue ? `${fmtNumber(Number(c.defaultValue), 2)}%` : t('payComponent.perEmployee');
  };
  return (
    <div className="space-y-4">
      <Alert tone="info">{t('payComponent.configNote')}</Alert>
      <Card padded={false}>
        <div className="flex items-center justify-between border-b border-line p-4">
          <h2 className="font-semibold">{t('payroll.components')}</h2>
          {manage && (
            <Button variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => setEditing({ type: 'EARNING', calcType: 'FIXED', isTaxable: true, isActive: true, sortOrder: 100 })}>
              {t('payComponent.add')}
            </Button>
          )}
        </div>
        <DataTable
          rows={data}
          loading={isLoading}
          rowKey={(c) => c.id}
          onRowClick={manage ? (c) => setEditing(c) : undefined}
          columns={[
            { key: 'code', header: t('org.code'), cell: (c) => <span className="font-mono text-xs">{c.code}</span> },
            { key: 'name', header: t('common.name'), cell: (c) => <span className="font-medium">{localized(c as unknown as Record<string, unknown>, 'name')}</span> },
            { key: 'type', header: t('payComponent.typeLabel'), cell: (c) => <Badge tone={c.type === 'EARNING' ? 'success' : c.type === 'DEDUCTION' ? 'danger' : 'info'}>{t(`payComponent.type.${c.type}`)}</Badge> },
            { key: 'calc', header: t('payComponent.calc'), hideBelow: 'sm', cell: (c) => t(`payComponent.calcType.${c.calcType}`) },
            { key: 'value', header: t('payComponent.value'), hideBelow: 'md', cell: valueOf },
            { key: 'scope', header: t('payComponent.appliesTo'), hideBelow: 'lg', cell: (c) => (c.appliesToAll ? t('payComponent.allEligible') : t('payComponent.onStructure')) },
            { key: 'active', header: t('common.status'), cell: (c) => (c.isActive ? <Badge tone="success">{t('common.active')}</Badge> : <Badge>{t('common.inactive')}</Badge>) },
            ...(manage ? [{ key: 'e', header: '', align: 'end' as const, cell: () => <Pencil className="ms-auto h-4 w-4 text-ink-3" /> }] : []),
          ]}
        />
      </Card>
      <ComponentDialog comp={editing} onClose={() => setEditing(null)} />
    </div>
  );
}

function ComponentDialog({ comp, onClose }: { comp: Partial<Comp> | null; onClose: () => void }) {
  const { t } = useTranslation();
  const [c, setC] = useState<Partial<Comp>>({});
  const [last, setLast] = useState<Partial<Comp> | null>(null);
  const [elig, setElig] = useState({ categoryCodes: '', nationalities: '', employmentTypeCodes: '' });
  if (comp !== last) {
    setLast(comp);
    setC(comp ?? {});
    setElig({ categoryCodes: comp?.eligibility?.categoryCodes?.join(', ') ?? '', nationalities: comp?.eligibility?.nationalities?.join(', ') ?? '', employmentTypeCodes: comp?.eligibility?.employmentTypeCodes?.join(', ') ?? '' });
  }
  const isNew = !comp?.id;
  const set = <K extends keyof Comp>(k: K, v: Comp[K]) => setC((s) => ({ ...s, [k]: v }));
  const num = (v: unknown) => (v === '' || v === null || v === undefined ? null : Number(v));
  const list = (s: string) => s.split(',').map((x) => x.trim()).filter(Boolean);
  const save = useApiMutation(
    () => {
      const eligibility = { categoryCodes: list(elig.categoryCodes), nationalities: list(elig.nationalities), employmentTypeCodes: list(elig.employmentTypeCodes) };
      const hasElig = Object.values(eligibility).some((a) => a.length);
      const body = {
        name: c.name, nameAr: c.nameAr || null, type: c.type, calcType: c.calcType, defaultValue: num(c.defaultValue),
        brackets: c.calcType === 'BRACKET' ? (c.brackets ?? []).map((b) => ({ upTo: b.upTo === null || (b.upTo as unknown) === '' ? null : Number(b.upTo), rate: Number(b.rate) })) : null,
        bracketBase: c.calcType === 'BRACKET' ? c.bracketBase ?? 'TAXABLE' : null,
        minAmount: num(c.minAmount), maxAmount: num(c.maxAmount), baseCap: num(c.baseCap), isTaxable: !!c.isTaxable, pensionable: !!c.pensionable, includeInRateBase: !!c.includeInRateBase,
        appliesToAll: !!c.appliesToAll, eligibility: hasElig ? eligibility : null, sortOrder: Number(c.sortOrder ?? 100), isActive: c.isActive !== false,
      };
      return isNew ? api.post('/payroll/components', { ...body, code: c.code }) : api.put(`/payroll/components/${comp!.id}`, body);
    },
    { invalidate: ['/payroll/components'], onSuccess: onClose },
  );
  const brackets = c.brackets ?? [];
  return (
    <Dialog open={!!comp} onClose={onClose} size="lg" title={isNew ? t('payComponent.add') : t('payComponent.edit', { code: comp?.code })} footer={<><Button onClick={onClose}>{t('common.cancel')}</Button><Button variant="primary" disabled={!c.code || !c.name} loading={save.isPending} onClick={() => save.mutate(undefined)}>{t('common.save')}</Button></>}>
      <div className="space-y-6">
        <FormGrid>
          <Field label={t('org.code')} required hint={t('payComponent.codeHint')}>
            <Input value={c.code ?? ''} disabled={!isNew} onChange={(e) => set('code', e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, ''))} />
          </Field>
          <Field label={t('common.name')} required>
            <Input value={c.name ?? ''} onChange={(e) => set('name', e.target.value)} />
          </Field>
          <Field label={t('org.nameAr')}>
            <Input dir="rtl" value={c.nameAr ?? ''} onChange={(e) => set('nameAr', e.target.value)} />
          </Field>
          <Field label={t('payComponent.typeLabel')}>
            <Select value={c.type} onChange={(e) => set('type', e.target.value as Comp['type'])}>
              {['EARNING', 'DEDUCTION', 'EMPLOYER_CONTRIBUTION'].map((x) => (
                <option key={x} value={x}>
                  {t(`payComponent.type.${x}`)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t('payComponent.calc')}>
            <Select value={c.calcType} onChange={(e) => set('calcType', e.target.value as Comp['calcType'])}>
              {['FIXED', 'PERCENT_OF_BASIC', 'PERCENT_OF_GROSS', 'BRACKET']
                .filter((x) => c.type !== 'EARNING' || x === 'FIXED' || x === 'PERCENT_OF_BASIC')
                .map((x) => (
                  <option key={x} value={x}>
                    {t(`payComponent.calcType.${x}`)}
                  </option>
                ))}
            </Select>
          </Field>
          {c.calcType !== 'BRACKET' && (
            <Field label={c.calcType === 'FIXED' ? t('payComponent.defaultAmount') : t('payComponent.percentage')} hint={t('payComponent.defaultHint')}>
              <Input type="number" step="0.01" value={c.defaultValue ?? ''} onChange={(e) => set('defaultValue', e.target.value)} />
            </Field>
          )}
        </FormGrid>
        {c.calcType === 'BRACKET' && (
          <FormSection title={t('payComponent.brackets')} description={t('payComponent.bracketsHint')}>
            <Field label={t('payComponent.bracketBase')}>
              <Select value={c.bracketBase ?? 'TAXABLE'} onChange={(e) => set('bracketBase', e.target.value)}>
                {['TAXABLE', 'GROSS', 'BASIC'].map((x) => (
                  <option key={x} value={x}>
                    {t(`payComponent.base.${x}`)}
                  </option>
                ))}
              </Select>
            </Field>
            <div className="space-y-2">
              {brackets.map((b, i) => (
                <div key={i} className="flex items-center gap-2">
                  <span className="w-16 text-sm text-ink-3">{t('payComponent.upTo')}</span>
                  <Input type="number" placeholder={t('payComponent.noLimit')} value={b.upTo ?? ''} onChange={(e) => set('brackets', brackets.map((x, j) => (j === i ? { ...x, upTo: e.target.value === '' ? null : Number(e.target.value) } : x)))} />
                  <Input type="number" step="0.01" value={b.rate} onChange={(e) => set('brackets', brackets.map((x, j) => (j === i ? { ...x, rate: Number(e.target.value) } : x)))} className="w-28" aria-label={t('payComponent.rate')} />
                  <span className="text-sm text-ink-3">%</span>
                  <Button size="icon" variant="ghost" icon={<Trash2 className="h-4 w-4" />} aria-label={t('common.remove')} onClick={() => set('brackets', brackets.filter((_, j) => j !== i))} />
                </div>
              ))}
              <Button size="sm" variant="ghost" icon={<Plus className="h-4 w-4" />} onClick={() => set('brackets', [...brackets, { upTo: null, rate: 0 }])}>
                {t('payComponent.addBracket')}
              </Button>
            </div>
          </FormSection>
        )}
        <FormSection title={t('payComponent.limits')}>
          <FormGrid cols={3}>
            <Field label={t('payComponent.minAmount')}>
              <Input type="number" value={c.minAmount ?? ''} onChange={(e) => set('minAmount', e.target.value)} />
            </Field>
            <Field label={t('payComponent.maxAmount')}>
              <Input type="number" value={c.maxAmount ?? ''} onChange={(e) => set('maxAmount', e.target.value)} />
            </Field>
            <Field label={t('payComponent.baseCap')} hint={t('payComponent.baseCapHint')}>
              <Input type="number" value={c.baseCap ?? ''} onChange={(e) => set('baseCap', e.target.value)} />
            </Field>
          </FormGrid>
        </FormSection>
        <FormSection title={t('payComponent.applicability')}>
          <div className="flex flex-col gap-3">
            <Switch checked={!!c.appliesToAll} onChange={(v) => set('appliesToAll', v)} label={t('payComponent.appliesToAllLabel')} />
            {c.type === 'EARNING' && <Checkbox label={t('payComponent.taxable')} checked={c.isTaxable !== false} onChange={(e) => set('isTaxable', e.target.checked)} />}
            {c.type === 'EARNING' && <Checkbox label={t('payComponent.inRateBase')} checked={!!c.includeInRateBase} onChange={(e) => set('includeInRateBase', e.target.checked)} />}
            {c.type === 'EARNING' && <Checkbox label={t('payComponent.pensionable')} checked={!!c.pensionable} onChange={(e) => set('pensionable', e.target.checked)} />}
            <Checkbox label={t('common.active')} checked={c.isActive !== false} onChange={(e) => set('isActive', e.target.checked)} />
          </div>
          <FormGrid cols={3}>
            <Field label={t('payComponent.eligCategories')} hint={t('payComponent.commaList')}>
              <Input value={elig.categoryCodes} onChange={(e) => setElig({ ...elig, categoryCodes: e.target.value })} />
            </Field>
            <Field label={t('payComponent.eligNationalities')} hint={t('payComponent.commaList')}>
              <Input value={elig.nationalities} onChange={(e) => setElig({ ...elig, nationalities: e.target.value })} />
            </Field>
            <Field label={t('payComponent.eligTypes')} hint={t('payComponent.commaList')}>
              <Input value={elig.employmentTypeCodes} onChange={(e) => setElig({ ...elig, employmentTypeCodes: e.target.value })} />
            </Field>
          </FormGrid>
          <Field label={t('payComponent.sortOrder')} className="max-w-[10rem]">
            <Input type="number" value={c.sortOrder ?? 100} onChange={(e) => set('sortOrder', Number(e.target.value))} />
          </Field>
        </FormSection>
      </div>
    </Dialog>
  );
}

type SchemeKey = 'GPSSA_OLD' | 'GPSSA_NEW' | 'ADPF_OLD' | 'ADPF_NEW';
interface PensionRules {
  minBase: number;
  employerRate: number;
  privateSector: boolean;
  subsidyRate: number;
  subsidyThreshold: number;
  schemes: Record<SchemeKey, { employeeRate: number; cap: number | null }>;
}

interface Settings {
  dailyRateBasis: string;
  rateBase: string;
  standardHoursPerDay: string;
  overtimeMultiplier: string;
  weekendOvertimeMultiplier: string;
  holidayOvertimeMultiplier: string;
  nightOvertimeMultiplier: string;
  nightOvertimeStart: string;
  nightOvertimeEnd: string;
  pensionRules: PensionRules;
  deductUnpaidLeave: boolean;
  deductAbsence: boolean;
  deductLateMinutes: boolean;
  lateDeductionGraceMinutesPerMonth: number;
  prorateNewJoiners: boolean;
  roundingDecimals: number;
  paymentDay: number;
  companyBankAccount: string | null;
}

function PayrollSettings() {
  const { t } = useTranslation();
  const { can } = useAuth();
  const { data, isLoading } = useGet<Settings>('/payroll/settings');
  const [s, setS] = useState<Settings | null>(null);
  if (data && !s) setS(data);
  const save = useApiMutation(
    () =>
      api.put('/payroll/settings', {
        ...s,
        standardHoursPerDay: Number(s!.standardHoursPerDay),
        overtimeMultiplier: Number(s!.overtimeMultiplier),
        weekendOvertimeMultiplier: Number(s!.weekendOvertimeMultiplier),
        holidayOvertimeMultiplier: Number(s!.holidayOvertimeMultiplier),
        nightOvertimeMultiplier: Number(s!.nightOvertimeMultiplier),
        bankFileFormat: 'GENERIC_CSV',
      }),
    { invalidate: ['/payroll/settings'] },
  );
  if (isLoading || !s) return <Spinner />;
  const disabled = !can('paycomponent.manage');
  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => setS({ ...s, [k]: v });
  return (
    <Card>
      <div className="space-y-8">
        <FormSection title={t('payrollSettings.rates')} description={t('payrollSettings.ratesHint')}>
          <FormGrid cols={3}>
            <Field label={t('payrollSettings.dailyRateBasis')}>
              <Select disabled={disabled} value={s.dailyRateBasis} onChange={(e) => set('dailyRateBasis', e.target.value)}>
                {['FIXED_30', 'CALENDAR_DAYS', 'WORKING_DAYS'].map((x) => (
                  <option key={x} value={x}>
                    {t(`payrollSettings.basis.${x}`)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={t('payrollSettings.rateBase')}>
              <Select disabled={disabled} value={s.rateBase} onChange={(e) => set('rateBase', e.target.value)}>
                <option value="BASIC">{t('payrollSettings.basicOnly')}</option>
                <option value="GROSS">{t('payrollSettings.basicPlusFlagged')}</option>
              </Select>
            </Field>
            <Field label={t('payrollSettings.hoursPerDay')}>
              <Input disabled={disabled} type="number" step="0.5" value={s.standardHoursPerDay} onChange={(e) => set('standardHoursPerDay', e.target.value)} />
            </Field>
          </FormGrid>
        </FormSection>
        <FormSection title={t('payrollSettings.overtime')}>
          <FormGrid cols={3}>
            <Field label={t('payrollSettings.otWorkday')}>
              <Input disabled={disabled} type="number" step="0.05" value={s.overtimeMultiplier} onChange={(e) => set('overtimeMultiplier', e.target.value)} />
            </Field>
            <Field label={t('payrollSettings.otWeekend')}>
              <Input disabled={disabled} type="number" step="0.05" value={s.weekendOvertimeMultiplier} onChange={(e) => set('weekendOvertimeMultiplier', e.target.value)} />
            </Field>
            <Field label={t('payrollSettings.otHoliday')}>
              <Input disabled={disabled} type="number" step="0.05" value={s.holidayOvertimeMultiplier} onChange={(e) => set('holidayOvertimeMultiplier', e.target.value)} />
            </Field>
            <Field label={t('payrollSettings.otNight')} hint={t('payrollSettings.otNightHint')}>
              <Input disabled={disabled} type="number" step="0.05" value={s.nightOvertimeMultiplier} onChange={(e) => set('nightOvertimeMultiplier', e.target.value)} />
            </Field>
            <Field label={t('payrollSettings.nightStart')}>
              <Input disabled={disabled} type="time" value={s.nightOvertimeStart} onChange={(e) => set('nightOvertimeStart', e.target.value)} />
            </Field>
            <Field label={t('payrollSettings.nightEnd')}>
              <Input disabled={disabled} type="time" value={s.nightOvertimeEnd} onChange={(e) => set('nightOvertimeEnd', e.target.value)} />
            </Field>
          </FormGrid>
          <p className="text-xs text-ink-3">{t('payrollSettings.otEligibilityHint')}</p>
        </FormSection>
        <PensionRulesSection rules={s.pensionRules} disabled={disabled} onChange={(r) => set('pensionRules', r)} />
        <FormSection title={t('payrollSettings.deductions')}>
          <div className="flex flex-col gap-3">
            <Switch disabled={disabled} checked={s.deductUnpaidLeave} onChange={(v) => set('deductUnpaidLeave', v)} label={t('payrollSettings.deductUnpaid')} />
            <Switch disabled={disabled} checked={s.deductAbsence} onChange={(v) => set('deductAbsence', v)} label={t('payrollSettings.deductAbsence')} />
            <Switch disabled={disabled} checked={s.deductLateMinutes} onChange={(v) => set('deductLateMinutes', v)} label={t('payrollSettings.deductLate')} />
            <Switch disabled={disabled} checked={s.prorateNewJoiners} onChange={(v) => set('prorateNewJoiners', v)} label={t('payrollSettings.prorate')} />
          </div>
          <FormGrid cols={3}>
            <Field label={t('payrollSettings.lateGrace')}>
              <Input disabled={disabled} type="number" value={s.lateDeductionGraceMinutesPerMonth} onChange={(e) => set('lateDeductionGraceMinutesPerMonth', Number(e.target.value))} />
            </Field>
            <Field label={t('payrollSettings.rounding')}>
              <Input disabled={disabled} type="number" min={0} max={3} value={s.roundingDecimals} onChange={(e) => set('roundingDecimals', Number(e.target.value))} />
            </Field>
            <Field label={t('payrollSettings.paymentDay')}>
              <Input disabled={disabled} type="number" min={1} max={31} value={s.paymentDay} onChange={(e) => set('paymentDay', Number(e.target.value))} />
            </Field>
          </FormGrid>
        </FormSection>
        {!disabled && (
          <div className="flex justify-end">
            <Button variant="primary" loading={save.isPending} onClick={() => save.mutate(undefined)}>
              {t('common.save')}
            </Button>
          </div>
        )}
      </div>
    </Card>
  );
}

function Currencies() {
  const { t } = useTranslation();
  const { can } = useAuth();
  const { data: currencies = [] } = useGet<{ code: string; name: string; symbol: string; decimals: number }[]>('/payroll/currencies');
  const { data: rates = [] } = useGet<{ id: string; fromCurrency: string; toCurrency: string; rate: string; date: string }[]>('/payroll/exchange-rates');
  const [r, setR] = useState({ fromCurrency: 'USD', toCurrency: 'AED', rate: '', date: new Date().toISOString().slice(0, 10) });
  const add = useApiMutation(() => api.post('/payroll/exchange-rates', { ...r, rate: Number(r.rate) }), { invalidate: ['/payroll/exchange-rates'], onSuccess: () => setR({ ...r, rate: '' }) });
  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <Card padded={false}>
        <div className="border-b border-line p-4 font-semibold">{t('payroll.currencies')}</div>
        <DataTable rows={currencies} rowKey={(c) => c.code} dense columns={[{ key: 'code', header: t('org.code'), cell: (c) => <span className="font-mono">{c.code}</span> }, { key: 'name', header: t('common.name'), cell: (c) => c.name }, { key: 'dec', header: t('payroll.decimals'), align: 'end', cell: (c) => c.decimals }]} />
      </Card>
      <Card padded={false}>
        <div className="border-b border-line p-4 font-semibold">{t('payroll.exchangeRates')}</div>
        {can('paycomponent.manage') && (
          <div className="grid grid-cols-2 gap-2 border-b border-line p-4 sm:grid-cols-5">
            <Select value={r.fromCurrency} onChange={(e) => setR({ ...r, fromCurrency: e.target.value })} aria-label={t('approvals.from')}>
              {currencies.map((c) => <option key={c.code}>{c.code}</option>)}
            </Select>
            <Select value={r.toCurrency} onChange={(e) => setR({ ...r, toCurrency: e.target.value })} aria-label={t('approvals.to')}>
              {currencies.map((c) => <option key={c.code}>{c.code}</option>)}
            </Select>
            <Input type="number" step="0.0001" placeholder={t('payComponent.rate')} value={r.rate} onChange={(e) => setR({ ...r, rate: e.target.value })} />
            <Input type="date" value={r.date} onChange={(e) => setR({ ...r, date: e.target.value })} />
            <Button variant="primary" disabled={!Number(r.rate) || r.fromCurrency === r.toCurrency} loading={add.isPending} onClick={() => add.mutate(undefined)}>
              {t('common.add')}
            </Button>
          </div>
        )}
        <DataTable rows={rates} rowKey={(x) => x.id} dense empty={{ title: t('payroll.noRates') }} columns={[{ key: 'pair', header: t('payroll.pair'), cell: (x) => `${x.fromCurrency} → ${x.toCurrency}` }, { key: 'rate', header: t('payComponent.rate'), align: 'end', cell: (x) => fmtNumber(Number(x.rate), 4) }, { key: 'date', header: t('common.date'), cell: (x) => fmtDate(x.date) }]} />
      </Card>
    </div>
  );
}

/** Statutory pension rates, caps and the GPSSA subsidy (UAE defaults, editable). */
function PensionRulesSection({ rules, disabled, onChange }: { rules: PensionRules; disabled: boolean; onChange: (r: PensionRules) => void }) {
  const { t } = useTranslation();
  const num = (v: string) => (v === '' ? 0 : Number(v));
  const setScheme = (k: SchemeKey, patch: Partial<PensionRules['schemes'][SchemeKey]>) => onChange({ ...rules, schemes: { ...rules.schemes, [k]: { ...rules.schemes[k], ...patch } } });
  return (
    <FormSection title={t('payrollSettings.pension')} description={t('payrollSettings.pensionHint')}>
      <FormGrid cols={3}>
        <Field label={t('payrollSettings.pensionEmployerRate')}>
          <Input disabled={disabled} type="number" step="0.5" value={rules.employerRate} onChange={(e) => onChange({ ...rules, employerRate: num(e.target.value) })} />
        </Field>
        <Field label={t('payrollSettings.pensionMinBase')}>
          <Input disabled={disabled} type="number" step="100" value={rules.minBase} onChange={(e) => onChange({ ...rules, minBase: num(e.target.value) })} />
        </Field>
        <div />
        <Field label={t('payrollSettings.pensionSubsidyRate')}>
          <Input disabled={disabled} type="number" step="0.5" value={rules.subsidyRate} onChange={(e) => onChange({ ...rules, subsidyRate: num(e.target.value) })} />
        </Field>
        <Field label={t('payrollSettings.pensionSubsidyThreshold')}>
          <Input disabled={disabled} type="number" step="500" value={rules.subsidyThreshold} onChange={(e) => onChange({ ...rules, subsidyThreshold: num(e.target.value) })} />
        </Field>
        <div className="flex items-end pb-2">
          <Switch disabled={disabled} checked={rules.privateSector} onChange={(v) => onChange({ ...rules, privateSector: v })} label={t('payrollSettings.pensionPrivateSector')} />
        </div>
      </FormGrid>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-start text-xs text-ink-3">
              <th className="py-2 text-start font-medium">{t('employees.pensionScheme')}</th>
              <th className="py-2 text-start font-medium">{t('payrollSettings.pensionEmployeeRate')}</th>
              <th className="py-2 text-start font-medium">{t('payrollSettings.pensionCap')}</th>
            </tr>
          </thead>
          <tbody>
            {(['GPSSA_OLD', 'GPSSA_NEW', 'ADPF_OLD', 'ADPF_NEW'] as SchemeKey[]).map((k) => (
              <tr key={k} className="border-t border-line">
                <td className="py-2 pe-3">{t(`employees.pension.${k}`)}</td>
                <td className="py-2 pe-3">
                  <Input disabled={disabled} type="number" step="0.5" aria-label={`${t(`employees.pension.${k}`)} – ${t('payrollSettings.pensionEmployeeRate')}`} value={rules.schemes[k].employeeRate} onChange={(e) => setScheme(k, { employeeRate: num(e.target.value) })} />
                </td>
                <td className="py-2">
                  <Input disabled={disabled} type="number" step="1000" placeholder={t('payrollSettings.noCap')} aria-label={`${t(`employees.pension.${k}`)} – ${t('payrollSettings.pensionCap')}`} value={rules.schemes[k].cap ?? ''} onChange={(e) => setScheme(k, { cap: e.target.value === '' ? null : Number(e.target.value) })} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </FormSection>
  );
}
