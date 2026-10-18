import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, Ban, Calculator, Check, CircleDollarSign, Download, FileSpreadsheet, FileText, Lock, PauseCircle, Plus, RotateCcw, Send, ShieldCheck, Trash2, Undo2 } from 'lucide-react';
import { toast } from '@/lib/toast';
import { api, download, openFile } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { errorMessage, useApiMutation, useGet, usePaged } from '@/lib/hooks';
import { fmtDate, fmtDateTime, fmtMinutes, fmtMoney, fmtMonth, fmtNumber } from '@/lib/format';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Field, FormGrid, Input, SearchInput, Select } from '@/components/ui/form';
import { Alert, Badge, Card, CardHeader, ErrorState, Spinner, StatTile, StatusBadge } from '@/components/ui/display';
import { Dialog, Drawer, useConfirm } from '@/components/ui/dialog';
import { Tabs } from '@/components/ui/nav';
import { DataTable, Pagination } from '@/components/ui/table';
import { EmployeePicker } from '@/components/ui/pickers';
import { BarList } from '@/components/charts';
import type { Run } from './Payroll';

interface RunDetailData extends Run {
  events: { id: string; action: string; actor: string | null; comment: string | null; createdAt: string; totals: Record<string, unknown> | null }[];
  adjustments: { id: string; type: string; code: string; description: string; amount: string; employee: { employeeNo: string; firstName: string; lastName: string } }[];
  approval: { id: string; status: string; currentStep: number } | null;
}

export interface Slip {
  id: string;
  employeeId: string;
  currency: string;
  basicSalary: string;
  grossEarnings: string;
  totalDeductions: string;
  netPay: string;
  employerCost: string;
  periodDays: number;
  payableDays: string;
  unpaidLeaveDays: string;
  absentDays: string;
  overtimeMinutes: number;
  lateMinutes: number;
  paymentStatus: string;
  snapshot: { employeeNo: string; name: string; department: string | null; branch: string | null; position: string | null; warnings?: string[]; dailyRate?: string };
  lines: { id: string; componentCode: string; name: string; nameAr: string | null; type: string; source: string; quantity: string | null; rate: string | null; amount: string }[];
}

const STEPS = ['DRAFT', 'CALCULATED', 'PENDING_APPROVAL', 'APPROVED', 'PAID'];

export default function RunDetail() {
  const { id } = useParams();
  const { t } = useTranslation();
  const { can } = useAuth();
  const confirm = useConfirm();
  const [tab, setTab] = useState<'payslips' | 'summary' | 'adjustments' | 'issues' | 'events'>('payslips');
  const [calcResult, setCalcResult] = useState<{ skipped: { employeeNo: string; name: string; reason: string }[]; warnings: { employeeNo: string; name: string; warning: string }[] } | null>(null);
  const { data: run, isLoading, error, refetch } = useGet<RunDetailData>(`/payroll/runs/${id}`);
  const inv = ['/payroll', '/approvals', '/dashboard'];
  const calculate = useApiMutation(() => api.post<{ skipped: never[]; warnings: never[] }>(`/payroll/runs/${id}/calculate`), {
    success: t('payroll.calculated'),
    invalidate: inv,
    onSuccess: (r) => {
      setCalcResult(r);
      if (r.skipped.length || r.warnings.length) setTab('issues');
    },
  });
  const act = useApiMutation(({ path, body }: { path: string; body?: unknown }) => api.post(`/payroll/runs/${id}/${path}`, body ?? {}), { invalidate: inv });

  if (isLoading) return <Spinner />;
  if (error || !run) return <ErrorState error={error} onRetry={() => refetch()} />;
  const stepIndex = STEPS.indexOf(run.status);
  const editable = ['DRAFT', 'CALCULATED'].includes(run.status);

  const doSubmit = async () => {
    const r = await confirm({ title: t('payroll.submitTitle'), message: t('payroll.submitText', { net: fmtMoney(run.totalNet, run.currency), count: run.employeeCount }), confirmLabel: t('payroll.submit'), reason: { label: t('approvals.comment') } });
    if (r) act.mutate({ path: 'submit', body: { comment: r.reason || undefined } });
  };
  const doReopen = async () => {
    const r = await confirm({ title: t('payroll.reopenTitle'), message: t('payroll.reopenText'), tone: 'danger', confirmLabel: t('payroll.reopen'), reason: { label: t('payroll.reopenReason'), required: true, minLength: 5 } });
    if (r) act.mutate({ path: 'reopen', body: { reason: r.reason } });
  };
  const doPay = async () => {
    const r = await confirm({ title: t('payroll.payTitle'), message: t('payroll.payText', { net: fmtMoney(run.totalNet, run.currency) }), confirmLabel: t('payroll.markPaid'), reason: { label: t('payroll.paymentReference') } });
    if (r) act.mutate({ path: 'pay', body: { reference: r.reason || undefined } });
  };
  const doCancel = async () => {
    const r = await confirm({ title: t('payroll.cancelTitle'), tone: 'danger', confirmLabel: t('payroll.cancelRun'), reason: { label: t('leave.reason') } });
    if (r) act.mutate({ path: 'cancel', body: { reason: r.reason || undefined } });
  };
  const bankFile = async () => {
    try {
      const res = await download(`/payroll/runs/${id}/bank-file`);
      const missing = res.headers.get('X-Missing-Bank-Details');
      if (missing) toast.warning(t('payroll.missingBank', { list: missing }));
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  return (
    <div className="space-y-6">
      <Link to="/payroll" className="inline-flex items-center gap-1 text-sm text-ink-3 hover:text-ink">
        <ArrowLeft className="h-4 w-4 rtl:rotate-180" /> {t('payroll.runs')}
      </Link>
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-semibold">{t('payroll.runTitle', { period: fmtMonth(run.year, run.month) })}</h1>
            <StatusBadge status={run.status} />
            {run.lockedAt && (
              <Badge tone="neutral">
                <Lock className="h-3 w-3" /> {t('payroll.locked')}
              </Badge>
            )}
          </div>
          <p className="mt-1 text-sm text-ink-3">
            {fmtDate(run.periodStart)} – {fmtDate(run.periodEnd)}
            {run.reopenCount > 0 && ` · ${t('payroll.reopenedTimes', { count: run.reopenCount })}`}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {editable && can('payroll.run') && (
            <Button variant={run.status === 'DRAFT' ? 'primary' : 'secondary'} icon={<Calculator className="h-4 w-4" />} loading={calculate.isPending} onClick={() => calculate.mutate(undefined)}>
              {run.status === 'DRAFT' && !run.calculatedAt ? t('payroll.calculate') : t('payroll.recalculate')}
            </Button>
          )}
          {run.status === 'CALCULATED' && can('payroll.run') && (
            <Button variant="primary" icon={<Send className="h-4 w-4" />} loading={act.isPending} onClick={doSubmit}>
              {t('payroll.submit')}
            </Button>
          )}
          {run.status === 'PENDING_APPROVAL' && run.approval && (
            <Link to={`/approvals/${run.approval.id}`}>
              <Button variant="primary" icon={<ShieldCheck className="h-4 w-4" />}>
                {t('payroll.reviewApproval')}
              </Button>
            </Link>
          )}
          {run.status === 'PENDING_APPROVAL' && can('payroll.run') && (
            <Button icon={<Undo2 className="h-4 w-4" />} onClick={() => act.mutate({ path: 'withdraw' })}>
              {t('payroll.withdraw')}
            </Button>
          )}
          {run.status === 'APPROVED' && can('payroll.pay') && (
            <>
              <Button icon={<Download className="h-4 w-4" />} onClick={bankFile}>
                {t('payroll.bankFile')}
              </Button>
              <Button variant="success" icon={<CircleDollarSign className="h-4 w-4" />} onClick={doPay}>
                {t('payroll.markPaid')}
              </Button>
            </>
          )}
          {run.status === 'PAID' && can('payroll.pay') && (
            <Button icon={<Download className="h-4 w-4" />} onClick={bankFile}>
              {t('payroll.bankFile')}
            </Button>
          )}
          {run.status === 'APPROVED' && can('payroll.reopen') && (
            <Button icon={<RotateCcw className="h-4 w-4" />} onClick={doReopen}>
              {t('payroll.reopen')}
            </Button>
          )}
          <Button icon={<FileSpreadsheet className="h-4 w-4" />} onClick={() => download(`/payroll/runs/${id}/register`)} disabled={!run.employeeCount}>
            {t('payroll.register')}
          </Button>
          {editable && can('payroll.run') && (
            <Button variant="ghost" icon={<Ban className="h-4 w-4" />} onClick={doCancel}>
              {t('payroll.cancelRun')}
            </Button>
          )}
        </div>
      </div>

      {run.status !== 'CANCELLED' && (
        <ol className="flex flex-wrap items-center gap-2 text-xs sm:gap-0" aria-label={t('payroll.progress')}>
          {STEPS.map((s, i) => (
            <li key={s} className="flex items-center">
              <span className={cn('flex items-center gap-1.5 rounded-full px-3 py-1 font-medium', i < stepIndex ? 'bg-success-soft text-success-ink' : i === stepIndex ? 'bg-primary text-primary-fg' : 'bg-subtle text-ink-3')}>
                {i < stepIndex && <Check className="h-3 w-3" />}
                {t(`status.${s}`)}
              </span>
              {i < STEPS.length - 1 && <span className="mx-1 hidden h-px w-6 bg-line sm:block" aria-hidden />}
            </li>
          ))}
        </ol>
      )}

      {run.status === 'DRAFT' && run.calculatedAt && <Alert tone="warning">{t('payroll.needsRecalc')}</Alert>}

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
        <StatTile label={t('dashboard.employees')} value={fmtNumber(run.employeeCount)} />
        <StatTile label={t('payroll.gross')} value={fmtMoney(run.totalGross, run.currency, { compact: true })} caption={fmtMoney(run.totalGross, run.currency)} />
        <StatTile label={t('payroll.deductions')} value={fmtMoney(run.totalDeductions, run.currency, { compact: true })} caption={fmtMoney(run.totalDeductions, run.currency)} />
        <StatTile label={t('payroll.net')} value={fmtMoney(run.totalNet, run.currency, { compact: true })} caption={fmtMoney(run.totalNet, run.currency)} />
        <StatTile label={t('payroll.employerCost')} value={fmtMoney(run.totalEmployerCost, run.currency, { compact: true })} caption={fmtMoney(run.totalEmployerCost, run.currency)} />
      </div>

      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'payslips', label: t('payroll.payslips') },
          { id: 'summary', label: t('payroll.summary') },
          { id: 'adjustments', label: t('payroll.adjustments'), count: run.adjustments.length },
          { id: 'issues', label: t('payroll.issues'), count: calcResult ? calcResult.skipped.length + calcResult.warnings.length : undefined, hidden: !calcResult },
          { id: 'events', label: t('payroll.events') },
        ]}
      />
      {tab === 'payslips' && <Payslips runId={run.id} canHold={run.status === 'APPROVED' && can('payroll.pay')} />}
      {tab === 'summary' && <Summary runId={run.id} currency={run.currency} />}
      {tab === 'adjustments' && <Adjustments run={run} editable={editable && can('payroll.run')} />}
      {tab === 'issues' && calcResult && <Issues result={calcResult} />}
      {tab === 'events' && <Events run={run} />}
    </div>
  );
}

function Payslips({ runId, canHold }: { runId: string; canHold: boolean }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState<Slip | null>(null);
  const list = usePaged<Slip>(`/payroll/runs/${runId}/payslips`, {}, { pageSize: 25 });
  return (
    <Card padded={false}>
      <div className="border-b border-line p-4">
        <SearchInput className="max-w-xs" placeholder={t('employees.searchPlaceholder')} value={list.search} onChange={(e) => list.setSearch(e.target.value)} />
      </div>
      <DataTable
        rows={list.data?.items}
        loading={list.isLoading}
        rowKey={(p) => p.id}
        onRowClick={setOpen}
        sort={list.sort}
        onSort={list.setSort}
        empty={{ title: t('payroll.noPayslips'), description: t('payroll.noPayslipsHint') }}
        columns={[
          {
            key: 'emp',
            header: t('common.employee'),
            cell: (p) => (
              <div>
                <p className="font-medium">{p.snapshot.name}</p>
                <p className="text-xs text-ink-3">
                  {p.snapshot.employeeNo} · {p.snapshot.department ?? '—'}
                </p>
              </div>
            ),
          },
          { key: 'days', header: t('payroll.payableDays'), align: 'end', hideBelow: 'md', cell: (p) => `${fmtNumber(Number(p.payableDays), Number(p.payableDays) % 1 ? 1 : 0)} / ${p.periodDays}` },
          { key: 'gross', header: t('payroll.gross'), sort: 'grossEarnings', align: 'end', hideBelow: 'sm', cell: (p) => fmtMoney(p.grossEarnings, p.currency) },
          { key: 'ded', header: t('payroll.deductions'), sort: 'totalDeductions', align: 'end', hideBelow: 'md', cell: (p) => fmtMoney(p.totalDeductions, p.currency) },
          { key: 'net', header: t('payroll.net'), sort: 'netPay', align: 'end', cell: (p) => <span className={cn('font-semibold', Number(p.netPay) < 0 && 'text-danger-ink')}>{fmtMoney(p.netPay, p.currency)}</span> },
          { key: 'pay', header: t('payroll.payment'), hideBelow: 'lg', cell: (p) => <StatusBadge status={p.paymentStatus} /> },
          { key: 'w', header: '', cell: (p) => !!p.snapshot.warnings?.length && <Badge tone="warning">{t('payroll.warning')}</Badge> },
        ]}
      />
      {list.data && <Pagination page={list.page} pageCount={list.data.pageCount} total={list.data.total} pageSize={list.pageSize} onPage={list.setPage} onPageSize={list.setPageSize} />}
      <PayslipDrawer slip={open} onClose={() => setOpen(null)} canHold={canHold} />
    </Card>
  );
}

export function PayslipBody({ slip }: { slip: Slip }) {
  const { t } = useTranslation();
  const sections: [string, string][] = [
    ['EARNING', t('payroll.earnings')],
    ['DEDUCTION', t('payroll.deductions')],
    ['EMPLOYER_CONTRIBUTION', t('payroll.employerContributions')],
  ];
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 text-sm">
        <div className="rounded-lg bg-subtle p-3">
          <p className="text-xs text-ink-3">{t('payroll.payableDays')}</p>
          <p className="font-semibold tabular">{fmtNumber(Number(slip.payableDays), 1)} / {slip.periodDays}</p>
        </div>
        <div className="rounded-lg bg-subtle p-3">
          <p className="text-xs text-ink-3">{t('attendance.overtime')}</p>
          <p className="font-semibold">{fmtMinutes(slip.overtimeMinutes)}</p>
        </div>
        <div className="rounded-lg bg-subtle p-3">
          <p className="text-xs text-ink-3">{t('payroll.unpaidLeave')}</p>
          <p className="font-semibold tabular">{fmtNumber(Number(slip.unpaidLeaveDays), 1)}</p>
        </div>
        <div className="rounded-lg bg-subtle p-3">
          <p className="text-xs text-ink-3">{t('payroll.absentDays')}</p>
          <p className="font-semibold tabular">{fmtNumber(Number(slip.absentDays), 1)}</p>
        </div>
      </div>
      {sections.map(([type, label]) => {
        const lines = slip.lines.filter((l) => l.type === type);
        if (!lines.length) return null;
        const total = lines.reduce((a, l) => a + Number(l.amount), 0);
        return (
          <div key={type}>
            <h3 className="mb-2 text-sm font-semibold">{label}</h3>
            <ul className="divide-y divide-line text-sm">
              {lines.map((l) => (
                <li key={l.id} className="flex justify-between gap-3 py-1.5">
                  <span className="text-ink-2">
                    {l.name}
                    {l.quantity && <span className="text-xs text-ink-3"> · {fmtNumber(Number(l.quantity), 2)} {l.source === 'OVERTIME' || l.source === 'LATE' ? t('payroll.hoursShort') : t('payroll.daysShort')}</span>}
                  </span>
                  <span className="tabular">{fmtMoney(l.amount, slip.currency)}</span>
                </li>
              ))}
              <li className="flex justify-between py-1.5 font-semibold">
                <span>{t('common.total')}</span>
                <span className="tabular">{fmtMoney(total, slip.currency)}</span>
              </li>
            </ul>
          </div>
        );
      })}
      <div className="flex items-center justify-between rounded-xl bg-primary px-4 py-3 text-primary-fg">
        <span className="font-medium">{t('payroll.netPay')}</span>
        <span className="text-xl font-semibold tabular">{fmtMoney(slip.netPay, slip.currency)}</span>
      </div>
      {!!slip.snapshot.warnings?.length && <Alert tone="warning">{slip.snapshot.warnings.join(' ')}</Alert>}
    </div>
  );
}

function PayslipDrawer({ slip, onClose, canHold }: { slip: Slip | null; onClose: () => void; canHold: boolean }) {
  const { t } = useTranslation();
  const hold = useApiMutation((h: boolean) => api.put(`/payroll/payslips/${slip!.id}/hold`, { hold: h }), { invalidate: ['/payroll'], onSuccess: onClose });
  if (!slip) return null;
  return (
    <Drawer
      open
      onClose={onClose}
      title={`${slip.snapshot.name} · ${slip.snapshot.employeeNo}`}
      footer={
        <>
          {canHold && (
            <Button icon={<PauseCircle className="h-4 w-4" />} onClick={() => hold.mutate(slip.paymentStatus !== 'ON_HOLD')}>
              {slip.paymentStatus === 'ON_HOLD' ? t('payroll.release') : t('payroll.hold')}
            </Button>
          )}
          <Button variant="primary" icon={<FileText className="h-4 w-4" />} onClick={() => openFile(`/payroll/payslips/${slip.id}/pdf`)}>
            {t('payroll.pdf')}
          </Button>
        </>
      }
    >
      <p className="mb-4 text-sm text-ink-3">{[slip.snapshot.position, slip.snapshot.department, slip.snapshot.branch].filter(Boolean).join(' · ')}</p>
      <PayslipBody slip={slip} />
    </Drawer>
  );
}

function Summary({ runId, currency }: { runId: string; currency: string }) {
  const { t } = useTranslation();
  const { data, isLoading } = useGet<{ byDepartment: { name: string; employees: number; gross: number; deductions: number; net: number; employerCost: number }[]; byBranch: { name: string; employees: number; net: number; employerCost: number }[]; byComponent: { code: string; name: string; type: string; amount: number }[] }>(`/payroll/runs/${runId}/summary`);
  const { data: rec } = useGet<{ ok: boolean; issues: string[] }>(`/payroll/runs/${runId}/reconcile`);
  if (isLoading || !data) return <Spinner />;
  return (
    <div className="space-y-6">
      {rec && (
        <Alert tone={rec.ok ? 'success' : 'danger'} title={rec.ok ? t('payroll.reconciled') : t('payroll.notReconciled')}>
          {rec.ok ? t('payroll.reconciledHint') : rec.issues.join(' · ')}
        </Alert>
      )}
      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader title={t('payroll.costByDepartment')} />
          <BarList items={data.byDepartment.map((d) => ({ label: `${d.name} (${d.employees})`, value: d.employerCost }))} format={(v) => fmtMoney(v, currency, { compact: true })} />
        </Card>
        <Card>
          <CardHeader title={t('payroll.costByBranch')} />
          <BarList items={data.byBranch.map((d) => ({ label: `${d.name} (${d.employees})`, value: d.employerCost }))} format={(v) => fmtMoney(v, currency, { compact: true })} />
        </Card>
      </div>
      <Card padded={false}>
        <div className="border-b border-line p-4 font-semibold">{t('payroll.byComponent')}</div>
        <DataTable
          rows={data.byComponent}
          rowKey={(c) => c.code + c.type}
          dense
          columns={[
            { key: 'name', header: t('payroll.component'), cell: (c) => c.name },
            { key: 'type', header: t('payComponent.typeLabel'), cell: (c) => <Badge tone={c.type === 'EARNING' ? 'success' : c.type === 'DEDUCTION' ? 'danger' : 'info'}>{t(`payComponent.type.${c.type}`)}</Badge> },
            { key: 'amt', header: t('salary.amount'), align: 'end', cell: (c) => fmtMoney(c.amount, currency) },
          ]}
        />
      </Card>
    </div>
  );
}

function Adjustments({ run, editable }: { run: RunDetailData; editable: boolean }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const remove = useApiMutation((adjId: string) => api.delete(`/payroll/runs/${run.id}/adjustments/${adjId}`), { invalidate: ['/payroll'] });
  return (
    <Card padded={false}>
      <div className="flex items-center justify-between border-b border-line p-4">
        <p className="text-sm text-ink-3">{t('payroll.adjustmentsHint')}</p>
        {editable && (
          <Button variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => setOpen(true)}>
            {t('payroll.addAdjustment')}
          </Button>
        )}
      </div>
      <DataTable
        rows={run.adjustments}
        rowKey={(a) => a.id}
        empty={{ title: t('payroll.noAdjustments') }}
        columns={[
          { key: 'emp', header: t('common.employee'), cell: (a) => `${a.employee.firstName} ${a.employee.lastName} · ${a.employee.employeeNo}` },
          { key: 'type', header: t('payComponent.typeLabel'), cell: (a) => <Badge tone={a.type === 'EARNING' ? 'success' : 'danger'}>{t(`payComponent.type.${a.type}`)}</Badge> },
          { key: 'desc', header: t('payroll.description'), cell: (a) => a.description },
          { key: 'amt', header: t('salary.amount'), align: 'end', cell: (a) => fmtMoney(a.amount, run.currency) },
          { key: 'x', header: '', align: 'end', cell: (a) => editable && <Button size="icon" variant="ghost" aria-label={t('common.remove')} icon={<Trash2 className="h-4 w-4 text-danger" />} onClick={() => remove.mutate(a.id)} /> },
        ]}
      />
      <AdjustmentDialog open={open} onClose={() => setOpen(false)} runId={run.id} />
    </Card>
  );
}

function AdjustmentDialog({ open, onClose, runId }: { open: boolean; onClose: () => void; runId: string }) {
  const { t } = useTranslation();
  const [employeeId, setEmp] = useState<string | null>(null);
  const [type, setType] = useState('EARNING');
  const [code, setCode] = useState('');
  const [description, setDesc] = useState('');
  const [amount, setAmount] = useState('');
  const save = useApiMutation(() => api.post(`/payroll/runs/${runId}/adjustments`, { employeeId, type, code: code || undefined, description, amount: Number(amount) }), { success: t('payroll.adjustmentAdded'), invalidate: ['/payroll'], onSuccess: () => (setDesc(''), setAmount(''), onClose()) });
  return (
    <Dialog open={open} onClose={onClose} title={t('payroll.addAdjustment')} footer={<><Button onClick={onClose}>{t('common.cancel')}</Button><Button variant="primary" disabled={!employeeId || description.length < 2 || !Number(amount)} loading={save.isPending} onClick={() => save.mutate(undefined)}>{t('common.add')}</Button></>}>
      <div className="space-y-4">
        <Field label={t('common.employee')} required>
          <EmployeePicker value={employeeId} onChange={(id) => setEmp(id)} />
        </Field>
        <FormGrid>
          <Field label={t('payComponent.typeLabel')}>
            <Select value={type} onChange={(e) => setType(e.target.value)}>
              <option value="EARNING">{t('payComponent.type.EARNING')}</option>
              <option value="DEDUCTION">{t('payComponent.type.DEDUCTION')}</option>
            </Select>
          </Field>
          <Field label={t('org.code')} hint={t('payroll.adjustmentCodeHint')}>
            <Input value={code} maxLength={20} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="BONUS" />
          </Field>
          <Field label={t('payroll.description')} required>
            <Input value={description} onChange={(e) => setDesc(e.target.value)} />
          </Field>
          <Field label={t('salary.amount')} required>
            <Input type="number" min={0} step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} />
          </Field>
        </FormGrid>
      </div>
    </Dialog>
  );
}

function Issues({ result }: { result: { skipped: { employeeNo: string; name: string; reason: string }[]; warnings: { employeeNo: string; name: string; warning: string }[] } }) {
  const { t } = useTranslation();
  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <Card>
        <CardHeader title={t('payroll.skipped', { count: result.skipped.length })} subtitle={t('payroll.skippedHint')} />
        <ul className="divide-y divide-line text-sm">
          {result.skipped.map((s) => (
            <li key={s.employeeNo} className="flex justify-between gap-3 py-2">
              <span>
                {s.name} <span className="text-ink-3">· {s.employeeNo}</span>
              </span>
              <span className="text-ink-2">{s.reason}</span>
            </li>
          ))}
          {!result.skipped.length && <li className="py-2 text-ink-3">{t('payroll.none')}</li>}
        </ul>
      </Card>
      <Card>
        <CardHeader title={t('payroll.warnings', { count: result.warnings.length })} />
        <ul className="divide-y divide-line text-sm">
          {result.warnings.map((w, i) => (
            <li key={i} className="py-2">
              {w.name} <span className="text-ink-3">· {w.employeeNo}</span>
              <p className="text-warning-ink">{w.warning}</p>
            </li>
          ))}
          {!result.warnings.length && <li className="py-2 text-ink-3">{t('payroll.none')}</li>}
        </ul>
      </Card>
    </div>
  );
}

function Events({ run }: { run: RunDetailData }) {
  const { t } = useTranslation();
  return (
    <Card>
      <ol className="relative space-y-5 border-s border-line ps-6">
        {run.events.map((e) => (
          <li key={e.id} className="relative text-sm">
            <span className="absolute -start-[1.95rem] top-1 h-3 w-3 rounded-full border-2 border-surface bg-primary" aria-hidden />
            <p className="font-medium">{t(`payroll.event.${e.action}`, e.action)}</p>
            <p className="text-xs text-ink-3">
              {fmtDateTime(e.createdAt)}
              {e.actor && ` · ${e.actor}`}
            </p>
            {e.comment && <p className="mt-1 rounded-lg bg-subtle px-3 py-2 text-ink-2">{e.comment}</p>}
            {e.totals && 'totalNet' in e.totals && <p className="mt-1 text-xs text-ink-3 tabular">{t('payroll.eventTotals', { count: Number(e.totals.employeeCount), net: fmtMoney(String(e.totals.totalNet), run.currency) })}</p>}
          </li>
        ))}
      </ol>
    </Card>
  );
}
