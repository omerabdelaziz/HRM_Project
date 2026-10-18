import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { CheckCircle2, AlertTriangle } from 'lucide-react';
import { api } from '@/lib/api';
import { useApiMutation, useDebounced, useGet } from '@/lib/hooks';
import { useAuth } from '@/lib/auth';
import { localized } from '@/lib/i18n';
import { fmtNumber } from '@/lib/format';
import { todayIso } from '@/lib/utils';
import { Dialog } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Checkbox, Field, FormGrid, Input, Select, Textarea } from '@/components/ui/form';
import { Alert } from '@/components/ui/display';
import { EmployeePicker } from '@/components/ui/pickers';

export interface LeaveType {
  id: string;
  code: string;
  name: string;
  nameAr: string | null;
  color: string;
  isPaid: boolean;
  allowHalfDay: boolean;
  requiresAttachment: boolean;
  accrualMethod: string;
  annualEntitlement: string;
}

export function LeaveRequestDialog({ open, onClose, onBehalf }: { open: boolean; onClose: () => void; onBehalf?: boolean }) {
  const { t } = useTranslation();
  const { can } = useAuth();
  const { data: types = [] } = useGet<LeaveType[]>('/leave/types');
  const [employeeId, setEmployeeId] = useState<string | null>(null);
  const [leaveTypeId, setLeaveTypeId] = useState('');
  const [startDate, setStart] = useState(todayIso());
  const [endDate, setEnd] = useState(todayIso());
  const [halfDay, setHalfDay] = useState(false);
  const [reason, setReason] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [autoApprove, setAutoApprove] = useState(false);
  const type = types.find((x) => x.id === leaveTypeId);

  const previewArgs = useDebounced({ employeeId: onBehalf ? employeeId : undefined, leaveTypeId, startDate, endDate: halfDay ? startDate : endDate, halfDay });
  const { data: preview, isFetching } = useQuery({
    queryKey: ['/leave/preview', previewArgs],
    queryFn: () => api.get<{ ok: boolean; days?: number; balanceAfter?: number | null; error?: string }>('/leave/preview', { ...previewArgs, employeeId: previewArgs.employeeId ?? undefined }),
    enabled: open && !!leaveTypeId && !!startDate && !!endDate && (!onBehalf || !!employeeId),
  });

  const reset = () => {
    setLeaveTypeId('');
    setReason('');
    setFile(null);
    setHalfDay(false);
    setEmployeeId(null);
    setAutoApprove(false);
  };
  const submit = useApiMutation(
    () => {
      const fd = new FormData();
      if (onBehalf && employeeId) fd.set('employeeId', employeeId);
      fd.set('leaveTypeId', leaveTypeId);
      fd.set('startDate', startDate);
      fd.set('endDate', halfDay ? startDate : endDate);
      fd.set('halfDay', String(halfDay));
      if (reason) fd.set('reason', reason);
      if (autoApprove) fd.set('autoApprove', 'true');
      if (file) fd.set('attachment', file);
      return api.post<{ status: string }>('/leave/requests', fd);
    },
    {
      success: (r) => (r.status === 'APPROVED' ? t('leave.recordedApproved') : t('leave.submitted')),
      invalidate: ['/leave', '/approvals', '/attendance'],
      onSuccess: () => {
        reset();
        onClose();
      },
    },
  );

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={onBehalf ? t('leave.recordForEmployee') : t('leave.newRequest')}
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" loading={submit.isPending} disabled={!leaveTypeId || (onBehalf && !employeeId) || (preview && !preview.ok) || (type?.requiresAttachment && !file)} onClick={() => submit.mutate(undefined)}>
            {t('leave.submit')}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {onBehalf && (
          <Field label={t('common.employee')} required>
            <EmployeePicker value={employeeId} onChange={(id) => setEmployeeId(id)} />
          </Field>
        )}
        <Field label={t('leave.type')} required htmlFor="lt">
          <Select id="lt" value={leaveTypeId} onChange={(e) => setLeaveTypeId(e.target.value)} placeholder={t('leave.chooseType')}>
            {types.map((x) => (
              <option key={x.id} value={x.id}>
                {localized(x as unknown as Record<string, unknown>, 'name')}
                {!x.isPaid ? ` · ${t('leave.unpaid')}` : ''}
              </option>
            ))}
          </Select>
        </Field>
        <FormGrid>
          <Field label={t('leave.from')} required htmlFor="ls">
            <Input id="ls" type="date" value={startDate} onChange={(e) => (setStart(e.target.value), e.target.value > endDate && setEnd(e.target.value))} />
          </Field>
          <Field label={t('leave.to')} required htmlFor="le">
            <Input id="le" type="date" value={halfDay ? startDate : endDate} min={startDate} disabled={halfDay} onChange={(e) => setEnd(e.target.value)} />
          </Field>
        </FormGrid>
        {type?.allowHalfDay !== false && <Checkbox label={t('leave.halfDay')} checked={halfDay} onChange={(e) => setHalfDay(e.target.checked)} />}
        {leaveTypeId && preview && (
          <Alert tone={preview.ok ? 'success' : 'danger'} icon={preview.ok ? <CheckCircle2 className="h-4 w-4" /> : <AlertTriangle className="h-4 w-4" />}>
            {preview.ok
              ? `${t('leave.daysCounted', { days: fmtNumber(preview.days, preview.days! % 1 ? 1 : 0) })}${preview.balanceAfter !== null && preview.balanceAfter !== undefined ? ` · ${t('leave.balanceAfter', { days: fmtNumber(preview.balanceAfter, 1) })}` : ''}`
              : preview.error}
          </Alert>
        )}
        {isFetching && !preview && <p className="text-xs text-ink-3">{t('common.checking')}</p>}
        <Field label={t('leave.reason')} htmlFor="lr">
          <Textarea id="lr" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={1000} />
        </Field>
        <Field label={t('leave.attachment')} required={type?.requiresAttachment} hint={t('leave.attachmentHint')}>
          <input type="file" accept=".pdf,.png,.jpg,.jpeg,.webp" onChange={(e) => setFile(e.target.files?.[0] ?? null)} className="block w-full text-sm text-ink-2 file:me-3 file:rounded-lg file:border-0 file:bg-subtle file:px-3 file:py-2 file:text-sm file:font-medium" />
        </Field>
        {onBehalf && can('leave.manage') && <Checkbox label={t('leave.autoApprove')} checked={autoApprove} onChange={(e) => setAutoApprove(e.target.checked)} />}
      </div>
    </Dialog>
  );
}
