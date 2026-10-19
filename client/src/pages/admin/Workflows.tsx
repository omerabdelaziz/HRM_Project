import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowDown, ArrowUp, Pencil, Plus, Trash2 } from 'lucide-react';
import { api } from '@/lib/api';
import { useApiMutation, useGet } from '@/lib/hooks';
import { useAuth } from '@/lib/auth';
import { Button } from '@/components/ui/button';
import { Checkbox, Field, FormGrid, Input, Select } from '@/components/ui/form';
import { Alert, Badge, Card, CardHeader, EmptyState, PageHeader, Spinner } from '@/components/ui/display';
import { Dialog, useConfirm } from '@/components/ui/dialog';
import { EmployeePicker } from '@/components/ui/pickers';
import { REQUEST_TYPES } from '../approvals/Approvals';
import { Workflow as PageIcon } from 'lucide-react';

const APPROVERS = ['DIRECT_MANAGER', 'MANAGERS_MANAGER', 'DEPARTMENT_MANAGER', 'BRANCH_MANAGER', 'ROLE', 'USER'];

interface Coverage {
  requestType: string;
  workflows: number;
  fullyCovered: boolean;
  otherwise: 'AUTO_APPROVE' | 'FALLBACK';
  fallbackRole: string;
}

interface Step {
  name: string;
  approverType: string;
  roleCode?: string | null;
  userId?: string | null;
  minAmount?: string | number | null;
  escalateAfterHours?: number | null;
  escalateToType?: string | null;
  escalateToRoleCode?: string | null;
  escalateToUserId?: string | null;
  allowSelfApproval?: boolean;
}
interface Definition {
  id: string;
  requestType: string;
  name: string;
  isActive: boolean;
  priority: number;
  conditions: { minAmount?: number; maxAmount?: number; leaveTypeCodes?: string[] } | null;
  steps: (Step & { order: number })[];
}

export default function Workflows() {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const [editing, setEditing] = useState<Partial<Definition> | null>(null);
  const { data, isLoading } = useGet<Definition[]>('/workflows');
  const { data: coverage } = useGet<Coverage[]>('/workflows/coverage');
  const { data: roles = [] } = useGet<{ code: string; name: string }[]>('/roles');
  const roleName = (code: string) => roles.find((r) => r.code === code)?.name ?? code;
  const deactivate = useApiMutation((id: string) => api.delete(`/workflows/${id}`), { success: t('workflow.deactivated'), invalidate: ['/workflows'] });
  if (isLoading) return <Spinner />;
  return (
    <div>
      <PageHeader icon={<PageIcon />}
        title={t('nav.workflows')}
        subtitle={t('workflow.subtitle')}
        actions={
          <Button variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => setEditing({ requestType: 'LEAVE', name: '', isActive: true, priority: 0, steps: [{ order: 1, name: t('workflow.lineManager'), approverType: 'DIRECT_MANAGER' }] })}>
            {t('workflow.add')}
          </Button>
        }
      />
      <WorkflowSettings roles={roles} />
      <div className="grid gap-4 lg:grid-cols-2">
        {REQUEST_TYPES.map((type) => {
          const defs = data?.filter((d) => d.requestType === type) ?? [];
          const cov = coverage?.find((c) => c.requestType === type);
          const otherwise = cov?.otherwise === 'AUTO_APPROVE' ? t('workflow.otherwiseAuto') : t('workflow.otherwiseFallback', { role: roleName(cov?.fallbackRole ?? 'HR_ADMIN') });
          return (
            <Card key={type}>
              <CardHeader title={t(`requestType.${type}`)} subtitle={defs.length ? undefined : t('workflow.noneConfigured')} />
              {cov && cov.workflows > 0 && !cov.fullyCovered && (
                <div className="mb-3">
                  <Alert tone={cov.otherwise === 'AUTO_APPROVE' ? 'warning' : 'info'}>{t('workflow.partialCoverage', { otherwise })}</Alert>
                </div>
              )}
              {defs.length === 0 ? (
                cov?.otherwise === 'AUTO_APPROVE' ? <Alert tone="warning">{t('workflow.autoApprovedWarning')}</Alert> : <EmptyState title={otherwise} />
              ) : (
                <div className="space-y-3">
                  {defs.map((d) => (
                    <div key={d.id} className="rounded-lg border border-line p-3">
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-medium">{d.name}</span>
                          {!d.isActive && <Badge>{t('common.inactive')}</Badge>}
                          {d.conditions && <Badge tone="info">{t('workflow.conditional')}</Badge>}
                        </div>
                        <div className="flex gap-1">
                          <Button size="icon" variant="ghost" aria-label={t('common.edit')} icon={<Pencil className="h-4 w-4" />} onClick={() => setEditing(d)} />
                          {d.isActive && <Button size="icon" variant="ghost" aria-label={t('workflow.deactivate')} icon={<Trash2 className="h-4 w-4 text-danger" />} onClick={async () => (await confirm({ title: t('workflow.deactivateTitle'), message: d.name, tone: 'danger' })) && deactivate.mutate(d.id)} />}
                        </div>
                      </div>
                      <ol className="mt-2 flex flex-wrap items-center gap-1.5 text-xs">
                        {d.steps.map((s, i) => (
                          <li key={s.order} className="flex items-center gap-1.5">
                            <span className="rounded-full bg-subtle px-2 py-1">
                              {s.order}. {s.name}
                              {s.minAmount ? ` (≥ ${s.minAmount})` : ''}
                            </span>
                            {i < d.steps.length - 1 && <span className="text-ink-3 rtl:rotate-180">→</span>}
                          </li>
                        ))}
                      </ol>
                    </div>
                  ))}
                </div>
              )}
            </Card>
          );
        })}
      </div>
      <WorkflowDialog def={editing} onClose={() => setEditing(null)} />
    </div>
  );
}

/** Where requests go when no workflow applies: the fallback approver role, or (per type, opt-in) automatic approval. */
function WorkflowSettings({ roles }: { roles: { code: string; name: string }[] }) {
  const { t } = useTranslation();
  const { can } = useAuth();
  const { data } = useGet<{ workflowFallbackRole: string; autoApproveRequestTypes: string[] }>('/workflows/settings');
  const [role, setRole] = useState('HR_ADMIN');
  const [auto, setAuto] = useState<string[]>([]);
  useEffect(() => {
    if (data) {
      setRole(data.workflowFallbackRole);
      setAuto(data.autoApproveRequestTypes);
    }
  }, [data]);
  const save = useApiMutation(() => api.put('/workflows/settings', { workflowFallbackRole: role, autoApproveRequestTypes: auto }), { success: t('common.saved'), invalidate: ['/workflows'] });
  const editable = can('workflow.manage');
  return (
    <Card className="mb-4">
      <CardHeader title={t('workflow.noWorkflowTitle')} subtitle={t('workflow.noWorkflowHint')} />
      <FormGrid cols={2}>
        <Field label={t('workflow.fallbackRole')} hint={t('workflow.fallbackRoleHint')}>
          <Select value={role} disabled={!editable} onChange={(e) => setRole(e.target.value)}>
            {roles.map((r) => (
              <option key={r.code} value={r.code}>
                {r.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t('workflow.autoApproveTypes')} hint={t('workflow.autoApproveTypesHint')}>
          <div className="grid grid-cols-2 gap-x-4 gap-y-1.5">
            {REQUEST_TYPES.map((x) => (
              <Checkbox key={x} label={t(`requestType.${x}`)} disabled={!editable} checked={auto.includes(x)} onChange={(e) => setAuto(e.target.checked ? [...auto, x] : auto.filter((y) => y !== x))} />
            ))}
          </div>
        </Field>
      </FormGrid>
      {auto.length > 0 && (
        <div className="mt-3">
          <Alert tone="warning">{t('workflow.autoApproveRisk')}</Alert>
        </div>
      )}
      {editable && (
        <div className="mt-4 flex justify-end">
          <Button variant="primary" loading={save.isPending} onClick={() => save.mutate(undefined)}>
            {t('common.save')}
          </Button>
        </div>
      )}
    </Card>
  );
}

function WorkflowDialog({ def, onClose }: { def: Partial<Definition> | null; onClose: () => void }) {
  const { t } = useTranslation();
  const { data: roles = [] } = useGet<{ code: string; name: string }[]>(def ? '/roles' : null);
  const [d, setD] = useState<Partial<Definition>>({});
  const [last, setLast] = useState<Partial<Definition> | null>(null);
  const [leaveCodes, setLeaveCodes] = useState('');
  if (def !== last) {
    setLast(def);
    setD(def ?? {});
    setLeaveCodes(def?.conditions?.leaveTypeCodes?.join(', ') ?? '');
  }
  const steps = d.steps ?? [];
  const setStep = (i: number, patch: Partial<Step>) => setD({ ...d, steps: steps.map((s, j) => (j === i ? { ...s, ...patch } : s)) });
  const move = (i: number, dir: -1 | 1) => {
    const next = [...steps];
    [next[i], next[i + dir]] = [next[i + dir], next[i]];
    setD({ ...d, steps: next });
  };
  const save = useApiMutation(
    () => {
      const codes = leaveCodes.split(',').map((x) => x.trim().toUpperCase()).filter(Boolean);
      const cond = { ...(d.conditions?.minAmount != null && String(d.conditions.minAmount) !== '' ? { minAmount: Number(d.conditions.minAmount) } : {}), ...(d.conditions?.maxAmount != null && String(d.conditions.maxAmount) !== '' ? { maxAmount: Number(d.conditions.maxAmount) } : {}), ...(codes.length ? { leaveTypeCodes: codes } : {}) };
      const body = {
        requestType: d.requestType,
        name: d.name,
        isActive: d.isActive !== false,
        priority: Number(d.priority ?? 0),
        conditions: Object.keys(cond).length ? cond : null,
        steps: steps.map((s) => ({
          name: s.name,
          approverType: s.approverType,
          roleCode: s.approverType === 'ROLE' ? s.roleCode : null,
          userId: s.approverType === 'USER' ? s.userId : null,
          minAmount: s.minAmount === '' || s.minAmount == null ? null : Number(s.minAmount),
          escalateAfterHours: s.escalateAfterHours ? Number(s.escalateAfterHours) : null,
          escalateToType: s.escalateAfterHours ? s.escalateToType ?? 'MANAGERS_MANAGER' : null,
          escalateToRoleCode: s.escalateAfterHours && s.escalateToType === 'ROLE' ? s.escalateToRoleCode : null,
          escalateToUserId: s.escalateAfterHours && s.escalateToType === 'USER' ? s.escalateToUserId : null,
          allowSelfApproval: !!s.allowSelfApproval,
        })),
      };
      return d.id ? api.put(`/workflows/${d.id}`, body) : api.post('/workflows', body);
    },
    { invalidate: ['/workflows'], onSuccess: onClose },
  );
  return (
    <Dialog open={!!def} onClose={onClose} size="xl" title={d.id ? t('workflow.edit') : t('workflow.add')} footer={<><Button onClick={onClose}>{t('common.cancel')}</Button><Button variant="primary" disabled={!d.name || !steps.length} loading={save.isPending} onClick={() => save.mutate(undefined)}>{t('common.save')}</Button></>}>
      <div className="space-y-6">
        <FormGrid cols={3}>
          <Field label={t('approvals.type')}>
            <Select value={d.requestType} onChange={(e) => setD({ ...d, requestType: e.target.value })}>
              {REQUEST_TYPES.map((x) => (
                <option key={x} value={x}>
                  {t(`requestType.${x}`)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t('common.name')} required>
            <Input value={d.name ?? ''} onChange={(e) => setD({ ...d, name: e.target.value })} />
          </Field>
          <Field label={t('workflow.priority')} hint={t('workflow.priorityHint')}>
            <Input type="number" value={d.priority ?? 0} onChange={(e) => setD({ ...d, priority: Number(e.target.value) })} />
          </Field>
        </FormGrid>
        <fieldset className="rounded-lg border border-line p-4">
          <legend className="px-1 text-sm font-semibold">{t('workflow.conditions')}</legend>
          <FormGrid cols={3}>
            <Field label={t('workflow.minAmount')} hint={t('workflow.amountHint')}>
              <Input type="number" value={d.conditions?.minAmount ?? ''} onChange={(e) => setD({ ...d, conditions: { ...d.conditions, minAmount: e.target.value as unknown as number } })} />
            </Field>
            <Field label={t('workflow.maxAmount')}>
              <Input type="number" value={d.conditions?.maxAmount ?? ''} onChange={(e) => setD({ ...d, conditions: { ...d.conditions, maxAmount: e.target.value as unknown as number } })} />
            </Field>
            {d.requestType === 'LEAVE' && (
              <Field label={t('workflow.leaveCodes')} hint={t('payComponent.commaList')}>
                <Input value={leaveCodes} onChange={(e) => setLeaveCodes(e.target.value)} placeholder="ANNUAL, SICK" />
              </Field>
            )}
          </FormGrid>
        </fieldset>
        <div>
          <div className="mb-3 flex items-center justify-between">
            <h3 className="text-sm font-semibold">{t('workflow.steps')}</h3>
            <Button size="sm" variant="ghost" icon={<Plus className="h-4 w-4" />} onClick={() => setD({ ...d, steps: [...steps, { order: steps.length + 1, name: '', approverType: 'ROLE', roleCode: 'HR_MANAGER' }] })}>
              {t('workflow.addStep')}
            </Button>
          </div>
          <div className="space-y-3">
            {steps.map((s, i) => (
              <div key={i} className="rounded-lg border border-line p-4">
                <div className="mb-3 flex items-center justify-between">
                  <span className="text-sm font-semibold">{t('workflow.stepN', { n: i + 1 })}</span>
                  <div className="flex gap-1">
                    <Button size="icon" variant="ghost" disabled={i === 0} aria-label={t('workflow.moveUp')} icon={<ArrowUp className="h-4 w-4" />} onClick={() => move(i, -1)} />
                    <Button size="icon" variant="ghost" disabled={i === steps.length - 1} aria-label={t('workflow.moveDown')} icon={<ArrowDown className="h-4 w-4" />} onClick={() => move(i, 1)} />
                    <Button size="icon" variant="ghost" aria-label={t('common.remove')} icon={<Trash2 className="h-4 w-4 text-danger" />} onClick={() => setD({ ...d, steps: steps.filter((_, j) => j !== i) })} />
                  </div>
                </div>
                <FormGrid cols={3}>
                  <Field label={t('common.name')} required>
                    <Input value={s.name} onChange={(e) => setStep(i, { name: e.target.value })} />
                  </Field>
                  <Field label={t('workflow.approverLabel')}>
                    <Select value={s.approverType} onChange={(e) => setStep(i, { approverType: e.target.value })}>
                      {APPROVERS.map((a) => (
                        <option key={a} value={a}>
                          {t(`workflow.approver.${a}`)}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  {s.approverType === 'ROLE' && (
                    <Field label={t('workflow.role')}>
                      <Select value={s.roleCode ?? ''} onChange={(e) => setStep(i, { roleCode: e.target.value })}>
                        {roles.map((r) => (
                          <option key={r.code} value={r.code}>
                            {r.name}
                          </option>
                        ))}
                      </Select>
                    </Field>
                  )}
                  {s.approverType === 'USER' && (
                    <Field label={t('workflow.user')}>
                      <EmployeePicker value={null} onChange={(_, emp) => setStep(i, { userId: emp?.user?.id ?? null })} valueLabel={s.userId ? t('common.selected') : undefined} />
                    </Field>
                  )}
                  <Field label={t('workflow.stepMinAmount')} hint={t('workflow.stepMinAmountHint')}>
                    <Input type="number" value={s.minAmount ?? ''} onChange={(e) => setStep(i, { minAmount: e.target.value })} />
                  </Field>
                  <Field label={t('workflow.escalateAfter')} hint={t('workflow.escalateHint')}>
                    <Input type="number" min={1} value={s.escalateAfterHours ?? ''} onChange={(e) => setStep(i, { escalateAfterHours: e.target.value ? Number(e.target.value) : null })} />
                  </Field>
                  {!!s.escalateAfterHours && (
                    <Field label={t('workflow.escalateTo')}>
                      <Select value={s.escalateToType ?? 'MANAGERS_MANAGER'} onChange={(e) => setStep(i, { escalateToType: e.target.value })}>
                        {APPROVERS.map((a) => (
                          <option key={a} value={a}>
                            {t(`workflow.approver.${a}`)}
                          </option>
                        ))}
                      </Select>
                    </Field>
                  )}
                  {s.escalateToType === 'ROLE' && !!s.escalateAfterHours && (
                    <Field label={t('workflow.escalateRole')}>
                      <Select value={s.escalateToRoleCode ?? ''} onChange={(e) => setStep(i, { escalateToRoleCode: e.target.value })} placeholder="—">
                        {roles.map((r) => (
                          <option key={r.code} value={r.code}>
                            {r.name}
                          </option>
                        ))}
                      </Select>
                    </Field>
                  )}
                  {s.escalateToType === 'USER' && !!s.escalateAfterHours && (
                    <Field label={t('workflow.escalateUser')}>
                      <EmployeePicker value={null} onChange={(_, emp) => setStep(i, { escalateToUserId: emp?.user?.id ?? null })} valueLabel={s.escalateToUserId ? t('common.selected') : undefined} />
                    </Field>
                  )}
                </FormGrid>
                <Checkbox className="mt-3" label={t('workflow.allowSelf')} checked={!!s.allowSelfApproval} onChange={(e) => setStep(i, { allowSelfApproval: e.target.checked })} />
              </div>
            ))}
          </div>
        </div>
        <Checkbox label={t('common.active')} checked={d.isActive !== false} onChange={(e) => setD({ ...d, isActive: e.target.checked })} />
      </div>
    </Dialog>
  );
}
