import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Lock, Plus, Trash2 } from 'lucide-react';
import { api } from '@/lib/api';
import { useApiMutation, useGet } from '@/lib/hooks';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Field, FormGrid, Input, Select } from '@/components/ui/form';
import { Alert, Badge, Card, PageHeader, Spinner } from '@/components/ui/display';
import { Dialog, useConfirm } from '@/components/ui/dialog';
import { Shield as PageIcon } from 'lucide-react';

interface Role {
  id: string;
  code: string;
  name: string;
  description: string | null;
  isSystem: boolean;
  dataScope: string;
  permissions: string[];
  _count: { users: number };
}
interface Perm {
  code: string;
  module: string;
  description: string;
}

const SCOPES = ['SELF', 'TEAM', 'DEPARTMENT', 'BRANCH', 'COMPANY', 'ALL'];

export default function Roles() {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const { data: roles, isLoading } = useGet<Role[]>('/roles');
  const { data: perms = [] } = useGet<Perm[]>('/roles/permissions');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Role | null>(null);
  const [creating, setCreating] = useState(false);
  const selected = roles?.find((r) => r.id === selectedId) ?? roles?.[0];
  if (selected && draft?.id !== selected.id) setDraft({ ...selected });
  const modules = useMemo(() => {
    const m = new Map<string, Perm[]>();
    for (const p of perms) m.set(p.module, [...(m.get(p.module) ?? []), p]);
    return [...m.entries()];
  }, [perms]);
  const save = useApiMutation(() => api.put(`/roles/${draft!.id}`, { name: draft!.name, description: draft!.description, dataScope: draft!.dataScope, permissions: draft!.permissions }), { invalidate: ['/roles'] });
  const remove = useApiMutation((id: string) => api.delete(`/roles/${id}`), { success: t('common.deleted'), invalidate: ['/roles'], onSuccess: () => setSelectedId(null) });
  if (isLoading || !draft) return <Spinner />;
  const locked = draft.code === 'SUPER_ADMIN';
  const toggle = (code: string, on: boolean) => setDraft({ ...draft, permissions: on ? [...draft.permissions, code] : draft.permissions.filter((p) => p !== code) });
  const dirty = JSON.stringify([...draft.permissions].sort()) !== JSON.stringify([...(selected?.permissions ?? [])].sort()) || draft.dataScope !== selected?.dataScope || draft.name !== selected?.name;

  return (
    <div>
      <PageHeader icon={<PageIcon />}
        title={t('nav.roles')}
        subtitle={t('roles.subtitle')}
        actions={
          <Button variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => setCreating(true)}>
            {t('roles.add')}
          </Button>
        }
      />
      <div className="grid gap-6 lg:grid-cols-[18rem_1fr]">
        <Card padded={false} className="p-2 h-fit">
          <ul>
            {roles?.map((r) => (
              <li key={r.id}>
                <button onClick={() => setSelectedId(r.id)} className={cn('flex w-full items-center justify-between rounded-lg px-3 py-2 text-start text-sm', r.id === draft.id ? 'bg-primary-soft text-primary-ink' : 'hover:bg-subtle')}>
                  <span>
                    <span className="block font-medium">{r.name}</span>
                    <span className="block text-xs text-ink-3">{t('roles.usersCount', { count: r._count.users })}</span>
                  </span>
                  {r.isSystem && <Lock className="h-3.5 w-3.5 text-ink-3" aria-label={t('roles.system')} />}
                </button>
              </li>
            ))}
          </ul>
        </Card>
        <Card>
          {locked && <div className="mb-4"><Alert tone="info">{t('roles.superAdminLocked')}</Alert></div>}
          <FormGrid cols={3}>
            <Field label={t('common.name')}>
              <Input value={draft.name} disabled={locked} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
            </Field>
            <Field label={t('org.code')}>
              <Input value={draft.code} disabled />
            </Field>
            <Field label={t('roles.dataScope')} hint={t(`roles.scopeHint.${draft.dataScope}`)}>
              <Select value={draft.dataScope} disabled={locked} onChange={(e) => setDraft({ ...draft, dataScope: e.target.value })}>
                {SCOPES.map((s) => (
                  <option key={s} value={s}>
                    {t(`roles.scope.${s}`)}
                  </option>
                ))}
              </Select>
            </Field>
          </FormGrid>
          <div className="mt-6 grid gap-6 md:grid-cols-2">
            {modules.map(([mod, list]) => (
              <fieldset key={mod} className="rounded-lg border border-line p-4">
                <legend className="px-1 text-sm font-semibold">{t(`roles.module.${mod}`, mod)}</legend>
                <div className="space-y-2">
                  {list.map((p) => (
                    <label key={p.code} className="flex items-start gap-2 text-sm">
                      <input type="checkbox" className="mt-0.5 accent-[rgb(var(--primary))]" disabled={locked} checked={draft.permissions.includes(p.code)} onChange={(e) => toggle(p.code, e.target.checked)} />
                      <span>
                        <span className="block">{t(`perm.${p.code}`, p.description)}</span>
                        <span className="font-mono text-[11px] text-ink-3">{p.code}</span>
                      </span>
                    </label>
                  ))}
                </div>
              </fieldset>
            ))}
          </div>
          {!locked && (
            <div className="mt-6 flex justify-between">
              {!draft.isSystem ? (
                <Button variant="ghost" icon={<Trash2 className="h-4 w-4 text-danger" />} onClick={async () => (await confirm({ title: t('roles.deleteTitle'), message: draft.name, tone: 'danger', confirmLabel: t('common.delete') })) && remove.mutate(draft.id)}>
                  {t('common.delete')}
                </Button>
              ) : (
                <Badge>{t('roles.system')}</Badge>
              )}
              <Button variant="primary" disabled={!dirty} loading={save.isPending} onClick={() => save.mutate(undefined)}>
                {t('common.save')}
              </Button>
            </div>
          )}
        </Card>
      </div>
      <NewRole open={creating} onClose={() => setCreating(false)} onCreated={setSelectedId} />
    </div>
  );
}

function NewRole({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (id: string) => void }) {
  const { t } = useTranslation();
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [scope, setScope] = useState('SELF');
  const save = useApiMutation(() => api.post<{ id: string }>('/roles', { code, name, dataScope: scope, permissions: ['attendance.self', 'leave.request', 'payslip.self', 'approval.act', 'org.read'] }), { invalidate: ['/roles'], onSuccess: (r) => (onCreated(r.id), onClose()) });
  return (
    <Dialog open={open} onClose={onClose} title={t('roles.add')} footer={<><Button onClick={onClose}>{t('common.cancel')}</Button><Button variant="primary" disabled={code.length < 2 || !name} loading={save.isPending} onClick={() => save.mutate(undefined)}>{t('common.create')}</Button></>}>
      <FormGrid>
        <Field label={t('org.code')} required hint={t('payComponent.codeHint')}>
          <Input value={code} onChange={(e) => setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, ''))} />
        </Field>
        <Field label={t('common.name')} required>
          <Input value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label={t('roles.dataScope')}>
          <Select value={scope} onChange={(e) => setScope(e.target.value)}>
            {SCOPES.map((s) => (
              <option key={s} value={s}>
                {t(`roles.scope.${s}`)}
              </option>
            ))}
          </Select>
        </Field>
      </FormGrid>
      <p className="mt-3 text-xs text-ink-3">{t('roles.newHint')}</p>
    </Dialog>
  );
}
