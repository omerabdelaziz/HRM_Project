import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { useGet, usePaged } from '@/lib/hooks';
import { fmtDateTime } from '@/lib/format';
import { cn } from '@/lib/utils';
import { Input, Select } from '@/components/ui/form';
import { Badge, Card, PageHeader } from '@/components/ui/display';
import { Drawer } from '@/components/ui/dialog';
import { DataTable, Pagination } from '@/components/ui/table';
import { ScrollText as PageIcon } from 'lucide-react';

interface Entry {
  id: string;
  action: string;
  entity: string;
  entityId: string | null;
  before: unknown;
  after: unknown;
  ip: string | null;
  userAgent: string | null;
  createdAt: string;
  user: { displayName: string; email: string } | null;
}

/** "nationalIdType" → "National id type", "LEAVE_REQUEST" → "Leave request" (used when no translation exists). */
function humanize(key: string) {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_.]+/g, ' ')
    .trim()
    .toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

const entityLabel = (t: TFunction, e: string) => t(`audit.entities.${e}`, { defaultValue: humanize(e) });
const actionLabel = (t: TFunction, a: string) => t(`audit.actions.${a}`, { defaultValue: humanize(a) });
const fieldLabel = (t: TFunction, f: string) => t(`audit.fields.${f}`, { defaultValue: humanize(f) });

function actionTone(a: string) {
  if (a.includes('FAIL') || a === 'DELETE' || a.startsWith('OVERRIDE')) return 'danger' as const;
  if (a === 'CREATE' || a === 'APPROVE' || a === 'INVITE_ACCEPTED') return 'success' as const;
  if (a === 'UPLOAD' || a === 'UPDATE') return 'info' as const;
  return 'neutral' as const;
}

const asObject = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

function show(v: unknown) {
  if (v === undefined) return '—';
  if (v === null || v === '') return '∅';
  if (typeof v === 'string') return v;
  return JSON.stringify(v);
}

/** One row per field; when both sides are present only the fields that changed are kept. */
function auditDiff(before: unknown, after: unknown) {
  const b = asObject(before);
  const a = asObject(after);
  const both = before != null && after != null;
  const keys = [...new Set([...Object.keys(b), ...Object.keys(a)])].filter((k) => !both || !['updatedAt', 'createdAt'].includes(k));
  return keys.map((k) => ({ field: k, before: b[k], after: a[k] })).filter((r) => !both || JSON.stringify(r.before) !== JSON.stringify(r.after));
}

export default function Audit() {
  const { t } = useTranslation();
  const [entity, setEntity] = useState('');
  const [action, setAction] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [open, setOpen] = useState<Entry | null>(null);
  const { data: facets } = useGet<{ actions: string[]; entities: string[] }>('/audit/facets');
  const list = usePaged<Entry>('/audit', { entity: entity || undefined, action: action || undefined, from: from || undefined, to: to || undefined }, { pageSize: 50 });
  const sorted = (xs: string[] | undefined, label: (x: string) => string) => [...(xs ?? [])].sort((x, y) => label(x).localeCompare(label(y)));
  const rows = open ? auditDiff(open.before, open.after) : [];
  return (
    <div>
      <PageHeader icon={<PageIcon />} title={t('nav.audit')} subtitle={t('audit.subtitle')} />
      <Card padded={false}>
        <div className="grid grid-cols-2 gap-3 border-b border-line p-4 md:grid-cols-4">
          <Select value={entity} onChange={(e) => setEntity(e.target.value)} placeholder={t('audit.allEntities')} aria-label={t('audit.entity')}>
            {sorted(facets?.entities, (x) => entityLabel(t, x)).map((x) => (
              <option key={x} value={x}>
                {entityLabel(t, x)}
              </option>
            ))}
          </Select>
          <Select value={action} onChange={(e) => setAction(e.target.value)} placeholder={t('audit.allActions')} aria-label={t('audit.action')}>
            {sorted(facets?.actions, (x) => actionLabel(t, x)).map((x) => (
              <option key={x} value={x}>
                {actionLabel(t, x)}
              </option>
            ))}
          </Select>
          <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} aria-label={t('common.from')} />
          <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} aria-label={t('common.to')} />
        </div>
        <DataTable
          rows={list.data?.items}
          rowKey={(e) => e.id}
          loading={list.isLoading}
          dense
          onRowClick={setOpen}
          columns={[
            { key: 'when', header: t('audit.when'), cell: (e) => <span className="tabular whitespace-nowrap">{fmtDateTime(e.createdAt)}</span> },
            { key: 'who', header: t('audit.who'), cell: (e) => e.user?.displayName ?? <span className="text-ink-3">{t('audit.system')}</span> },
            { key: 'action', header: t('audit.action'), cell: (e) => <Badge tone={actionTone(e.action)}>{actionLabel(t, e.action)}</Badge> },
            { key: 'entity', header: t('audit.entity'), cell: (e) => entityLabel(t, e.entity) },
            { key: 'id', header: t('audit.recordId'), hideBelow: 'lg', cell: (e) => <span className="font-mono text-xs text-ink-3">{e.entityId?.slice(0, 8) ?? '—'}</span> },
            { key: 'ip', header: t('audit.ip'), hideBelow: 'md', cell: (e) => <span className="font-mono text-xs" dir="ltr">{e.ip ?? '—'}</span> },
          ]}
        />
        {list.data && <Pagination page={list.page} pageCount={list.data.pageCount} total={list.data.total} pageSize={list.pageSize} onPage={list.setPage} />}
      </Card>
      <Drawer open={!!open} onClose={() => setOpen(null)} title={open ? `${actionLabel(t, open.action)} · ${entityLabel(t, open.entity)}` : ''}>
        {open && (
          <div className="space-y-4 text-sm">
            <dl className="grid grid-cols-[auto,1fr] gap-x-4 gap-y-1 text-ink-2">
              <dt className="text-ink-3">{t('audit.when')}</dt>
              <dd>{fmtDateTime(open.createdAt)}</dd>
              <dt className="text-ink-3">{t('audit.who')}</dt>
              <dd>{open.user ? `${open.user.displayName} (${open.user.email})` : t('audit.system')}</dd>
              {open.entityId && (
                <>
                  <dt className="text-ink-3">{t('audit.recordId')}</dt>
                  <dd className="font-mono text-xs" dir="ltr">
                    {open.entityId}
                  </dd>
                </>
              )}
              <dt className="text-ink-3">{t('audit.ip')}</dt>
              <dd className="font-mono text-xs" dir="ltr">
                {open.ip ?? '—'}
              </dd>
              <dt className="text-ink-3">{t('audit.userAgent')}</dt>
              <dd className="break-all text-xs" dir="ltr">
                {open.userAgent ?? '—'}
              </dd>
            </dl>
            {rows.length > 0 ? (
              <div className="overflow-x-auto rounded-lg border border-line">
                <table className="w-full text-xs">
                  <thead className="bg-subtle text-ink-3">
                    <tr>
                      <th className="px-3 py-2 text-start font-medium">{t('audit.field')}</th>
                      {open.before != null && <th className="px-3 py-2 text-start font-medium">{t('audit.before')}</th>}
                      {open.after != null && <th className="px-3 py-2 text-start font-medium">{t('audit.after')}</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr key={r.field} className="border-t border-line align-top">
                        <td className="px-3 py-2 font-medium">{fieldLabel(t, r.field)}</td>
                        {open.before != null && <td className={cn('break-all px-3 py-2', open.after != null && 'bg-danger-soft/40 text-ink-2')}>{show(r.before)}</td>}
                        {open.after != null && <td className={cn('break-all px-3 py-2', open.before != null && 'bg-success-soft/40')}>{show(r.after)}</td>}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="text-ink-3">{t('audit.noChanges')}</p>
            )}
            {(open.before != null || open.after != null) && (
              <details className="rounded-lg border border-line">
                <summary className="cursor-pointer px-3 py-2 text-xs font-medium text-ink-2">{t('audit.raw')}</summary>
                <pre className="max-h-80 overflow-auto border-t border-line bg-subtle p-3 text-xs" dir="ltr">
                  {JSON.stringify({ before: open.before, after: open.after }, null, 2)}
                </pre>
              </details>
            )}
          </div>
        )}
      </Drawer>
    </div>
  );
}
