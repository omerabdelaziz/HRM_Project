import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, Check, CircleDot, ExternalLink, X } from 'lucide-react';
import { api } from '@/lib/api';
import { toast } from '@/lib/toast';
import { useApiMutation, useGet } from '@/lib/hooks';
import { personName } from '@/lib/i18n';
import { fmtDate, fmtDateTime, fmtMoney, fmtNumber, fmtTime } from '@/lib/format';
import type { ApprovalRequest } from '@/lib/types';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Field, Textarea } from '@/components/ui/form';
import { Badge, Card, CardHeader, DescriptionList, ErrorState, Spinner, StatusBadge, Alert } from '@/components/ui/display';

interface Detail extends ApprovalRequest {
  canAct: boolean;
  definition: null | { name: string; steps: { order: number; name: string; approverType: string; roleCode: string | null; minAmount: string | null }[] };
  actions: { id: string; stepOrder: number; decision: string; comment: string | null; createdAt: string; actor: { displayName: string } | null }[];
  tasks: { id: string; stepOrder: number; status: string; assignee: { displayName: string } }[];
}

const DATE_KEYS = ['startDate', 'endDate', 'date', 'effectiveFrom'];
const TIME_KEYS = ['currentCheckIn', 'currentCheckOut', 'requestedCheckIn', 'requestedCheckOut'];
const MONEY_KEYS = ['previousBasic', 'newBasic', 'totalGross', 'totalNet'];

function linkFor(r: Detail) {
  switch (r.requestType) {
    case 'LEAVE':
      return r.employee ? `/employees/${r.employee.id}?tab=leave` : '/leave';
    case 'ATTENDANCE_CORRECTION':
    case 'OVERTIME':
      return r.employee ? `/employees/${r.employee.id}?tab=attendance` : '/attendance';
    case 'SALARY_CHANGE':
      return r.employee ? `/employees/${r.employee.id}?tab=salary` : null;
    case 'PAYROLL':
      return `/payroll/runs/${r.entityId.split('#')[0]}`;
    default:
      return null;
  }
}

export default function ApprovalDetail() {
  const { id } = useParams();
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [comment, setComment] = useState('');
  const { data: r, isLoading, error, refetch } = useGet<Detail>(`/approvals/requests/${id}`);
  const decide = useApiMutation((d: 'approve' | 'reject') => api.post(`/approvals/requests/${id}/${d}`, { comment: comment || undefined }), {
    success: '',
    invalidate: ['/approvals', '/leave', '/attendance', '/payroll', '/employees'],
    onSuccess: (_r, d) => {
      toast.success(d === 'approve' ? t('approvals.approvedToast') : t('approvals.rejectedToast'), t('approvals.decisionRecorded'));
      setComment('');
      void refetch();
    },
  });
  if (isLoading) return <Spinner />;
  if (error || !r) return <ErrorState error={error} />;
  const summary = (r.summary ?? {}) as Record<string, unknown>;
  const currency = summary.currency as string | undefined;
  const fmtVal = (k: string, v: unknown) => {
    if (v === null || v === undefined || v === '') return '—';
    if (DATE_KEYS.includes(k)) return fmtDate(String(v));
    if (TIME_KEYS.includes(k)) return fmtTime(String(v));
    if (MONEY_KEYS.includes(k)) return fmtMoney(Number(v), currency);
    if (Array.isArray(v)) return v.length ? v.join('; ') : '—';
    if (typeof v === 'number') return fmtNumber(v, v % 1 ? 2 : 0);
    return String(v);
  };
  const steps = r.definition?.steps ?? [];
  const link = linkFor(r);

  return (
    <div className="space-y-6">
      <button onClick={() => navigate(-1)} className="inline-flex items-center gap-1 text-sm text-ink-3 hover:text-ink">
        <ArrowLeft className="h-4 w-4 rtl:rotate-180" /> {t('common.back')}
      </button>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone="primary">{t(`requestType.${r.requestType}`)}</Badge>
            <StatusBadge status={r.status} />
          </div>
          <h1 className="mt-2 text-xl font-semibold">{r.title}</h1>
          <p className="text-sm text-ink-3">{t('approvals.submittedBy', { name: r.requester.displayName, date: fmtDateTime(r.createdAt) })}</p>
        </div>
        {link && (
          <Link to={link}>
            <Button icon={<ExternalLink className="h-4 w-4" />}>{t('approvals.openRecord')}</Button>
          </Link>
        )}
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <Card>
            <CardHeader title={t('approvals.details')} />
            <DescriptionList
              items={[
                ...(r.employee ? ([[t('common.employee'), <Link className="text-primary-ink hover:underline" to={`/employees/${r.employee.id}`}>{`${personName(r.employee)} · ${r.employee.employeeNo}`}</Link>]] as [string, React.ReactNode][]) : []),
                ...Object.entries(summary)
                  .filter(([k]) => !['runId', 'currency'].includes(k))
                  .map(([k, v]) => [t(`approvals.fields.${k}`, k), fmtVal(k, v)] as [string, React.ReactNode]),
              ]}
            />
            {Array.isArray(summary.warnings) && summary.warnings.length > 0 && (
              <div className="mt-4">
                <Alert tone="warning">{(summary.warnings as string[]).join(' ')}</Alert>
              </div>
            )}
          </Card>
          {r.canAct && (
            <Card>
              <CardHeader title={t('approvals.yourDecision')} />
              <Field label={t('approvals.comment')} hint={t('approvals.commentHint')}>
                <Textarea value={comment} onChange={(e) => setComment(e.target.value)} />
              </Field>
              <div className="mt-4 flex justify-end gap-2">
                <Button variant="danger" icon={<X className="h-4 w-4" />} disabled={comment.trim().length < 3} loading={decide.isPending && decide.variables === 'reject'} onClick={() => decide.mutate('reject')}>
                  {t('approvals.reject')}
                </Button>
                <Button variant="success" icon={<Check className="h-4 w-4" />} loading={decide.isPending && decide.variables === 'approve'} onClick={() => decide.mutate('approve')}>
                  {t('approvals.approve')}
                </Button>
              </div>
            </Card>
          )}
        </div>
        <Card>
          <CardHeader title={t('approvals.workflow')} subtitle={r.definition?.name ?? t('approvals.noWorkflow')} />
          {steps.length > 0 && (
            <ol className="mb-6 space-y-2">
              {steps.map((s) => {
                const done = r.actions.some((a) => a.stepOrder === s.order && a.decision === 'APPROVED');
                const skipped = r.actions.some((a) => a.stepOrder === s.order && a.decision === 'SKIPPED');
                const current = r.status === 'PENDING' && r.currentStep === s.order;
                const assignees = r.tasks.filter((x) => x.stepOrder === s.order).map((x) => x.assignee.displayName);
                return (
                  <li key={s.order} className={cn('flex gap-3 rounded-lg border p-3', current ? 'border-warning/50 bg-warning-soft/50' : 'border-line')}>
                    <span className={cn('mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold', done ? 'bg-success text-white' : current ? 'bg-warning text-white' : 'bg-subtle text-ink-3')}>{done ? <Check className="h-3 w-3" /> : s.order}</span>
                    <div className="min-w-0 text-sm">
                      <p className="font-medium">{s.name}</p>
                      <p className="text-xs text-ink-3">
                        {t(`workflow.approver.${s.approverType}`)}
                        {s.roleCode ? ` · ${s.roleCode}` : ''}
                        {skipped ? ` · ${t('approvals.skipped')}` : ''}
                      </p>
                      {assignees.length > 0 && <p className="text-xs text-ink-2">{assignees.join(', ')}</p>}
                    </div>
                  </li>
                );
              })}
            </ol>
          )}
          <h3 className="mb-3 text-sm font-semibold">{t('approvals.history')}</h3>
          <ol className="relative space-y-4 border-s border-line ps-5">
            {r.actions.map((a) => (
              <li key={a.id} className="relative text-sm">
                <CircleDot className={cn('absolute -start-[1.6rem] top-0.5 h-4 w-4 bg-surface', a.decision === 'APPROVED' ? 'text-success' : a.decision === 'REJECTED' ? 'text-danger' : 'text-ink-3')} aria-hidden />
                <p>
                  <span className="font-medium">{t(`approvals.decision.${a.decision}`)}</span>
                  {a.actor && <span className="text-ink-2"> · {a.actor.displayName}</span>}
                </p>
                <p className="text-xs text-ink-3">{fmtDateTime(a.createdAt)}</p>
                {a.comment && <p className="mt-1 rounded-lg bg-subtle px-3 py-2 text-ink-2">{a.comment}</p>}
              </li>
            ))}
          </ol>
        </Card>
      </div>
    </div>
  );
}
