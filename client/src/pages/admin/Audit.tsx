import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { usePaged } from '@/lib/hooks';
import { fmtDateTime } from '@/lib/format';
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
  createdAt: string;
  user: { displayName: string; email: string } | null;
}

const ENTITIES = ['Employee', 'EmployeeDocument', 'User', 'Role', 'Company', 'Department', 'Branch', 'Position', 'LeaveRequest', 'LeaveType', 'LeaveBalance', 'AttendanceRecord', 'PayrollRun', 'PayComponent', 'PayrollSettings', 'SalaryStructure', 'Payslip', 'WorkflowDefinition', 'Report'];
const ACTIONS = ['CREATE', 'UPDATE', 'DELETE', 'LOGIN', 'LOGIN_FAILED', 'APPROVE', 'REJECT', 'CALCULATE', 'REOPEN', 'PAY', 'EXPORT', 'IMPORT', 'DOWNLOAD', 'SEPARATE', 'ARCHIVE', 'RESET_PASSWORD'];

export default function Audit() {
  const { t } = useTranslation();
  const [entity, setEntity] = useState('');
  const [action, setAction] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [open, setOpen] = useState<Entry | null>(null);
  const list = usePaged<Entry>('/audit', { entity: entity || undefined, action: action || undefined, from: from || undefined, to: to || undefined }, { pageSize: 50 });
  return (
    <div>
      <PageHeader icon={<PageIcon />} title={t('nav.audit')} subtitle={t('audit.subtitle')} />
      <Card padded={false}>
        <div className="grid grid-cols-2 gap-3 border-b border-line p-4 md:grid-cols-4">
          <Select value={entity} onChange={(e) => setEntity(e.target.value)} placeholder={t('audit.allEntities')}>
            {ENTITIES.map((x) => <option key={x}>{x}</option>)}
          </Select>
          <Select value={action} onChange={(e) => setAction(e.target.value)} placeholder={t('audit.allActions')}>
            {ACTIONS.map((x) => <option key={x}>{x}</option>)}
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
            { key: 'action', header: t('audit.action'), cell: (e) => <Badge tone={e.action.includes('FAIL') || e.action === 'DELETE' ? 'danger' : e.action === 'CREATE' ? 'success' : 'neutral'}>{e.action}</Badge> },
            { key: 'entity', header: t('audit.entity'), cell: (e) => e.entity },
            { key: 'id', header: 'ID', hideBelow: 'lg', cell: (e) => <span className="font-mono text-xs text-ink-3">{e.entityId?.slice(0, 8) ?? '—'}</span> },
            { key: 'ip', header: 'IP', hideBelow: 'md', cell: (e) => <span className="font-mono text-xs">{e.ip ?? '—'}</span> },
          ]}
        />
        {list.data && <Pagination page={list.page} pageCount={list.data.pageCount} total={list.data.total} pageSize={list.pageSize} onPage={list.setPage} />}
      </Card>
      <Drawer open={!!open} onClose={() => setOpen(null)} title={open ? `${open.action} · ${open.entity}` : ''}>
        {open && (
          <div className="space-y-4 text-sm">
            <p className="text-ink-3">{fmtDateTime(open.createdAt)} · {open.user?.email ?? t('audit.system')}</p>
            {open.entityId && <p className="font-mono text-xs">{open.entityId}</p>}
            {['before', 'after'].map((k) => {
              const v = open[k as 'before' | 'after'];
              if (!v) return null;
              return (
                <div key={k}>
                  <h3 className="mb-1 font-semibold">{t(`audit.${k}`)}</h3>
                  <pre className="max-h-80 overflow-auto rounded-lg bg-subtle p-3 text-xs" dir="ltr">{JSON.stringify(v, null, 2)}</pre>
                </div>
              );
            })}
          </div>
        )}
      </Drawer>
    </div>
  );
}
