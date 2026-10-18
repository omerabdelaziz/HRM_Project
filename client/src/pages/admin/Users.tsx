import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Copy, KeyRound, MoreHorizontal, Plus, ShieldOff, Unlock } from 'lucide-react';
import { toast } from '@/lib/toast';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useApiMutation, useGet, usePaged } from '@/lib/hooks';
import { fmtDateTime } from '@/lib/format';
import { Button } from '@/components/ui/button';
import { Checkbox, Field, FieldErrors, FormGrid, Input, SearchInput, Select } from '@/components/ui/form';
import { Badge, Card, PageHeader } from '@/components/ui/display';
import { Dialog, useConfirm } from '@/components/ui/dialog';
import { Menu, MenuItem } from '@/components/ui/nav';
import { DataTable, Pagination } from '@/components/ui/table';
import { EmployeePicker } from '@/components/ui/pickers';
import { UserCog as PageIcon } from 'lucide-react';

interface UserRow {
  id: string;
  email: string;
  displayName: string;
  isActive: boolean;
  mfaEnabled: boolean;
  lastLoginAt: string | null;
  lockedUntil: string | null;
  employee: { id: string; employeeNo: string; companyId: string } | null;
  roles: { companyId: string | null; role: { id: string; code: string; name: string } }[];
}
interface Role {
  id: string;
  code: string;
  name: string;
}

export default function Users() {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const { me } = useAuth();
  const [roleCode, setRoleCode] = useState('');
  const [editing, setEditing] = useState<UserRow | 'new' | null>(null);
  const [secret, setSecret] = useState<{ email: string; password: string } | null>(null);
  const { data: roles = [] } = useGet<Role[]>('/roles');
  const list = usePaged<UserRow>('/users', { roleCode: roleCode || undefined });
  const reset = useApiMutation((u: UserRow) => api.post<{ temporaryPassword: string }>(`/users/${u.id}/reset-password`), { success: '', onSuccess: (r, u) => setSecret({ email: u.email, password: r.temporaryPassword }) });
  const unlock = useApiMutation((id: string) => api.post(`/users/${id}/unlock`), { success: t('users.unlocked'), invalidate: ['/users'] });
  const resetMfa = useApiMutation((id: string) => api.post(`/users/${id}/reset-mfa`), { success: t('users.mfaReset'), invalidate: ['/users'] });

  return (
    <div>
      <PageHeader icon={<PageIcon />}
        title={t('nav.users')}
        subtitle={t('users.subtitle')}
        actions={
          <Button variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => setEditing('new')}>
            {t('users.add')}
          </Button>
        }
      />
      <Card padded={false}>
        <div className="flex flex-col gap-3 border-b border-line p-4 sm:flex-row">
          <SearchInput className="sm:max-w-xs flex-1" placeholder={t('users.search')} value={list.search} onChange={(e) => list.setSearch(e.target.value)} />
          <Select value={roleCode} onChange={(e) => setRoleCode(e.target.value)} placeholder={t('users.allRoles')} className="sm:w-60">
            {roles.map((r) => (
              <option key={r.code} value={r.code}>
                {r.name}
              </option>
            ))}
          </Select>
        </div>
        <DataTable
          rows={list.data?.items}
          rowKey={(u) => u.id}
          loading={list.isLoading}
          error={list.error}
          columns={[
            {
              key: 'name',
              header: t('users.user'),
              cell: (u) => (
                <div>
                  <p className="font-medium">{u.displayName}</p>
                  <p className="text-xs text-ink-3">{u.email}</p>
                </div>
              ),
            },
            { key: 'roles', header: t('users.roles'), cell: (u) => <div className="flex flex-wrap gap-1">{u.roles.map((r) => <Badge key={r.role.code} tone={r.role.code === 'SUPER_ADMIN' ? 'danger' : 'primary'}>{r.role.name}</Badge>)}</div> },
            { key: 'emp', header: t('users.employeeLink'), hideBelow: 'lg', cell: (u) => u.employee?.employeeNo ?? '—' },
            { key: 'mfa', header: 'MFA', hideBelow: 'md', cell: (u) => (u.mfaEnabled ? <Badge tone="success">{t('common.on')}</Badge> : <Badge>{t('common.off')}</Badge>) },
            { key: 'last', header: t('employees.lastLogin'), hideBelow: 'md', cell: (u) => (u.lastLoginAt ? fmtDateTime(u.lastLoginAt) : t('employees.never')) },
            {
              key: 'status',
              header: t('common.status'),
              cell: (u) =>
                !u.isActive ? <Badge>{t('common.inactive')}</Badge> : u.lockedUntil && new Date(u.lockedUntil) > new Date() ? <Badge tone="danger">{t('users.locked')}</Badge> : <Badge tone="success">{t('common.active')}</Badge>,
            },
            {
              key: 'a',
              header: '',
              align: 'end',
              cell: (u) => (
                <Menu trigger={() => <Button size="icon" variant="ghost" aria-label={t('common.more')} icon={<MoreHorizontal className="h-4 w-4" />} />}>
                  {(close) => (
                    <>
                      <MenuItem onClick={() => (close(), setEditing(u))}>{t('common.edit')}</MenuItem>
                      <MenuItem icon={<KeyRound className="h-4 w-4" />} onClick={async () => (close(), (await confirm({ title: t('users.resetPassword'), message: t('users.resetText', { email: u.email }) })) && reset.mutate(u))}>
                        {t('users.resetPassword')}
                      </MenuItem>
                      {u.lockedUntil && (
                        <MenuItem icon={<Unlock className="h-4 w-4" />} onClick={() => (close(), unlock.mutate(u.id))}>
                          {t('users.unlock')}
                        </MenuItem>
                      )}
                      {u.mfaEnabled && (
                        <MenuItem icon={<ShieldOff className="h-4 w-4" />} onClick={async () => (close(), (await confirm({ title: t('users.resetMfa'), message: t('users.resetMfaText'), tone: 'danger' })) && resetMfa.mutate(u.id))}>
                          {t('users.resetMfa')}
                        </MenuItem>
                      )}
                    </>
                  )}
                </Menu>
              ),
            },
          ]}
        />
        {list.data && <Pagination page={list.page} pageCount={list.data.pageCount} total={list.data.total} pageSize={list.pageSize} onPage={list.setPage} />}
      </Card>
      <UserDialog user={editing} roles={roles} onClose={() => setEditing(null)} onCreated={(email, password) => setSecret({ email, password })} isSelf={editing !== 'new' && editing?.id === me?.id} />
      <Dialog open={!!secret} onClose={() => setSecret(null)} size="sm" title={t('users.tempPassword')} footer={<Button variant="primary" onClick={() => setSecret(null)}>{t('common.done')}</Button>}>
        <p className="text-sm text-ink-2">{t('users.tempPasswordText', { email: secret?.email })}</p>
        <div className="mt-3 flex items-center gap-2 rounded-lg border border-line bg-subtle p-3 font-mono text-sm">
          <span className="flex-1 select-all">{secret?.password}</span>
          <Button size="sm" variant="ghost" icon={<Copy className="h-4 w-4" />} onClick={() => (navigator.clipboard.writeText(secret!.password), toast.success(t('common.copied')))}>
            {t('common.copy')}
          </Button>
        </div>
      </Dialog>
    </div>
  );
}

function UserDialog({ user, roles, onClose, onCreated, isSelf }: { user: UserRow | 'new' | null; roles: Role[]; onClose: () => void; onCreated: (email: string, pw: string) => void; isSelf: boolean }) {
  const { t } = useTranslation();
  const { me } = useAuth();
  const isNew = user === 'new';
  const u = user && user !== 'new' ? user : null;
  const [email, setEmail] = useState('');
  const [displayName, setName] = useState('');
  const [employeeId, setEmp] = useState<string | null>(null);
  const [codes, setCodes] = useState<string[]>([]);
  const [active, setActive] = useState(true);
  const [last, setLast] = useState<typeof user>(null);
  if (user !== last) {
    setLast(user);
    setEmail(u?.email ?? '');
    setName(u?.displayName ?? '');
    setEmp(u?.employee?.id ?? null);
    setCodes(u?.roles.map((r) => r.role.code) ?? ['EMPLOYEE']);
    setActive(u?.isActive ?? true);
  }
  const save = useApiMutation(
    () => (isNew ? api.post<{ temporaryPassword: string; email: string }>('/users', { email, displayName, employeeId, roleCodes: codes }) : api.put<{ temporaryPassword?: string; email: string }>(`/users/${u!.id}`, { displayName, employeeId, roleCodes: codes, isActive: active })),
    { invalidate: ['/users'], onSuccess: (r) => (onClose(), r.temporaryPassword && onCreated(r.email, r.temporaryPassword)) },
  );
  const canGrantSuper = me?.roles.includes('SUPER_ADMIN');
  return (
    <Dialog open={!!user} onClose={onClose} title={isNew ? t('users.add') : t('users.edit')} footer={<><Button onClick={onClose}>{t('common.cancel')}</Button><Button variant="primary" disabled={!displayName || (isNew && !email) || !codes.length} loading={save.isPending} onClick={() => save.mutate(undefined)}>{t('common.save')}</Button></>}>
      <FieldErrors errors={save.fieldErrors}>
      <div className="space-y-4">
        <FormGrid>
          <Field name="email" label={t('login.email')} required>
            <Input type="email" value={email} disabled={!isNew} onChange={(e) => setEmail(e.target.value)} />
          </Field>
          <Field name="displayName" label={t('users.displayName')} required>
            <Input value={displayName} onChange={(e) => setName(e.target.value)} />
          </Field>
        </FormGrid>
        <Field label={t('users.employeeLink')} hint={t('users.employeeLinkHint')}>
          <EmployeePicker value={employeeId} onChange={(id) => setEmp(id)} valueLabel={u?.employee?.employeeNo} />
        </Field>
        <Field name="roleCodes" label={t('users.roles')} required>
          <div className="grid gap-2 sm:grid-cols-2">
            {roles.map((r) => (
              <Checkbox
                key={r.code}
                label={r.name}
                disabled={r.code === 'SUPER_ADMIN' && !canGrantSuper}
                checked={codes.includes(r.code)}
                onChange={(e) => setCodes(e.target.checked ? [...codes, r.code] : codes.filter((c) => c !== r.code))}
              />
            ))}
          </div>
        </Field>
        {!isNew && !isSelf && <Checkbox label={t('users.accountActive')} checked={active} onChange={(e) => setActive(e.target.checked)} />}
      </div>
      </FieldErrors>
    </Dialog>
  );
}
