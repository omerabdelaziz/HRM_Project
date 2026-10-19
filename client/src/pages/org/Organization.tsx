import { ReactNode, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import { api } from '@/lib/api';
import { useApiMutation, useGet } from '@/lib/hooks';
import { localized, personName } from '@/lib/i18n';
import { fmtMoney, fmtNumber } from '@/lib/format';
import { Button } from '@/components/ui/button';
import { Checkbox, Field, FieldErrors, FormGrid, Input, SearchInput, Textarea } from '@/components/ui/form';
import { Badge, Card, PageHeader } from '@/components/ui/display';
import { Dialog, useConfirm } from '@/components/ui/dialog';
import { Tabs } from '@/components/ui/nav';
import { Column, DataTable } from '@/components/ui/table';
import { EmployeePicker, OrgSelect } from '@/components/ui/pickers';
import { Building2 as PageIcon } from 'lucide-react';

type Entity = 'branches' | 'departments' | 'positions' | 'grades' | 'cost-centers' | 'categories' | 'employment-types';

interface FieldDef {
  key: string;
  label: string;
  type?: 'text' | 'number' | 'textarea' | 'employee' | 'boolean' | Entity;
  required?: boolean;
  dir?: 'rtl';
  full?: boolean;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

function EntityTab({ entity, columns, fields, nameKey = 'name' }: { entity: Entity; columns: Column<Row>[]; fields: FieldDef[]; nameKey?: string }) {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState<Row | null>(null);
  const { data, isLoading, error, refetch } = useGet<Row[]>(`/org/${entity}`, { search: search || undefined });
  const remove = useApiMutation((id: string) => api.delete(`/org/${entity}/${id}`), { success: t('common.deleted'), invalidate: [`/org/${entity}`] });
  const actions: Column<Row> = {
    key: 'actions',
    header: '',
    align: 'end',
    cell: (r) => (
      <div className="flex justify-end gap-1">
        <Button size="icon" variant="ghost" aria-label={t('common.edit')} icon={<Pencil className="h-4 w-4" />} onClick={() => setEditing(r)} />
        <Button
          size="icon"
          variant="ghost"
          aria-label={t('common.delete')}
          icon={<Trash2 className="h-4 w-4 text-danger" />}
          onClick={async () => (await confirm({ title: t('org.deleteTitle'), message: t('org.deleteText', { name: r[nameKey] }), tone: 'danger', confirmLabel: t('common.delete') })) && remove.mutate(r.id)}
        />
      </div>
    ),
  };
  return (
    <Card padded={false}>
      <div className="flex flex-col gap-3 border-b border-line p-4 sm:flex-row sm:items-center sm:justify-between">
        <SearchInput className="sm:max-w-xs" placeholder={t('common.searchPlaceholder')} value={search} onChange={(e) => setSearch(e.target.value)} />
        <Button variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => setEditing({})}>
          {t('common.add')}
        </Button>
      </div>
      <DataTable columns={[...columns, actions]} rows={data} rowKey={(r) => r.id} loading={isLoading} error={error} onRetry={() => refetch()} empty={{ title: t('org.empty') }} />
      <EntityDialog entity={entity} row={editing} fields={fields} onClose={() => setEditing(null)} />
    </Card>
  );
}

function EntityDialog({ entity, row, fields, onClose }: { entity: Entity; row: Row | null; fields: FieldDef[]; onClose: () => void }) {
  const { t } = useTranslation();
  const [values, setValues] = useState<Row>({});
  const [lastRow, setLastRow] = useState<Row | null>(null);
  if (row !== lastRow) {
    setLastRow(row);
    setValues(row ? Object.fromEntries(fields.map((f) => [f.key, row[f.key] ?? (f.type === 'boolean' ? true : '')])) : {});
  }
  const isNew = !row?.id;
  const save = useApiMutation(
    () => {
      const body = Object.fromEntries(
        fields.map((f) => {
          const v = values[f.key];
          if (f.type === 'number') return [f.key, v === '' || v === null || v === undefined ? null : Number(v)];
          if (f.type === 'boolean') return [f.key, !!v];
          return [f.key, v === '' ? null : v];
        }),
      );
      return isNew ? api.post(`/org/${entity}`, body) : api.put(`/org/${entity}/${row!.id}`, body);
    },
    { invalidate: [`/org/${entity}`, '/org'], onSuccess: onClose },
  );
  const set = (k: string, v: unknown) => setValues((s) => ({ ...s, [k]: v }));
  const control = (f: FieldDef): ReactNode => {
    switch (f.type) {
      case 'textarea':
        return <Textarea value={values[f.key] ?? ''} onChange={(e) => set(f.key, e.target.value)} />;
      case 'number':
        return <Input type="number" value={values[f.key] ?? ''} onChange={(e) => set(f.key, e.target.value)} className="tabular" />;
      case 'employee':
        return <EmployeePicker value={values[f.key] || null} onChange={(id) => set(f.key, id)} valueLabel={row?.manager ? personName(row.manager) : undefined} />;
      case 'boolean':
        return <Checkbox label={t('common.active')} checked={!!values[f.key]} onChange={(e) => set(f.key, e.target.checked)} />;
      case 'branches':
      case 'departments':
      case 'positions':
      case 'grades':
      case 'cost-centers':
        return <OrgSelect entity={f.type} value={values[f.key] || null} onChange={(v) => set(f.key, v)} />;
      default:
        return <Input dir={f.dir} value={values[f.key] ?? ''} onChange={(e) => set(f.key, e.target.value)} />;
    }
  };
  return (
    <Dialog
      open={!!row}
      onClose={onClose}
      title={isNew ? t('common.add') : t('common.edit')}
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" loading={save.isPending} disabled={fields.some((f) => f.required && !values[f.key])} onClick={() => save.mutate(undefined)}>
            {t('common.save')}
          </Button>
        </>
      }
    >
      <FieldErrors errors={save.fieldErrors}>
      <FormGrid>
        {fields.map((f) => (
          <Field key={f.key} name={f.key} label={f.type === 'boolean' ? undefined : f.label} required={f.required} className={f.full || f.type === 'textarea' ? 'sm:col-span-2' : undefined}>
            {control(f)}
          </Field>
        ))}
      </FormGrid>
      </FieldErrors>
    </Dialog>
  );
}

export default function Organization() {
  const { t } = useTranslation();
  const [tab, setTab] = useState<Entity | 'workforce'>('departments');
  const ln = (r: Row, f = 'name') => localized(r, f);
  const active = (r: Row) => (r.isActive === false ? <Badge>{t('common.inactive')}</Badge> : <Badge tone="success">{t('common.active')}</Badge>);
  const code: Column<Row> = { key: 'code', header: t('org.code'), cell: (r) => <span className="font-mono text-xs">{r.code}</span> };
  const base: FieldDef[] = [
    { key: 'code', label: t('org.code'), required: true },
    { key: 'name', label: t('common.name'), required: true },
    { key: 'nameAr', label: t('org.nameAr'), dir: 'rtl' },
  ];
  return (
    <div>
      <PageHeader icon={<PageIcon />} title={t('nav.organization')} subtitle={t('org.subtitle')} />
      <Tabs
        className="mb-4"
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'departments', label: t('org.departments') },
          { id: 'branches', label: t('org.branches') },
          { id: 'positions', label: t('org.positions') },
          { id: 'grades', label: t('org.grades') },
          { id: 'cost-centers', label: t('org.costCenters') },
          { id: 'categories', label: t('org.categories') },
          { id: 'employment-types', label: t('org.employmentTypes') },
          { id: 'workforce', label: t('org.workforce') },
        ]}
      />
      {tab === 'departments' && (
        <EntityTab
          key={tab}
          entity="departments"
          columns={[
            code,
            { key: 'name', header: t('common.name'), cell: (r) => <span className="font-medium">{ln(r)}</span> },
            { key: 'parent', header: t('org.parent'), hideBelow: 'md', cell: (r) => r.parent?.name ?? '—' },
            { key: 'branch', header: t('common.branch'), hideBelow: 'md', cell: (r) => r.branch?.name ?? '—' },
            { key: 'manager', header: t('common.manager'), hideBelow: 'sm', cell: (r) => (r.manager ? personName(r.manager) : '—') },
            { key: 'count', header: t('org.employees'), align: 'end', cell: (r) => fmtNumber(r._count?.employees) },
            { key: 'active', header: t('common.status'), hideBelow: 'lg', cell: active },
          ]}
          fields={[...base, { key: 'parentId', label: t('org.parent'), type: 'departments' }, { key: 'branchId', label: t('common.branch'), type: 'branches' }, { key: 'managerId', label: t('common.manager'), type: 'employee' }, { key: 'costCenterId', label: t('employees.costCenter'), type: 'cost-centers' }, { key: 'isActive', label: t('common.active'), type: 'boolean' }]}
        />
      )}
      {tab === 'branches' && (
        <EntityTab
          key={tab}
          entity="branches"
          columns={[
            code,
            { key: 'name', header: t('common.name'), cell: (r) => <span className="font-medium">{ln(r)}</span> },
            { key: 'city', header: t('org.city'), hideBelow: 'sm', cell: (r) => r.city ?? '—' },
            { key: 'manager', header: t('common.manager'), hideBelow: 'md', cell: (r) => (r.manager ? personName(r.manager) : '—') },
            { key: 'count', header: t('org.employees'), align: 'end', cell: (r) => fmtNumber(r._count?.employees) },
            { key: 'active', header: t('common.status'), hideBelow: 'lg', cell: active },
          ]}
          fields={[...base, { key: 'city', label: t('org.city') }, { key: 'country', label: t('org.country') }, { key: 'address', label: t('employees.address'), full: true }, { key: 'timezone', label: t('org.timezone') }, { key: 'managerId', label: t('common.manager'), type: 'employee' }, { key: 'isActive', label: t('common.active'), type: 'boolean' }]}
        />
      )}
      {tab === 'positions' && (
        <EntityTab
          key={tab}
          entity="positions"
          nameKey="title"
          columns={[
            code,
            { key: 'title', header: t('org.title'), cell: (r) => <span className="font-medium">{ln(r, 'title')}</span> },
            { key: 'dept', header: t('common.department'), hideBelow: 'sm', cell: (r) => r.department?.name ?? '—' },
            { key: 'grade', header: t('employees.grade'), hideBelow: 'md', cell: (r) => r.grade?.name ?? '—' },
            { key: 'hc', header: t('org.filledBudget'), align: 'end', cell: (r) => `${fmtNumber(r._count?.employees)} / ${fmtNumber(r.headcount)}` },
          ]}
          fields={[
            { key: 'code', label: t('org.code'), required: true },
            { key: 'title', label: t('org.title'), required: true },
            { key: 'titleAr', label: t('org.titleAr'), dir: 'rtl' },
            { key: 'departmentId', label: t('common.department'), type: 'departments' },
            { key: 'gradeId', label: t('employees.grade'), type: 'grades' },
            { key: 'headcount', label: t('org.budgetedHeadcount'), type: 'number' },
            { key: 'description', label: t('org.jobDescription'), type: 'textarea' },
            { key: 'isActive', label: t('common.active'), type: 'boolean' },
          ]}
        />
      )}
      {tab === 'grades' && (
        <EntityTab
          key={tab}
          entity="grades"
          columns={[
            code,
            { key: 'name', header: t('common.name'), cell: (r) => <span className="font-medium">{r.name}</span> },
            { key: 'level', header: t('org.level'), align: 'end', cell: (r) => r.level },
            { key: 'range', header: t('org.salaryRange'), align: 'end', cell: (r) => (r.minSalary || r.maxSalary ? `${fmtMoney(r.minSalary)} – ${fmtMoney(r.maxSalary)}` : '—') },
            { key: 'ot', header: t('org.overtimeEligible'), hideBelow: 'md', cell: (r) => (r.overtimeEligible === false ? t('common.no') : t('common.yes')) },
          ]}
          fields={[
            { key: 'code', label: t('org.code'), required: true },
            { key: 'name', label: t('common.name'), required: true },
            { key: 'level', label: t('org.level'), type: 'number' },
            { key: 'minSalary', label: t('org.minSalary'), type: 'number' },
            { key: 'maxSalary', label: t('org.maxSalary'), type: 'number' },
            { key: 'overtimeEligible', label: t('org.overtimeEligibleHint'), type: 'boolean' },
          ]}
        />
      )}
      {tab === 'cost-centers' && <EntityTab key={tab} entity="cost-centers" columns={[code, { key: 'name', header: t('common.name'), cell: (r) => r.name }]} fields={[{ key: 'code', label: t('org.code'), required: true }, { key: 'name', label: t('common.name'), required: true }]} />}
      {tab === 'categories' && <EntityTab key={tab} entity="categories" columns={[code, { key: 'name', header: t('common.name'), cell: (r) => ln(r) }]} fields={base} />}
      {tab === 'employment-types' && <EntityTab key={tab} entity="employment-types" columns={[code, { key: 'name', header: t('common.name'), cell: (r) => ln(r) }]} fields={base} />}
      {tab === 'workforce' && <Workforce />}
    </div>
  );
}

function Workforce() {
  const { t } = useTranslation();
  const { data, isLoading } = useGet<{ id: string; code: string; name: string; nameAr: string | null; filled: number; budgeted: number; vacancies: number; positions: { id: string; title: string; budgeted: number; filled: number; vacancies: number }[] }[]>('/org/workforce');
  const totals = (data ?? []).reduce((a, d) => ({ filled: a.filled + d.filled, budgeted: a.budgeted + d.budgeted, vacancies: a.vacancies + d.vacancies }), { filled: 0, budgeted: 0, vacancies: 0 });
  return (
    <Card padded={false}>
      <DataTable
        rows={data}
        loading={isLoading}
        rowKey={(r) => r.id}
        columns={[
          {
            key: 'name',
            header: t('common.department'),
            cell: (r) => (
              <div>
                <p className="font-medium">{localized(r as unknown as Record<string, unknown>, 'name')}</p>
                <p className="text-xs text-ink-3">{r.positions.map((p) => `${p.title} ${p.filled}/${p.budgeted}`).join(' · ')}</p>
              </div>
            ),
          },
          { key: 'filled', header: t('org.filled'), align: 'end', cell: (r) => fmtNumber(r.filled) },
          { key: 'budgeted', header: t('org.budgeted'), align: 'end', cell: (r) => fmtNumber(r.budgeted) },
          { key: 'vacancies', header: t('org.vacancies'), align: 'end', cell: (r) => (r.vacancies ? <Badge tone="warning">{r.vacancies}</Badge> : '0') },
        ]}
        footer={
          <tr>
            <td className="px-4 py-3">{t('common.total')}</td>
            <td className="px-4 py-3 text-end tabular">{fmtNumber(totals.filled)}</td>
            <td className="px-4 py-3 text-end tabular">{fmtNumber(totals.budgeted)}</td>
            <td className="px-4 py-3 text-end tabular">{fmtNumber(totals.vacancies)}</td>
          </tr>
        }
      />
    </Card>
  );
}
