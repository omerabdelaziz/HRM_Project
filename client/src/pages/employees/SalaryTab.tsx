import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus, Trash2 } from 'lucide-react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useApiMutation, useGet } from '@/lib/hooks';
import { localized, personName } from '@/lib/i18n';
import { fmtDate, fmtMoney, fmtNumber } from '@/lib/format';
import type { Employee } from '@/lib/types';
import { Button } from '@/components/ui/button';
import { Field, FieldErrors, FormGrid, Input, Select } from '@/components/ui/form';
import { Alert, Badge, Card, CardHeader, EmptyState, Spinner, StatusBadge } from '@/components/ui/display';
import { Dialog } from '@/components/ui/dialog';

export interface PayComponent {
  id: string;
  code: string;
  name: string;
  nameAr: string | null;
  type: 'EARNING' | 'DEDUCTION' | 'EMPLOYER_CONTRIBUTION';
  calcType: 'FIXED' | 'PERCENT_OF_BASIC' | 'PERCENT_OF_GROSS' | 'BRACKET';
  appliesToAll: boolean;
  isActive: boolean;
}

interface Structure {
  id: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  basicSalary: string;
  currency: string;
  status: string;
  reason: string | null;
  items: { id: string; amount: string; component: Pick<PayComponent, 'id' | 'code' | 'name' | 'nameAr' | 'type' | 'calcType'> }[];
}

export function SalaryTab({ employee }: { employee: Employee }) {
  const { t } = useTranslation();
  const { can } = useAuth();
  const [open, setOpen] = useState(false);
  const { data, isLoading } = useGet<Structure[]>(`/payroll/salaries/${employee.id}`);
  if (isLoading) return <Spinner />;
  const current = data?.find((s) => s.status === 'ACTIVE' && (!s.effectiveTo || s.effectiveTo >= new Date().toISOString().slice(0, 10)) && s.effectiveFrom <= new Date().toISOString());
  const separated = ['RESIGNED', 'TERMINATED', 'RETIRED'].includes(employee.status);
  const monthly = (s: Structure) =>
    Number(s.basicSalary) +
    s.items.filter((i) => i.component.type === 'EARNING').reduce((a, i) => a + (i.component.calcType === 'PERCENT_OF_BASIC' ? (Number(s.basicSalary) * Number(i.amount)) / 100 : Number(i.amount)), 0);

  return (
    <div className="space-y-6">
      {current && (
        <div className="grid gap-4 sm:grid-cols-3">
          <Card>
            <p className="text-sm text-ink-2">{t('salary.basic')}</p>
            <p className="mt-2 text-2xl font-semibold tabular">{fmtMoney(current.basicSalary, current.currency)}</p>
          </Card>
          <Card>
            <p className="text-sm text-ink-2">{t('salary.fixedMonthly')}</p>
            <p className="mt-2 text-2xl font-semibold tabular">{fmtMoney(monthly(current), current.currency)}</p>
            <p className="text-xs text-ink-3">{t('salary.beforeDeductions')}</p>
          </Card>
          <Card>
            <p className="text-sm text-ink-2">{t('salary.effectiveSince')}</p>
            <p className="mt-2 text-2xl font-semibold">{fmtDate(current.effectiveFrom)}</p>
          </Card>
        </div>
      )}
      <Card>
        <CardHeader
          title={t('salary.history')}
          actions={
            can('employee.salary.manage') &&
            !separated && (
              <Button size="sm" variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => setOpen(true)}>
                {data?.length ? t('salary.change') : t('salary.setup')}
              </Button>
            )
          }
        />
        {!data?.length ? (
          <EmptyState title={t('salary.none')} description={t('salary.noneHint')} />
        ) : (
          <div className="space-y-4">
            {data.map((s) => (
              <div key={s.id} className="rounded-lg border border-line p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <span className="font-medium">
                      {fmtDate(s.effectiveFrom)} – {s.effectiveTo ? fmtDate(s.effectiveTo) : t('salary.present')}
                    </span>
                    {s.status !== 'ACTIVE' && <StatusBadge status={s.status === 'PENDING' ? 'PENDING' : 'REJECTED'} />}
                    {s === current && <Badge tone="success">{t('salary.current')}</Badge>}
                  </div>
                  <span className="text-lg font-semibold tabular">{fmtMoney(s.basicSalary, s.currency)}</span>
                </div>
                {s.reason && <p className="mt-1 text-sm text-ink-3">{s.reason}</p>}
                {s.items.length > 0 && (
                  <ul className="mt-3 grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
                    {s.items.map((i) => (
                      <li key={i.id} className="flex justify-between gap-3">
                        <span className="text-ink-2">
                          {localized(i.component as unknown as Record<string, unknown>, 'name')}
                          {i.component.type === 'DEDUCTION' && <span className="text-ink-3"> ({t('salary.deduction')})</span>}
                        </span>
                        <span className="tabular">{i.component.calcType === 'PERCENT_OF_BASIC' ? `${fmtNumber(Number(i.amount), 2)}%` : fmtMoney(i.amount, s.currency)}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            ))}
          </div>
        )}
      </Card>
      <SalaryDialog open={open} onClose={() => setOpen(false)} employee={employee} current={current ?? data?.[0]} />
    </div>
  );
}

function SalaryDialog({ open, onClose, employee, current }: { open: boolean; onClose: () => void; employee: Employee; current?: Structure }) {
  const { t } = useTranslation();
  const { company } = useAuth();
  const { data: components = [] } = useGet<PayComponent[]>(open ? '/payroll/components' : null);
  const { data: currencies = [] } = useGet<{ code: string; name: string }[]>(open ? '/payroll/currencies' : null);
  const firstOfNextMonth = (() => {
    const d = new Date();
    return new Date(Date.UTC(d.getFullYear(), d.getMonth() + 1, 1)).toISOString().slice(0, 10);
  })();
  const [effectiveFrom, setFrom] = useState(current ? firstOfNextMonth : employee.hireDate.slice(0, 10));
  const [basic, setBasic] = useState(current?.basicSalary ?? '');
  const [currency, setCurrency] = useState(current?.currency ?? company?.baseCurrency ?? 'USD');
  const [reason, setReason] = useState('');
  const [items, setItems] = useState<{ componentId: string; amount: string }[]>(current?.items.map((i) => ({ componentId: i.component.id, amount: String(Number(i.amount)) })) ?? []);
  const selectable = components.filter((c) => c.isActive && !c.appliesToAll && (c.calcType === 'FIXED' || c.calcType === 'PERCENT_OF_BASIC') && c.type !== 'EMPLOYER_CONTRIBUTION');
  const save = useApiMutation(
    () => api.post<{ warnings: string[] }>('/payroll/salaries', { employeeId: employee.id, effectiveFrom, basicSalary: Number(basic), currency, items: items.filter((i) => i.componentId).map((i) => ({ componentId: i.componentId, amount: Number(i.amount || 0) })), reason: reason || undefined }),
    { success: (r) => (r.warnings?.length ? `${t('salary.submitted')} — ${r.warnings.join('; ')}` : t('salary.submitted')), invalidate: ['/payroll/salaries', '/employees', '/approvals'], onSuccess: onClose },
  );
  const increase = current && basic ? ((Number(basic) - Number(current.basicSalary)) / Number(current.basicSalary)) * 100 : null;
  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="lg"
      title={current ? t('salary.change') : t('salary.setup')}
      description={personName(employee)}
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" disabled={!basic || Number(basic) <= 0} loading={save.isPending} onClick={() => save.mutate(undefined)}>
            {t('salary.submit')}
          </Button>
        </>
      }
    >
      <FieldErrors errors={save.fieldErrors}>
      <div className="space-y-5">
        <FormGrid cols={3}>
          <Field name="effectiveFrom" label={t('salary.effectiveFrom')} required>
            <Input type="date" value={effectiveFrom} onChange={(e) => setFrom(e.target.value)} />
          </Field>
          <Field name="basicSalary" label={t('salary.basic')} required hint={increase !== null && Number.isFinite(increase) ? t('salary.changePct', { pct: `${increase >= 0 ? '+' : ''}${increase.toFixed(1)}%` }) : undefined}>
            <Input type="number" min={0} step="0.01" value={basic} onChange={(e) => setBasic(e.target.value)} className="tabular" />
          </Field>
          <Field label={t('salary.currency')}>
            <Select value={currency} onChange={(e) => setCurrency(e.target.value)}>
              {currencies.map((c) => (
                <option key={c.code} value={c.code}>
                  {c.code} · {c.name}
                </option>
              ))}
            </Select>
          </Field>
        </FormGrid>
        <div>
          <div className="mb-2 flex items-center justify-between">
            <h3 className="text-sm font-semibold">{t('salary.components')}</h3>
            <Button size="sm" variant="ghost" icon={<Plus className="h-4 w-4" />} onClick={() => setItems([...items, { componentId: '', amount: '' }])}>
              {t('salary.addComponent')}
            </Button>
          </div>
          {items.length === 0 && <p className="text-sm text-ink-3">{t('salary.noComponents')}</p>}
          <div className="space-y-2">
            {items.map((it, idx) => {
              const comp = selectable.find((c) => c.id === it.componentId);
              return (
                <div key={idx} className="flex items-center gap-2">
                  <Select value={it.componentId} onChange={(e) => setItems(items.map((x, i) => (i === idx ? { ...x, componentId: e.target.value } : x)))} placeholder={t('salary.chooseComponent')} className="flex-1">
                    {selectable.map((c) => (
                      <option key={c.id} value={c.id} disabled={items.some((x, i) => i !== idx && x.componentId === c.id)}>
                        {localized(c as unknown as Record<string, unknown>, 'name')} · {t(`payComponent.type.${c.type}`)}
                      </option>
                    ))}
                  </Select>
                  <div className="relative w-40">
                    <Input type="number" min={0} step="0.01" value={it.amount} onChange={(e) => setItems(items.map((x, i) => (i === idx ? { ...x, amount: e.target.value } : x)))} className="tabular pe-12" aria-label={t('salary.amount')} />
                    <span className="pointer-events-none absolute end-3 top-1/2 -translate-y-1/2 text-xs text-ink-3">{comp?.calcType === 'PERCENT_OF_BASIC' ? '%' : currency}</span>
                  </div>
                  <Button size="icon" variant="ghost" aria-label={t('common.remove')} icon={<Trash2 className="h-4 w-4" />} onClick={() => setItems(items.filter((_, i) => i !== idx))} />
                </div>
              );
            })}
          </div>
        </div>
        <Field label={t('salary.reason')}>
          <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder={t('salary.reasonPlaceholder')} />
        </Field>
        <Alert tone="info">{t('salary.statutoryNote')}</Alert>
      </div>
      </FieldErrors>
    </Dialog>
  );
}
