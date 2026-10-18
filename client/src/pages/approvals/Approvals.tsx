import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Check, Plus, Trash2, X } from 'lucide-react';
import { toast } from '@/lib/toast';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useApiMutation, useGet, usePaged } from '@/lib/hooks';
import { fmtDate, relativeTime } from '@/lib/format';
import type { ApprovalRequest } from '@/lib/types';
import { Button } from '@/components/ui/button';
import { Field, FormGrid, Input, SearchInput, Select } from '@/components/ui/form';
import { Badge, Card, PageHeader, StatusBadge } from '@/components/ui/display';
import { Dialog, useConfirm } from '@/components/ui/dialog';
import { Tabs } from '@/components/ui/nav';
import { Column, DataTable, Pagination } from '@/components/ui/table';
import { EmployeePicker } from '@/components/ui/pickers';
import { CheckSquare as PageIcon } from 'lucide-react';

export const REQUEST_TYPES = ['LEAVE', 'ATTENDANCE_CORRECTION', 'OVERTIME', 'PAYROLL', 'SALARY_CHANGE', 'TRANSFER', 'RESIGNATION', 'EXPENSE', 'JOB_OFFER', 'DOCUMENT'];
type Tab = 'inbox' | 'mine' | 'handled' | 'all' | 'delegations';

export default function Approvals() {
  const { t } = useTranslation();
  const { can } = useAuth();
  const [tab, setTab] = useState<Tab>('inbox');
  return (
    <div>
      <PageHeader icon={<PageIcon />} title={t('nav.approvals')} subtitle={t('approvals.subtitle')} />
      <Tabs
        className="mb-4"
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'inbox', label: t('approvals.inbox') },
          { id: 'mine', label: t('approvals.mine') },
          { id: 'handled', label: t('approvals.handled') },
          { id: 'all', label: t('approvals.all'), hidden: !can('approval.read.all') },
          { id: 'delegations', label: t('approvals.delegations') },
        ]}
      />
      {tab === 'inbox' && <Inbox />}
      {tab === 'mine' && <RequestList view="mine" />}
      {tab === 'handled' && <RequestList view="handled" />}
      {tab === 'all' && <RequestList view="all" />}
      {tab === 'delegations' && <Delegations />}
    </div>
  );
}

function useColumns(withRequester = true): Column<ApprovalRequest>[] {
  const { t } = useTranslation();
  return [
    { key: 'type', header: t('approvals.type'), cell: (r) => <Badge tone="primary">{t(`requestType.${r.requestType}`)}</Badge> },
    { key: 'title', header: t('approvals.request'), cell: (r) => <span className="font-medium">{r.title}</span> },
    ...(withRequester ? [{ key: 'by', header: t('approvals.requestedBy'), hideBelow: 'md' as const, cell: (r: ApprovalRequest) => r.requester.displayName }] : []),
    { key: 'when', header: t('approvals.submitted'), hideBelow: 'sm', cell: (r) => <span title={fmtDate(r.createdAt)}>{relativeTime(r.createdAt)}</span> },
    { key: 'step', header: t('approvals.step'), hideBelow: 'lg', align: 'center', cell: (r) => (r.status === 'PENDING' ? r.currentStep : '—') },
    { key: 'status', header: t('common.status'), cell: (r) => <StatusBadge status={r.status} /> },
  ];
}

function Inbox() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const confirm = useConfirm();
  const [type, setType] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const list = usePaged<ApprovalRequest>('/approvals/inbox', { requestType: type || undefined });
  const columns = useColumns();
  const bulk = useApiMutation(
    ({ decision, comment }: { decision: 'APPROVED' | 'REJECTED'; comment?: string }) => api.post<{ results: { ok: boolean; error?: string }[] }>('/approvals/bulk', { ids: [...selected], decision, comment }),
    {
      success: (r) => t('approvals.bulkDone', { ok: r.results.filter((x) => x.ok).length, total: r.results.length }),
      invalidate: ['/approvals', '/leave', '/attendance', '/payroll'],
      onSuccess: (r) => {
        r.results.filter((x) => !x.ok).forEach((x) => toast.error(x.error ?? ''));
        setSelected(new Set());
      },
    },
  );
  const decideBulk = async (decision: 'APPROVED' | 'REJECTED') => {
    const res = await confirm({
      title: decision === 'APPROVED' ? t('approvals.approveSelected', { count: selected.size }) : t('approvals.rejectSelected', { count: selected.size }),
      tone: decision === 'REJECTED' ? 'danger' : 'primary',
      confirmLabel: decision === 'APPROVED' ? t('approvals.approve') : t('approvals.reject'),
      reason: { label: t('approvals.comment'), required: decision === 'REJECTED', minLength: decision === 'REJECTED' ? 3 : 0 },
    });
    if (res) bulk.mutate({ decision, comment: res.reason || undefined });
  };
  return (
    <Card padded={false}>
      <div className="flex flex-col gap-3 border-b border-line p-4 sm:flex-row sm:items-center sm:justify-between">
        <Select value={type} onChange={(e) => setType(e.target.value)} placeholder={t('approvals.allTypes')} className="sm:w-64" aria-label={t('approvals.type')}>
          {REQUEST_TYPES.map((x) => (
            <option key={x} value={x}>
              {t(`requestType.${x}`)}
            </option>
          ))}
        </Select>
        {selected.size > 0 && (
          <div className="flex items-center gap-2">
            <span className="text-sm text-ink-2">{t('approvals.selected', { count: selected.size })}</span>
            <Button variant="danger" size="sm" icon={<X className="h-4 w-4" />} onClick={() => decideBulk('REJECTED')} loading={bulk.isPending}>
              {t('approvals.reject')}
            </Button>
            <Button variant="success" size="sm" icon={<Check className="h-4 w-4" />} onClick={() => decideBulk('APPROVED')} loading={bulk.isPending}>
              {t('approvals.approve')}
            </Button>
          </div>
        )}
      </div>
      <DataTable
        columns={columns}
        rows={list.data?.items}
        rowKey={(r) => r.id}
        loading={list.isLoading}
        error={list.error}
        onRowClick={(r) => navigate(`/approvals/${r.id}`)}
        selectable={{ selected, onChange: setSelected }}
        empty={{ title: t('approvals.inboxEmpty'), description: t('approvals.inboxEmptyHint') }}
      />
      {list.data && <Pagination page={list.page} pageCount={list.data.pageCount} total={list.data.total} pageSize={list.pageSize} onPage={list.setPage} />}
    </Card>
  );
}

function RequestList({ view }: { view: 'mine' | 'handled' | 'all' }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [status, setStatus] = useState('');
  const [type, setType] = useState('');
  const list = usePaged<ApprovalRequest>('/approvals/requests', { view, status: status || undefined, requestType: type || undefined });
  const columns = useColumns(view !== 'mine');
  return (
    <Card padded={false}>
      <div className="flex flex-col gap-3 border-b border-line p-4 sm:flex-row">
        <SearchInput className="sm:max-w-xs flex-1" placeholder={t('common.searchPlaceholder')} value={list.search} onChange={(e) => list.setSearch(e.target.value)} />
        <Select value={type} onChange={(e) => setType(e.target.value)} placeholder={t('approvals.allTypes')} className="sm:w-56">
          {REQUEST_TYPES.map((x) => (
            <option key={x} value={x}>
              {t(`requestType.${x}`)}
            </option>
          ))}
        </Select>
        <Select value={status} onChange={(e) => setStatus(e.target.value)} placeholder={t('attendance.allStatuses')} className="sm:w-48">
          {['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED'].map((s) => (
            <option key={s} value={s}>
              {t(`status.${s}`)}
            </option>
          ))}
        </Select>
      </div>
      <DataTable columns={columns} rows={list.data?.items} rowKey={(r) => r.id} loading={list.isLoading} error={list.error} onRowClick={(r) => navigate(`/approvals/${r.id}`)} empty={{ title: t('approvals.none') }} />
      {list.data && <Pagination page={list.page} pageCount={list.data.pageCount} total={list.data.total} pageSize={list.pageSize} onPage={list.setPage} onPageSize={list.setPageSize} />}
    </Card>
  );
}

interface Delegation {
  id: string;
  startDate: string;
  endDate: string;
  isActive: boolean;
  requestTypes: string[];
  fromUser: { id: string; displayName: string };
  toUser: { id: string; displayName: string };
}

function Delegations() {
  const { t } = useTranslation();
  const { me } = useAuth();
  const [open, setOpen] = useState(false);
  const { data, isLoading } = useGet<Delegation[]>('/approvals/delegations');
  const revoke = useApiMutation((id: string) => api.delete(`/approvals/delegations/${id}`), { success: t('approvals.delegationRevoked'), invalidate: ['/approvals/delegations'] });
  return (
    <Card padded={false}>
      <div className="flex items-center justify-between border-b border-line p-4">
        <p className="text-sm text-ink-3">{t('approvals.delegationsHint')}</p>
        <Button variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => setOpen(true)}>
          {t('approvals.newDelegation')}
        </Button>
      </div>
      <DataTable
        rows={data}
        loading={isLoading}
        rowKey={(d) => d.id}
        empty={{ title: t('approvals.noDelegations') }}
        columns={[
          { key: 'from', header: t('approvals.from'), cell: (d) => d.fromUser.displayName },
          { key: 'to', header: t('approvals.to'), cell: (d) => d.toUser.displayName },
          { key: 'period', header: t('approvals.period'), cell: (d) => `${fmtDate(d.startDate)} – ${fmtDate(d.endDate)}` },
          { key: 'types', header: t('approvals.types'), hideBelow: 'md', cell: (d) => (d.requestTypes.length ? d.requestTypes.map((x) => t(`requestType.${x}`)).join(', ') : t('approvals.allTypes')) },
          { key: 'status', header: t('common.status'), cell: (d) => (d.isActive ? <Badge tone="success">{t('common.active')}</Badge> : <Badge>{t('approvals.revoked')}</Badge>) },
          { key: 'a', header: '', align: 'end', cell: (d) => d.isActive && d.fromUser.id === me?.id && <Button size="icon" variant="ghost" aria-label={t('approvals.revoke')} icon={<Trash2 className="h-4 w-4 text-danger" />} onClick={() => revoke.mutate(d.id)} /> },
        ]}
      />
      <DelegationDialog open={open} onClose={() => setOpen(false)} />
    </Card>
  );
}

function DelegationDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const [toUserId, setTo] = useState<string | null>(null);
  const [start, setStart] = useState(new Date().toISOString().slice(0, 10));
  const [end, setEnd] = useState(new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10));
  const save = useApiMutation(() => api.post('/approvals/delegations', { toUserId, startDate: start, endDate: end }), { success: t('approvals.delegationCreated'), invalidate: ['/approvals/delegations'], onSuccess: onClose });
  return (
    <Dialog open={open} onClose={onClose} title={t('approvals.newDelegation')} description={t('approvals.delegationsHint')} footer={<><Button onClick={onClose}>{t('common.cancel')}</Button><Button variant="primary" disabled={!toUserId} loading={save.isPending} onClick={() => save.mutate(undefined)}>{t('common.save')}</Button></>}>
      <div className="space-y-4">
        <Field label={t('approvals.delegateTo')} required hint={t('approvals.delegateHint')}>
          <EmployeePicker value={null} onChange={(_, emp) => setTo(emp?.user?.id ?? null)} valueLabel={toUserId ? t('common.selected') : undefined} />
        </Field>
        <FormGrid>
          <Field label={t('common.from')}>
            <Input type="date" value={start} onChange={(e) => setStart(e.target.value)} />
          </Field>
          <Field label={t('common.to')}>
            <Input type="date" value={end} min={start} onChange={(e) => setEnd(e.target.value)} />
          </Field>
        </FormGrid>
      </div>
    </Dialog>
  );
}

