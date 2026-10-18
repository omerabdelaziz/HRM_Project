import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { BookmarkPlus, CalendarClock, FileDown, FileSpreadsheet, FileText, Play, Trash2 } from 'lucide-react';
import { toast } from '@/lib/toast';
import { api, download } from '@/lib/api';
import { errorMessage, useApiMutation, useGet } from '@/lib/hooks';
import { fmtDate, fmtMoney, fmtNumber, fmtPercent } from '@/lib/format';
import { monthEndIso, monthStartIso, todayIso } from '@/lib/utils';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Field, FormGrid, Input, Select } from '@/components/ui/form';
import { Badge, Card, CardHeader, EmptyState, ErrorState, PageHeader, Spinner } from '@/components/ui/display';
import { Dialog, useConfirm } from '@/components/ui/dialog';
import { OrgSelect } from '@/components/ui/pickers';
import { BarList, ChartCard, LineSeriesChart } from '@/components/charts';
import { BarChart3 as PageIcon } from 'lucide-react';

interface ReportMeta {
  key: string;
  title: string;
  description: string;
  category: string;
  filters: string[];
}
interface Column {
  key: string;
  label: string;
  type?: 'text' | 'number' | 'percent' | 'date' | 'money' | 'hours';
}
interface Result {
  title: string;
  columns: Column[];
  rows: Record<string, unknown>[];
  chart?: { type: 'bar' | 'line' | 'pie'; x: string; y: string[] };
}
interface Saved {
  id: string;
  name: string;
  reportKey: string;
  filters: Record<string, string>;
  format: string;
  schedule: string | null;
  lastRunAt: string | null;
}

function defaults(filters: string[]): Record<string, string> {
  const d: Record<string, string> = {};
  if (filters.includes('from')) d.from = monthStartIso(-1);
  if (filters.includes('to')) d.to = monthEndIso(-1);
  if (filters.includes('year')) d.year = String(new Date().getFullYear());
  if (filters.includes('month')) d.month = String(new Date().getMonth() || 12);
  if (filters.includes('days')) d.days = '60';
  if (filters.includes('groupBy')) d.groupBy = 'department';
  if (filters.includes('includeExpired')) d.includeExpired = 'true';
  return d;
}

function cell(v: unknown, c: Column, currency?: string) {
  if (v === null || v === undefined || v === '') return '—';
  switch (c.type) {
    case 'number':
      return fmtNumber(Number(v), Number(v) % 1 ? 1 : 0);
    case 'hours':
      return fmtNumber(Number(v), 1);
    case 'percent':
      return fmtPercent(Number(v));
    case 'money':
      return currency ? fmtMoney(Number(v), currency) : fmtNumber(Number(v), 2);
    case 'date':
      return fmtDate(String(v));
    default:
      return String(v);
  }
}

export default function Reports() {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const { data: reports = [], isLoading } = useGet<ReportMeta[]>('/reports');
  const { data: saved = [] } = useGet<Saved[]>('/saved-reports');
  const [selected, setSelected] = useState<string | null>(null);
  const [filters, setFilters] = useState<Record<string, string>>({});
  const [runArgs, setRunArgs] = useState<Record<string, string> | null>(null);
  const [saving, setSaving] = useState(false);
  const meta = reports.find((r) => r.key === selected);
  const result = useQuery({
    queryKey: ['/reports', selected, runArgs],
    queryFn: () => api.get<Result>(`/reports/${selected}`, runArgs!),
    enabled: !!selected && !!runArgs,
  });
  const byCategory = useMemo(() => {
    const m = new Map<string, ReportMeta[]>();
    for (const r of reports) m.set(r.category, [...(m.get(r.category) ?? []), r]);
    return [...m.entries()];
  }, [reports]);
  const removeSaved = useApiMutation((id: string) => api.delete(`/saved-reports/${id}`), { success: t('common.deleted'), invalidate: ['/saved-reports'] });

  const choose = (key: string, f?: Record<string, string>) => {
    const r = reports.find((x) => x.key === key)!;
    setSelected(key);
    const next = f ?? defaults(r.filters);
    setFilters(next);
    setRunArgs(next);
  };
  const exportAs = async (format: 'xlsx' | 'csv' | 'pdf') => {
    try {
      await download(`/reports/${selected}`, { ...filters, format });
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };
  const set = (k: string, v: string | null) => setFilters((f) => ({ ...f, [k]: v ?? '' }));
  const res = result.data;
  const chartCols = res?.chart && res.columns.filter((c) => res.chart!.y.includes(c.key));

  return (
    <div>
      <PageHeader icon={<PageIcon />} title={t('nav.reports')} subtitle={t('reports.subtitle')} />
      <div className="grid gap-6 lg:grid-cols-[18rem_1fr]">
        <div className="space-y-4">
          {isLoading && <Spinner />}
          {byCategory.map(([cat, list]) => (
            <Card key={cat} padded={false} className="p-2">
              <p className="px-3 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wider text-ink-3">{t(`reports.category.${cat}`, cat)}</p>
              <ul>
                {list.map((r) => (
                  <li key={r.key}>
                    <button onClick={() => choose(r.key)} className={cn('w-full rounded-lg px-3 py-2 text-start text-sm', selected === r.key ? 'bg-primary-soft text-primary-ink' : 'hover:bg-subtle')}>
                      <span className="block font-medium">{t(`reports.title.${r.key}`, r.title)}</span>
                      <span className="block text-xs text-ink-3">{t(`reports.desc.${r.key}`, r.description)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </Card>
          ))}
          {saved.length > 0 && (
            <Card padded={false} className="p-2">
              <p className="px-3 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wider text-ink-3">{t('reports.saved')}</p>
              <ul>
                {saved.map((s) => (
                  <li key={s.id} className="group flex items-center gap-1">
                    <button onClick={() => choose(s.reportKey, s.filters)} className="flex-1 rounded-lg px-3 py-2 text-start text-sm hover:bg-subtle">
                      <span className="block font-medium">{s.name}</span>
                      {s.schedule && (
                        <span className="inline-flex items-center gap-1 text-xs text-ink-3">
                          <CalendarClock className="h-3 w-3" /> {t(`reports.schedule.${s.schedule}`)} · {s.format.toUpperCase()}
                        </span>
                      )}
                    </button>
                    <button onClick={async () => (await confirm({ title: t('reports.deleteSaved'), message: s.name, tone: 'danger', confirmLabel: t('common.delete') })) && removeSaved.mutate(s.id)} className="rounded p-1.5 text-ink-3 opacity-0 hover:text-danger group-hover:opacity-100 focus:opacity-100" aria-label={t('common.delete')}>
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </div>

        <div className="min-w-0 space-y-6">
          {!meta ? (
            <Card>
              <EmptyState title={t('reports.choose')} description={t('reports.chooseHint')} icon={<FileText className="h-6 w-6" />} />
            </Card>
          ) : (
            <>
              <Card>
                <CardHeader
                  title={t(`reports.title.${meta.key}`, meta.title)}
                  subtitle={t(`reports.desc.${meta.key}`, meta.description)}
                  actions={
                    <Button size="sm" variant="ghost" icon={<BookmarkPlus className="h-4 w-4" />} onClick={() => setSaving(true)}>
                      {t('reports.save')}
                    </Button>
                  }
                />
                <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
                  {meta.filters.includes('from') && (
                    <Field label={t('common.from')}>
                      <Input type="date" value={filters.from ?? ''} onChange={(e) => set('from', e.target.value)} />
                    </Field>
                  )}
                  {meta.filters.includes('to') && (
                    <Field label={t('common.to')}>
                      <Input type="date" value={filters.to ?? ''} max={todayIso()} onChange={(e) => set('to', e.target.value)} />
                    </Field>
                  )}
                  {meta.filters.includes('year') && (
                    <Field label={t('common.year')}>
                      <Input type="number" value={filters.year ?? ''} onChange={(e) => set('year', e.target.value)} />
                    </Field>
                  )}
                  {meta.filters.includes('month') && (
                    <Field label={t('common.month')}>
                      <Input type="number" min={1} max={12} value={filters.month ?? ''} onChange={(e) => set('month', e.target.value)} />
                    </Field>
                  )}
                  {meta.filters.includes('days') && (
                    <Field label={t('reports.daysAhead')}>
                      <Input type="number" min={1} max={365} value={filters.days ?? ''} onChange={(e) => set('days', e.target.value)} />
                    </Field>
                  )}
                  {meta.filters.includes('departmentId') && (
                    <Field label={t('common.department')}>
                      <OrgSelect entity="departments" value={filters.departmentId || null} onChange={(v) => set('departmentId', v)} placeholder={t('common.all')} />
                    </Field>
                  )}
                  {meta.filters.includes('branchId') && (
                    <Field label={t('common.branch')}>
                      <OrgSelect entity="branches" value={filters.branchId || null} onChange={(v) => set('branchId', v)} placeholder={t('common.all')} />
                    </Field>
                  )}
                  {meta.filters.includes('groupBy') && (
                    <Field label={t('reports.groupBy')}>
                      <Select value={filters.groupBy} onChange={(e) => set('groupBy', e.target.value)}>
                        <option value="department">{t('common.department')}</option>
                        <option value="branch">{t('common.branch')}</option>
                      </Select>
                    </Field>
                  )}
                  {meta.filters.includes('includeExpired') && (
                    <Field label={t('reports.includeExpired')}>
                      <Select value={filters.includeExpired} onChange={(e) => set('includeExpired', e.target.value)}>
                        <option value="true">{t('common.yes')}</option>
                        <option value="false">{t('common.no')}</option>
                      </Select>
                    </Field>
                  )}
                </div>
                <div className="mt-4 flex flex-wrap gap-2">
                  <Button variant="primary" icon={<Play className="h-4 w-4" />} loading={result.isFetching} onClick={() => setRunArgs({ ...filters })}>
                    {t('reports.run')}
                  </Button>
                  <Button icon={<FileSpreadsheet className="h-4 w-4" />} onClick={() => exportAs('xlsx')}>
                    Excel
                  </Button>
                  <Button icon={<FileDown className="h-4 w-4" />} onClick={() => exportAs('csv')}>
                    CSV
                  </Button>
                  <Button icon={<FileText className="h-4 w-4" />} onClick={() => exportAs('pdf')}>
                    PDF
                  </Button>
                </div>
              </Card>

              {result.error ? (
                <ErrorState error={result.error} />
              ) : result.isLoading ? (
                <Spinner />
              ) : (
                res && (
                  <>
                    {res.chart && res.rows.length > 0 && chartCols && (
                      <ChartCard title={res.title}>
                        {res.chart.type === 'line' ? (
                          <LineSeriesChart data={res.rows} x={res.chart.x} lines={chartCols.map((c, i) => ({ key: c.key, label: c.label, slot: i + 1 }))} />
                        ) : (
                          <BarList items={res.rows.map((r) => ({ label: String(r[res.chart!.x] ?? '—'), value: Number(r[res.chart!.y[0]] ?? 0) }))} format={(v) => cell(v, chartCols[0])} limit={10} />
                        )}
                      </ChartCard>
                    )}
                    <Card padded={false}>
                      <div className="flex items-center justify-between border-b border-line p-4">
                        <h2 className="font-semibold">{res.title}</h2>
                        <Badge>{t('reports.rows', { count: res.rows.length })}</Badge>
                      </div>
                      {res.rows.length === 0 ? (
                        <EmptyState title={t('reports.noRows')} />
                      ) : (
                        <div className="max-h-[36rem] overflow-auto">
                          <table className="w-full text-sm">
                            <thead className="sticky top-0 bg-subtle text-xs uppercase tracking-wide text-ink-3">
                              <tr>
                                {res.columns.map((c) => (
                                  <th key={c.key} className={cn('whitespace-nowrap px-4 py-2.5 font-medium', c.type && !['text', 'date'].includes(c.type) ? 'text-end' : 'text-start')}>
                                    {c.label}
                                  </th>
                                ))}
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-line">
                              {res.rows.map((row, i) => (
                                <tr key={i} className="hover:bg-subtle/60">
                                  {res.columns.map((c) => (
                                    <td key={c.key} className={cn('whitespace-nowrap px-4 py-2', c.type && !['text', 'date'].includes(c.type) && 'text-end tabular')}>
                                      {cell(row[c.key], c, row.currency as string | undefined)}
                                    </td>
                                  ))}
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      )}
                    </Card>
                  </>
                )
              )}
            </>
          )}
        </div>
      </div>
      {meta && <SaveDialog open={saving} onClose={() => setSaving(false)} reportKey={meta.key} filters={filters} defaultName={t(`reports.title.${meta.key}`, meta.title)} />}
    </div>
  );
}

function SaveDialog({ open, onClose, reportKey, filters, defaultName }: { open: boolean; onClose: () => void; reportKey: string; filters: Record<string, string>; defaultName: string }) {
  const { t } = useTranslation();
  const [name, setName] = useState(defaultName);
  const [schedule, setSchedule] = useState('');
  const [format, setFormat] = useState('xlsx');
  const [recipients, setRecipients] = useState('');
  const [relative, setRelative] = useState(true);
  const save = useApiMutation(
    () => {
      // Scheduled reports usually cover "the previous month", so offer relative dates.
      const f = { ...filters };
      if (relative && schedule) {
        if ('from' in f) f.from = '@prevMonthStart';
        if ('to' in f) f.to = '@prevMonthEnd';
        if ('year' in f) f.year = '@year';
      }
      return api.post('/saved-reports', { name, reportKey, filters: Object.fromEntries(Object.entries(f).filter(([, v]) => v)), schedule: schedule || null, format, recipients: recipients.split(',').map((x) => x.trim()).filter(Boolean) });
    },
    { success: t('reports.savedOk'), invalidate: ['/saved-reports'], onSuccess: onClose },
  );
  return (
    <Dialog open={open} onClose={onClose} title={t('reports.save')} footer={<><Button onClick={onClose}>{t('common.cancel')}</Button><Button variant="primary" disabled={!name} loading={save.isPending} onClick={() => save.mutate(undefined)}>{t('common.save')}</Button></>}>
      <div className="space-y-4">
        <Field label={t('common.name')} required>
          <Input value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <FormGrid>
          <Field label={t('reports.deliver')}>
            <Select value={schedule} onChange={(e) => setSchedule(e.target.value)} placeholder={t('reports.noSchedule')}>
              {['DAILY', 'WEEKLY', 'MONTHLY'].map((s) => (
                <option key={s} value={s}>
                  {t(`reports.schedule.${s}`)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t('reports.format')}>
            <Select value={format} onChange={(e) => setFormat(e.target.value)}>
              <option value="xlsx">Excel</option>
              <option value="csv">CSV</option>
              <option value="pdf">PDF</option>
            </Select>
          </Field>
        </FormGrid>
        {schedule && (
          <>
            <Field label={t('reports.recipients')} hint={t('reports.recipientsHint')}>
              <Input value={recipients} onChange={(e) => setRecipients(e.target.value)} placeholder="name@company.com, …" />
            </Field>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={relative} onChange={(e) => setRelative(e.target.checked)} className="accent-[rgb(var(--primary))]" />
              {t('reports.relativeDates')}
            </label>
          </>
        )}
      </div>
    </Dialog>
  );
}
