import { nationalityName } from '@shared/countries';
import { useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, Camera, Download, FileText, Mail, MoreHorizontal, Pencil, Phone, Plus, Trash2, UserX, Archive } from 'lucide-react';
import { toast } from '@/lib/toast';
import { api, download } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { errorMessage, useApiMutation, useGet, usePaged } from '@/lib/hooks';
import { localized, personName } from '@/lib/i18n';
import { fmtBytes, fmtDate, fmtMinutes, fmtMoney, fmtNumber, fmtTime } from '@/lib/format';
import type { Employee } from '@/lib/types';
import { Button } from '@/components/ui/button';
import { Field, FormGrid, Input, Select, Textarea, Checkbox } from '@/components/ui/form';
import { Alert, Badge, Card, CardHeader, DescriptionList, EmptyState, ErrorState, Spinner, StatusBadge } from '@/components/ui/display';
import { Dialog, useConfirm } from '@/components/ui/dialog';
import { Menu, MenuItem, Tabs } from '@/components/ui/nav';
import { DataTable, Pagination } from '@/components/ui/table';
import { EmployeeAvatar } from '@/components/ui/pickers';
import { EmployeeFormDialog } from './EmployeeForm';
import { SalaryTab } from './SalaryTab';

type Tab = 'overview' | 'documents' | 'history' | 'salary' | 'leave' | 'attendance';

export default function EmployeeDetail() {
  const { id } = useParams<{ id: string }>();
  const { t } = useTranslation();
  const { me, can } = useAuth();
  const navigate = useNavigate();
  const confirm = useConfirm();
  const [params, setParams] = useSearchParams();
  const tab = (params.get('tab') as Tab) || 'overview';
  const [editing, setEditing] = useState(false);
  const [separating, setSeparating] = useState(false);
  const photoInput = useRef<HTMLInputElement>(null);
  const { data: e, isLoading, error, refetch } = useGet<Employee>(`/employees/${id}`);
  const own = me?.employee?.id === id;

  const uploadPhoto = useApiMutation(
    (file: File) => {
      const fd = new FormData();
      fd.set('file', file);
      return api.post(`/employees/${id}/photo`, fd);
    },
    { success: t('employees.photoUpdated'), invalidate: ['/employees'] },
  );
  const archive = useApiMutation(() => api.delete(`/employees/${id}`), { success: t('employees.archived'), onSuccess: () => navigate('/employees'), invalidate: ['/employees'] });

  if (isLoading) return <Spinner />;
  if (error || !e) return <ErrorState error={error} onRetry={() => refetch()} />;
  const separated = ['RESIGNED', 'TERMINATED', 'RETIRED'].includes(e.status);

  return (
    <div className="space-y-6">
      <Link to={can('employee.read') ? '/employees' : '/'} className="inline-flex items-center gap-1 text-sm text-ink-3 hover:text-ink">
        <ArrowLeft className="h-4 w-4 rtl:rotate-180" /> {can('employee.read') ? t('nav.employees') : t('nav.home')}
      </Link>

      <Card>
        <div className="flex flex-col gap-5 sm:flex-row sm:items-center">
          <div className="relative w-fit">
            <EmployeeAvatar employee={e} size="xl" />
            {can('employee.update') && (
              <>
                <button onClick={() => photoInput.current?.click()} className="absolute bottom-0 end-0 rounded-full border-2 border-surface bg-primary p-1.5 text-primary-fg" aria-label={t('employees.changePhoto')}>
                  <Camera className="h-3.5 w-3.5" />
                </button>
                <input ref={photoInput} type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={(ev) => ev.target.files?.[0] && uploadPhoto.mutate(ev.target.files[0])} />
              </>
            )}
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-2xl font-semibold">{personName(e)}</h1>
              <StatusBadge status={e.status} />
            </div>
            <p className="text-sm text-ink-2">
              {[localized(e.position as unknown as Record<string, unknown>, 'title'), localized(e.department as unknown as Record<string, unknown>, 'name'), localized(e.branch as unknown as Record<string, unknown>, 'name')].filter(Boolean).join(' · ')}
            </p>
            <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-sm text-ink-3">
              <span className="tabular">{e.employeeNo}</span>
              <a href={`mailto:${e.email}`} className="inline-flex items-center gap-1 hover:text-ink">
                <Mail className="h-3.5 w-3.5" /> {e.email}
              </a>
              {e.phone && (
                <a href={`tel:${e.phone}`} className="inline-flex items-center gap-1 hover:text-ink">
                  <Phone className="h-3.5 w-3.5" /> <span dir="ltr">{e.phone}</span>
                </a>
              )}
            </div>
          </div>
          <div className="flex gap-2">
            {can('employee.update') && !separated && (
              <Button icon={<Pencil className="h-4 w-4" />} onClick={() => setEditing(true)}>
                {t('common.edit')}
              </Button>
            )}
            {(can('employee.update') || can('employee.delete')) && !separated && (
              <Menu trigger={() => <Button size="icon" variant="secondary" aria-label={t('common.more')} icon={<MoreHorizontal className="h-4 w-4" />} />}>
                {(close) => (
                  <>
                    {can('employee.update') && (
                      <MenuItem icon={<UserX className="h-4 w-4" />} onClick={() => (close(), setSeparating(true))}>
                        {t('employees.recordSeparation')}
                      </MenuItem>
                    )}
                    {can('employee.delete') && (
                      <MenuItem
                        danger
                        icon={<Archive className="h-4 w-4" />}
                        onClick={async () => {
                          close();
                          if (await confirm({ title: t('employees.archiveTitle'), message: t('employees.archiveText'), tone: 'danger', confirmLabel: t('employees.archive') })) archive.mutate(undefined);
                        }}
                      >
                        {t('employees.archive')}
                      </MenuItem>
                    )}
                  </>
                )}
              </Menu>
            )}
          </div>
        </div>
        {separated && (
          <div className="mt-4">
            <Alert tone="neutral" title={t('employees.separatedOn', { status: t(`status.${e.status}`), date: fmtDate(e.separationDate) })}>
              {e.separationReason}
            </Alert>
          </div>
        )}
      </Card>

      <Tabs
        value={tab}
        onChange={(v) => setParams({ tab: v }, { replace: true })}
        tabs={[
          { id: 'overview', label: t('employees.tabs.overview') },
          { id: 'documents', label: t('employees.tabs.documents'), count: e._count?.documents, hidden: !own && !can('document.read') },
          { id: 'history', label: t('employees.tabs.history') },
          { id: 'salary', label: t('employees.tabs.salary'), hidden: !own && !can('employee.salary.read') },
          { id: 'leave', label: t('employees.tabs.leave'), hidden: !own && !can('leave.read') },
          { id: 'attendance', label: t('employees.tabs.attendance'), hidden: !own && !can('attendance.read') },
        ]}
      />

      {tab === 'overview' && <Overview e={e} own={own} />}
      {tab === 'documents' && <Documents employeeId={e.id} canManage={can('document.manage')} />}
      {tab === 'history' && <History employeeId={e.id} />}
      {tab === 'salary' && <SalaryTab employee={e} />}
      {tab === 'leave' && <LeaveTab employeeId={e.id} />}
      {tab === 'attendance' && <AttendanceTab employeeId={e.id} />}

      <EmployeeFormDialog open={editing} onClose={() => setEditing(false)} employee={e} onSaved={() => refetch()} />
      <SeparationDialog open={separating} onClose={() => setSeparating(false)} employee={e} />
    </div>
  );
}

function Overview({ e, own }: { e: Employee; own: boolean }) {
  const { t, i18n } = useTranslation();
  const [editingSelf, setEditingSelf] = useState(false);
  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <Card>
        <CardHeader title={t('employees.employment')} />
        <DescriptionList
          items={[
            [t('employees.employeeNo'), <span className="tabular">{e.employeeNo}</span>],
            [t('common.position'), localized(e.position as unknown as Record<string, unknown>, 'title')],
            [t('common.department'), localized(e.department as unknown as Record<string, unknown>, 'name')],
            [t('common.branch'), localized(e.branch as unknown as Record<string, unknown>, 'name')],
            [t('common.manager'), e.manager ? <Link className="text-primary-ink hover:underline" to={`/employees/${e.manager.id}`}>{personName(e.manager)}</Link> : null],
            [t('employees.grade'), e.grade?.name],
            [t('employees.employmentType'), localized(e.employmentType as unknown as Record<string, unknown>, 'name')],
            [t('employees.category'), localized(e.category as unknown as Record<string, unknown>, 'name')],
            [t('employees.costCenter'), e.costCenter ? `${e.costCenter.code} · ${e.costCenter.name}` : null],
            [t('employees.shift'), e.shift ? `${e.shift.name}` : t('employees.defaultShift')],
            [t('employees.hireDate'), fmtDate(e.hireDate)],
            [t('employees.probationEnd'), e.probationEndDate ? fmtDate(e.probationEndDate) : null],
            [t('employees.contract'), e.contractStartDate || e.contractEndDate ? `${fmtDate(e.contractStartDate)} – ${e.contractEndDate ? fmtDate(e.contractEndDate) : t('employees.openEnded')}` : null],
            [t('employees.directReports'), fmtNumber(e._count?.reports ?? 0)],
          ]}
        />
      </Card>
      <div className="space-y-6">
        <Card>
          <CardHeader
            title={t('employees.personal')}
            actions={
              own && (
                <Button size="sm" variant="ghost" icon={<Pencil className="h-4 w-4" />} onClick={() => setEditingSelf(true)}>
                  {t('employees.updateMyDetails')}
                </Button>
              )
            }
          />
          <DescriptionList
            items={[
              [t('employees.nameAr'), e.firstNameAr ? <span dir="rtl">{`${e.firstNameAr} ${e.lastNameAr ?? ''}`}</span> : null],
              [t('employees.gender'), e.gender ? t(`employees.${e.gender.toLowerCase()}`) : null],
              [t('employees.dateOfBirth'), e.dateOfBirth ? fmtDate(e.dateOfBirth) : null],
              [t('employees.nationality'), e.nationality ? nationalityName(e.nationality, i18n.language === 'ar' ? 'ar' : 'en') : null],
              [t('employees.maritalStatus'), e.maritalStatus ? t(`employees.marital.${e.maritalStatus}`) : null],
              [t('employees.nationalId'), e.nationalId ?? (e.canViewSensitive ? null : t('employees.restricted'))],
              [t('employees.personalEmail'), e.personalEmail],
              [t('employees.address'), e.address],
              [t('employees.emergencyContact'), e.emergencyContact ? `${e.emergencyContact.name}${e.emergencyContact.relation ? ` (${e.emergencyContact.relation})` : ''} · ${e.emergencyContact.phone}` : null],
            ]}
          />
        </Card>
        <Card>
          <CardHeader title={t('employees.bank')} />
          <DescriptionList
            items={[
              [t('employees.bankName'), e.bankName],
              [t('employees.iban'), e.iban ? <span className="font-mono tabular">{e.iban}</span> : e.canViewSensitive || own ? null : t('employees.restricted')],
              [t('employees.bankAccount'), e.bankAccount ? <span className="font-mono">{e.bankAccount}</span> : null],
            ]}
          />
        </Card>
        {e.user && (
          <Card>
            <CardHeader title={t('employees.systemAccess')} />
            <DescriptionList
              items={[
                [t('login.email'), e.user.email],
                [t('common.status'), e.user.isActive ? <Badge tone="success">{t('common.active')}</Badge> : <Badge>{t('common.inactive')}</Badge>],
                [t('employees.roles'), e.user.roles.map((r) => r.role.name).join(', ')],
                [t('employees.lastLogin'), e.user.lastLoginAt ? fmtDate(e.user.lastLoginAt) : t('employees.never')],
              ]}
            />
          </Card>
        )}
      </div>
      {own && <SelfEditDialog open={editingSelf} onClose={() => setEditingSelf(false)} e={e} />}
    </div>
  );
}

function SelfEditDialog({ open, onClose, e }: { open: boolean; onClose: () => void; e: Employee }) {
  const { t } = useTranslation();
  const [v, setV] = useState({ phone: e.phone ?? '', personalEmail: e.personalEmail ?? '', address: e.address ?? '', ecName: e.emergencyContact?.name ?? '', ecRelation: e.emergencyContact?.relation ?? '', ecPhone: e.emergencyContact?.phone ?? '' });
  const save = useApiMutation(
    () =>
      api.patch('/employees/me', {
        phone: v.phone || null,
        personalEmail: v.personalEmail || null,
        address: v.address || null,
        emergencyContact: v.ecName && v.ecPhone ? { name: v.ecName, relation: v.ecRelation || undefined, phone: v.ecPhone } : null,
      }),
    { invalidate: ['/employees'], onSuccess: onClose },
  );
  const set = (k: keyof typeof v) => (ev: React.ChangeEvent<HTMLInputElement>) => setV({ ...v, [k]: ev.target.value });
  return (
    <Dialog open={open} onClose={onClose} title={t('employees.updateMyDetails')} description={t('employees.selfEditHint')} footer={<><Button onClick={onClose}>{t('common.cancel')}</Button><Button variant="primary" loading={save.isPending} onClick={() => save.mutate(undefined)}>{t('common.save')}</Button></>}>
      <FormGrid>
        <Field label={t('employees.phone')}><Input type="tel" value={v.phone} onChange={set('phone')} /></Field>
        <Field label={t('employees.personalEmail')}><Input type="email" value={v.personalEmail} onChange={set('personalEmail')} /></Field>
        <Field label={t('employees.address')} className="sm:col-span-2"><Input value={v.address} onChange={set('address')} /></Field>
        <Field label={t('employees.emergencyContact')}><Input value={v.ecName} onChange={set('ecName')} placeholder={t('common.name')} /></Field>
        <Field label={t('employees.relation')}><Input value={v.ecRelation} onChange={set('ecRelation')} /></Field>
        <Field label={t('employees.emergencyPhone')}><Input type="tel" value={v.ecPhone} onChange={set('ecPhone')} /></Field>
      </FormGrid>
    </Dialog>
  );
}

function SeparationDialog({ open, onClose, employee }: { open: boolean; onClose: () => void; employee: Employee }) {
  const { t } = useTranslation();
  const [type, setType] = useState('RESIGNED');
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [reason, setReason] = useState('');
  const save = useApiMutation(() => api.post(`/employees/${employee.id}/separate`, { type, date, reason }), { success: t('employees.separationRecorded'), invalidate: ['/employees'], onSuccess: onClose });
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t('employees.recordSeparation')}
      description={personName(employee)}
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="danger" disabled={reason.trim().length < 3} loading={save.isPending} onClick={() => save.mutate(undefined)}>
            {t('employees.confirmSeparation')}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <FormGrid>
          <Field label={t('employees.separationType')}>
            <Select value={type} onChange={(e) => setType(e.target.value)}>
              {['RESIGNED', 'TERMINATED', 'RETIRED'].map((s) => (
                <option key={s} value={s}>
                  {t(`status.${s}`)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t('employees.lastWorkingDay')}>
            <Input type="date" value={date} min={employee.hireDate.slice(0, 10)} onChange={(e) => setDate(e.target.value)} />
          </Field>
        </FormGrid>
        <Field label={t('leave.reason')} required>
          <Textarea value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
        <Alert tone="warning">{t('employees.separationEffect')}</Alert>
      </div>
    </Dialog>
  );
}

interface Doc {
  id: string;
  type: string;
  title: string;
  documentNo: string | null;
  fileName: string;
  sizeBytes: number;
  issueDate: string | null;
  expiryDate: string | null;
  confidential: boolean;
  createdAt: string;
}

function Documents({ employeeId, canManage }: { employeeId: string; canManage: boolean }) {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const [uploading, setUploading] = useState(false);
  const { data, isLoading, error, refetch } = useGet<Doc[]>(`/employees/${employeeId}/documents`);
  const remove = useApiMutation((id: string) => api.delete(`/employees/${employeeId}/documents/${id}`), { success: t('documents.deleted'), invalidate: [`/employees/${employeeId}`] });
  const today = new Date().toISOString().slice(0, 10);
  return (
    <Card padded={false}>
      <div className="flex items-center justify-between border-b border-line p-4">
        <h2 className="font-semibold">{t('employees.tabs.documents')}</h2>
        {canManage && (
          <Button size="sm" variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => setUploading(true)}>
            {t('documents.upload')}
          </Button>
        )}
      </div>
      <DataTable
        rows={data}
        loading={isLoading}
        error={error}
        onRetry={() => refetch()}
        rowKey={(d) => d.id}
        empty={{ title: t('documents.none') }}
        columns={[
          {
            key: 'title',
            header: t('documents.document'),
            cell: (d) => (
              <div className="flex items-center gap-2">
                <FileText className="h-4 w-4 text-ink-3" aria-hidden />
                <div>
                  <p className="font-medium">{d.title}</p>
                  <p className="text-xs text-ink-3">
                    {d.fileName} · {fmtBytes(d.sizeBytes)}
                  </p>
                </div>
                {d.confidential && <Badge tone="danger">{t('documents.confidential')}</Badge>}
              </div>
            ),
          },
          { key: 'type', header: t('documents.type'), hideBelow: 'sm', cell: (d) => t(`documents.types.${d.type}`) },
          { key: 'no', header: t('documents.number'), hideBelow: 'md', cell: (d) => d.documentNo ?? '—' },
          {
            key: 'expiry',
            header: t('documents.expiry'),
            cell: (d) =>
              d.expiryDate ? (
                <span className={d.expiryDate.slice(0, 10) < today ? 'font-medium text-danger-ink' : ''}>
                  {fmtDate(d.expiryDate)}
                  {d.expiryDate.slice(0, 10) < today && ` · ${t('documents.expired')}`}
                </span>
              ) : (
                '—'
              ),
          },
          {
            key: 'actions',
            header: '',
            align: 'end',
            cell: (d) => (
              <div className="flex justify-end gap-1">
                <Button size="icon" variant="ghost" aria-label={t('common.download')} onClick={() => download(`/employees/${employeeId}/documents/${d.id}/download`, undefined, d.fileName)} icon={<Download className="h-4 w-4" />} />
                {canManage && (
                  <Button
                    size="icon"
                    variant="ghost"
                    aria-label={t('common.delete')}
                    icon={<Trash2 className="h-4 w-4 text-danger" />}
                    onClick={async () => (await confirm({ title: t('documents.deleteTitle'), message: d.title, tone: 'danger', confirmLabel: t('common.delete') })) && remove.mutate(d.id)}
                  />
                )}
              </div>
            ),
          },
        ]}
      />
      <UploadDialog open={uploading} onClose={() => setUploading(false)} employeeId={employeeId} />
    </Card>
  );
}

function UploadDialog({ open, onClose, employeeId }: { open: boolean; onClose: () => void; employeeId: string }) {
  const { t } = useTranslation();
  const [file, setFile] = useState<File | null>(null);
  const [f, setF] = useState({ type: 'CONTRACT', title: '', documentNo: '', issueDate: '', expiryDate: '', confidential: false });
  const save = useApiMutation(
    () => {
      const fd = new FormData();
      fd.set('file', file!);
      Object.entries(f).forEach(([k, v]) => fd.set(k, String(v)));
      return api.post(`/employees/${employeeId}/documents`, fd);
    },
    {
      success: t('documents.uploaded'),
      invalidate: [`/employees/${employeeId}`],
      onSuccess: () => {
        setFile(null);
        setF({ ...f, title: '', documentNo: '', issueDate: '', expiryDate: '' });
        onClose();
      },
    },
  );
  return (
    <Dialog open={open} onClose={onClose} title={t('documents.upload')} footer={<><Button onClick={onClose}>{t('common.cancel')}</Button><Button variant="primary" disabled={!file || !f.title} loading={save.isPending} onClick={() => save.mutate(undefined)}>{t('documents.upload')}</Button></>}>
      <div className="space-y-4">
        <Field label={t('documents.file')} required hint={t('documents.fileHint')}>
          <input type="file" onChange={(e) => (setFile(e.target.files?.[0] ?? null), !f.title && e.target.files?.[0] && setF({ ...f, title: e.target.files[0].name.replace(/\.[^.]+$/, '') }))} className="block w-full text-sm text-ink-2 file:me-3 file:rounded-lg file:border-0 file:bg-subtle file:px-3 file:py-2 file:text-sm file:font-medium" />
        </Field>
        <FormGrid>
          <Field label={t('documents.type')}>
            <Select value={f.type} onChange={(e) => setF({ ...f, type: e.target.value })}>
              {['CONTRACT', 'ID', 'PASSPORT', 'VISA', 'CERTIFICATE', 'LETTER', 'OTHER'].map((x) => (
                <option key={x} value={x}>
                  {t(`documents.types.${x}`)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t('documents.title')} required>
            <Input value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} />
          </Field>
          <Field label={t('documents.number')}>
            <Input value={f.documentNo} onChange={(e) => setF({ ...f, documentNo: e.target.value })} />
          </Field>
          <div />
          <Field label={t('documents.issueDate')}>
            <Input type="date" value={f.issueDate} onChange={(e) => setF({ ...f, issueDate: e.target.value })} />
          </Field>
          <Field label={t('documents.expiry')} hint={t('documents.expiryHint')}>
            <Input type="date" value={f.expiryDate} onChange={(e) => setF({ ...f, expiryDate: e.target.value })} />
          </Field>
        </FormGrid>
        <Checkbox label={t('documents.markConfidential')} checked={f.confidential} onChange={(e) => setF({ ...f, confidential: e.target.checked })} />
      </div>
    </Dialog>
  );
}

interface HistoryItem {
  id: string;
  type: string;
  effectiveDate: string;
  fromValue: Record<string, unknown> | null;
  toValue: Record<string, unknown> | null;
  reason: string | null;
}

function History({ employeeId }: { employeeId: string }) {
  const { t } = useTranslation();
  const { data, isLoading, error } = useGet<{ items: HistoryItem[]; names: Record<string, string> }>(`/employees/${employeeId}/history`);
  if (isLoading) return <Spinner />;
  if (error) return <ErrorState error={error} />;
  const show = (v: unknown, field: string) => {
    if (v === null || v === undefined) return '—';
    if (typeof v === 'string' && data!.names[v]) return data!.names[v];
    if (field === 'status') return t(`status.${v}`);
    if (field === 'basicSalary') return fmtNumber(Number(v), 2);
    return String(v);
  };
  if (!data?.items.length) return <Card><EmptyState title={t('history.none')} /></Card>;
  return (
    <Card>
      <ol className="relative space-y-6 border-s border-line ps-6">
        {data.items.map((h) => (
          <li key={h.id} className="relative">
            <span className="absolute -start-[1.95rem] top-1 h-3 w-3 rounded-full border-2 border-surface bg-primary" aria-hidden />
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={h.type === 'HIRE' ? 'success' : h.type === 'STATUS_CHANGE' ? 'warning' : h.type === 'SALARY_CHANGE' ? 'info' : 'primary'}>{t(`history.types.${h.type}`)}</Badge>
              <span className="text-sm text-ink-3">{fmtDate(h.effectiveDate)}</span>
            </div>
            <ul className="mt-2 space-y-1 text-sm">
              {Object.keys({ ...(h.fromValue ?? {}), ...(h.toValue ?? {}) })
                .filter((k) => h.type !== 'HIRE' || (h.toValue ?? {})[k])
                .map((k) => (
                  <li key={k}>
                    <span className="text-ink-3">{t(`history.fields.${k}`, k)}:</span>{' '}
                    {h.type !== 'HIRE' && (
                      <>
                        <span className="line-through decoration-ink-3/50">{show(h.fromValue?.[k], k)}</span> →{' '}
                      </>
                    )}
                    <span className="font-medium">{show(h.toValue?.[k], k)}</span>
                  </li>
                ))}
            </ul>
            {h.reason && <p className="mt-1 text-sm text-ink-2">“{h.reason}”</p>}
          </li>
        ))}
      </ol>
    </Card>
  );
}

function LeaveTab({ employeeId }: { employeeId: string }) {
  const { t } = useTranslation();
  const { data: balances = [] } = useGet<{ id: string; entitled: string; carriedOver: string; adjusted: string; used: string; pending: string; available: number; leaveType: { id: string; name: string; nameAr: string | null; color: string; accrualMethod: string } }[]>('/leave/balances', { employeeId });
  const list = usePaged<{ id: string; startDate: string; endDate: string; days: string; status: string; leaveType: { name: string; nameAr: string | null } }>('/leave/requests', { employeeId }, { pageSize: 10 });
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        {balances
          .filter((b) => b.leaveType.accrualMethod !== 'NONE')
          .map((b) => (
            <Card key={b.id}>
              <p className="flex items-center gap-2 text-sm text-ink-2">
                <span className="h-2.5 w-2.5 rounded-full" style={{ background: b.leaveType.color }} aria-hidden />
                {localized(b.leaveType as unknown as Record<string, unknown>, 'name')}
              </p>
              <p className="mt-2 text-2xl font-semibold tabular">{fmtNumber(b.available, b.available % 1 ? 1 : 0)}</p>
              <p className="text-xs text-ink-3">{t('leave.balanceBreakdown', { entitled: Number(b.entitled) + Number(b.carriedOver) + Number(b.adjusted), used: Number(b.used), pending: Number(b.pending) })}</p>
            </Card>
          ))}
      </div>
      <Card padded={false}>
        <DataTable
          rows={list.data?.items}
          loading={list.isLoading}
          rowKey={(r) => r.id}
          empty={{ title: t('leave.noRequests') }}
          columns={[
            { key: 'type', header: t('leave.type'), cell: (r) => localized(r.leaveType as unknown as Record<string, unknown>, 'name') },
            { key: 'dates', header: t('leave.dates'), cell: (r) => `${fmtDate(r.startDate)} – ${fmtDate(r.endDate)}` },
            { key: 'days', header: t('leave.days'), align: 'end', cell: (r) => fmtNumber(Number(r.days), Number(r.days) % 1 ? 1 : 0) },
            { key: 'status', header: t('common.status'), cell: (r) => <StatusBadge status={r.status} /> },
          ]}
        />
        {list.data && <Pagination page={list.page} pageCount={list.data.pageCount} total={list.data.total} pageSize={list.pageSize} onPage={list.setPage} />}
      </Card>
    </div>
  );
}

function AttendanceTab({ employeeId }: { employeeId: string }) {
  const { t } = useTranslation();
  const list = usePaged<{ id: string; date: string; checkIn: string | null; checkOut: string | null; status: string; workedMinutes: number; lateMinutes: number; overtimeMinutes: number }>('/attendance/records', { employeeId }, { pageSize: 15, sort: 'date:desc' });
  return (
    <Card padded={false}>
      <DataTable
        rows={list.data?.items}
        loading={list.isLoading}
        rowKey={(r) => r.id}
        empty={{ title: t('attendance.none') }}
        columns={[
          { key: 'date', header: t('common.date'), cell: (r) => fmtDate(r.date, { weekday: 'short', day: '2-digit', month: 'short' }) },
          { key: 'in', header: t('attendance.checkIn'), cell: (r) => <span className="tabular">{fmtTime(r.checkIn)}</span> },
          { key: 'out', header: t('attendance.checkOut'), cell: (r) => <span className="tabular">{fmtTime(r.checkOut)}</span> },
          { key: 'worked', header: t('attendance.worked'), align: 'end', cell: (r) => fmtMinutes(r.workedMinutes) },
          { key: 'late', header: t('attendance.late'), align: 'end', hideBelow: 'sm', cell: (r) => (r.lateMinutes ? `${r.lateMinutes}m` : '—') },
          { key: 'ot', header: t('attendance.overtime'), align: 'end', hideBelow: 'sm', cell: (r) => (r.overtimeMinutes ? fmtMinutes(r.overtimeMinutes) : '—') },
          { key: 'status', header: t('common.status'), cell: (r) => <StatusBadge status={r.status} /> },
        ]}
      />
      {list.data && <Pagination page={list.page} pageCount={list.data.pageCount} total={list.data.total} pageSize={list.pageSize} onPage={list.setPage} />}
    </Card>
  );
}

