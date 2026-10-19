import { useEffect, useState } from 'react';
import { useForm, Controller } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { Copy } from 'lucide-react';
import { toast } from '@/lib/toast';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { errorMessage, useGet } from '@/lib/hooks';
import { useQueryClient } from '@tanstack/react-query';
import { personName, translateMessage } from '@/lib/i18n';
import { ageOn, capitalizeName, emiratesIdProblem, LEGAL_MIN_AGE, normalizePhone, requiresEmiratesId, todayIso } from '@shared/validation';
import type { Employee } from '@/lib/types';
import { Dialog } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Checkbox, Field, FormGrid, FormSection, Input, Select } from '@/components/ui/form';
import { Alert } from '@/components/ui/display';
import { CountryPicker, EmployeePicker, OrgSelect } from '@/components/ui/pickers';

type FormValues = {
  firstName: string;
  lastName: string;
  firstNameAr: string;
  lastNameAr: string;
  email: string;
  personalEmail: string;
  phone: string;
  gender: string;
  dateOfBirth: string;
  nationality: string;
  maritalStatus: string;
  nationalIdType: string;
  nationalId: string;
  pensionScheme: string;
  /** '' = inherit from grade */
  overtimeEligible: '' | 'true' | 'false';
  address: string;
  ecName: string;
  ecRelation: string;
  ecPhone: string;
  branchId: string | null;
  departmentId: string | null;
  positionId: string | null;
  gradeId: string | null;
  categoryId: string | null;
  employmentTypeId: string | null;
  costCenterId: string | null;
  managerId: string | null;
  shiftId: string | null;
  hireDate: string;
  probationEndDate: string;
  contractStartDate: string;
  contractEndDate: string;
  bankName: string;
  bankAccount: string;
  iban: string;
  status: string;
  createUserAccount: boolean;
  changeReason: string;
  effectiveDate: string;
};

const d = (v: string | null | undefined) => (v ? v.slice(0, 10) : '');

function toForm(e?: Employee): FormValues {
  return {
    firstName: e?.firstName ?? '', lastName: e?.lastName ?? '', firstNameAr: e?.firstNameAr ?? '', lastNameAr: e?.lastNameAr ?? '',
    email: e?.email ?? '', personalEmail: e?.personalEmail ?? '', phone: e?.phone ?? '', gender: e?.gender ?? '', dateOfBirth: d(e?.dateOfBirth),
    nationality: e?.nationality ?? '', maritalStatus: e?.maritalStatus ?? '', nationalIdType: e?.nationalIdType ?? '', nationalId: e?.canViewSensitive ? e?.nationalId ?? '' : '', address: e?.address ?? '',
    pensionScheme: e?.pensionScheme ?? '', overtimeEligible: e?.overtimeEligible === true ? 'true' : e?.overtimeEligible === false ? 'false' : '',
    ecName: e?.emergencyContact?.name ?? '', ecRelation: e?.emergencyContact?.relation ?? '', ecPhone: e?.emergencyContact?.phone ?? '',
    branchId: e?.branchId ?? null, departmentId: e?.departmentId ?? null, positionId: e?.positionId ?? null, gradeId: e?.gradeId ?? null,
    categoryId: e?.categoryId ?? null, employmentTypeId: e?.employmentTypeId ?? null, costCenterId: e?.costCenterId ?? null, managerId: e?.managerId ?? null,
    shiftId: e?.shiftId ?? null, hireDate: d(e?.hireDate) || new Date().toISOString().slice(0, 10), probationEndDate: d(e?.probationEndDate),
    contractStartDate: d(e?.contractStartDate), contractEndDate: d(e?.contractEndDate), bankName: e?.bankName ?? '',
    bankAccount: e?.canViewSensitive ? e?.bankAccount ?? '' : '', iban: e?.canViewSensitive ? e?.iban ?? '' : '', status: e?.status ?? '',
    createUserAccount: true, changeReason: '', effectiveDate: '',
  };
}

export function EmployeeFormDialog({ open, onClose, employee, onSaved }: { open: boolean; onClose: () => void; employee?: Employee; onSaved?: (e: Employee) => void }) {
  const { t } = useTranslation();
  const { can } = useAuth();
  const qc = useQueryClient();
  const editing = !!employee;
  const { register, handleSubmit, control, reset, watch, formState } = useForm<FormValues>({ defaultValues: toForm(employee) });
  const [serverErrors, setServerErrors] = useState<Record<string, string>>({});
  const [duplicate, setDuplicate] = useState<{ message: string; confirmable: boolean } | null>(null);
  const [created, setCreated] = useState<Employee | null>(null);
  const { data: shifts = [] } = useGet<{ id: string; name: string }[]>(open ? '/shifts' : null);
  const departmentId = watch('departmentId');
  const nationality = watch('nationality');
  const nationalIdType = watch('nationalIdType');
  const hireDate = watch('hireDate');
  const sensitive = !editing || employee?.canViewSensitive;
  const fixFields = () => toast.error(t('common.fixHighlighted'));

  // Same rules as the API (shared/validation.ts), so every problem shows before submitting.
  const rules = {
    phone: (v: string) => !v || !!normalizePhone(v) || t('validation.phone'),
    dateOfBirth: (v: string) => {
      if (!v) return true;
      if (v > todayIso()) return t('validation.dobFuture');
      return ageOn(v, hireDate || todayIso()) >= LEGAL_MIN_AGE || t('validation.minAge', { n: LEGAL_MIN_AGE });
    },
    nationalId: (v: string) => {
      if (!v || !requiresEmiratesId(nationalIdType || null, nationality || null)) return true;
      const problem = emiratesIdProblem(v);
      return !problem || t(problem);
    },
    pensionScheme: (v: string) => !v || v === 'NONE' || !nationality || nationality === 'AE' || t('validation.pensionNationals'),
  };

  useEffect(() => {
    if (open) {
      reset(toForm(employee));
      setServerErrors({});
      setDuplicate(null);
      setCreated(null);
    }
  }, [open, employee, reset]);

  const submit = async (v: FormValues, confirmDuplicate = false) => {
    setServerErrors({});
    const body: Record<string, unknown> = {
      firstName: capitalizeName(v.firstName), lastName: capitalizeName(v.lastName), firstNameAr: v.firstNameAr || null, lastNameAr: v.lastNameAr || null, email: v.email,
      personalEmail: v.personalEmail || null, phone: v.phone || null, gender: v.gender || null, dateOfBirth: v.dateOfBirth || null,
      nationality: v.nationality || null, maritalStatus: v.maritalStatus || null, address: v.address || null,
      ...(v.pensionScheme ? { pensionScheme: v.pensionScheme } : {}),
      overtimeEligible: v.overtimeEligible === '' ? null : v.overtimeEligible === 'true',
      emergencyContact: v.ecName && v.ecPhone ? { name: v.ecName, relation: v.ecRelation || undefined, phone: v.ecPhone } : null,
      branchId: v.branchId, departmentId: v.departmentId, positionId: v.positionId, gradeId: v.gradeId, categoryId: v.categoryId,
      employmentTypeId: v.employmentTypeId, costCenterId: v.costCenterId, managerId: v.managerId, shiftId: v.shiftId,
      hireDate: v.hireDate, probationEndDate: v.probationEndDate || null, contractStartDate: v.contractStartDate || null, contractEndDate: v.contractEndDate || null,
      bankName: v.bankName || null,
    };
    if (sensitive) Object.assign(body, { nationalIdType: v.nationalIdType || null, nationalId: v.nationalId || null, bankAccount: v.bankAccount || null, iban: v.iban ? v.iban.replace(/\s/g, '').toUpperCase() : null });
    try {
      let saved: Employee;
      if (editing) {
        if (v.status && v.status !== employee!.status) body.status = v.status;
        if (v.changeReason) body.changeReason = v.changeReason;
        if (v.effectiveDate) body.effectiveDate = v.effectiveDate;
        saved = await api.put<Employee>(`/employees/${employee!.id}`, body);
        toast.success(t('employees.updated'));
        onClose();
      } else {
        body.createUserAccount = v.createUserAccount && can('user.manage');
        body.confirmDuplicate = confirmDuplicate;
        saved = await api.post<Employee>('/employees', body);
        toast.success(t('employees.created', { no: saved.employeeNo }));
        if (saved.inviteSent) toast.info(t('users.inviteSent', { email: saved.email }), t('users.inviteSentText'));
        if (saved.temporaryPassword) setCreated(saved);
        else onClose();
      }
      for (const w of saved.warnings ?? []) toast.warning(t(`employees.warning.${w.code}`, { defaultValue: w.message }));
      qc.invalidateQueries({ predicate: (q) => String(q.queryKey[0]).startsWith('/employees') });
      onSaved?.(saved);
    } catch (e) {
      if (e instanceof ApiError) {
        const details = e.details as { confirmable?: boolean; duplicates?: { employeeNo: string; reasons: string[] }[] } | undefined;
        if (e.status === 409) {
          // Friendly, localised labels ("National ID") instead of field names.
          const dup = details?.duplicates?.[0];
          const message = dup
            ? t(details?.confirmable ? 'employees.duplicateSuspect' : 'employees.duplicateExists', {
                fields: dup.reasons.map((r) => t(`employees.duplicateReason.${r}`, { defaultValue: r })).join(t('common.and')),
                no: dup.employeeNo,
              })
            : e.message;
          setDuplicate({ message, confirmable: !!details?.confirmable });
          return;
        }
        const fieldErrors = Object.fromEntries(Object.entries(e.fieldErrors).map(([k, m]) => [k.split('.')[0], translateMessage(m) ?? m]));
        setServerErrors(fieldErrors);
        if (Object.keys(fieldErrors).length) {
          fixFields();
          return;
        }
      }
      toast.error(errorMessage(e));
    }
  };

  if (created) {
    return (
      <Dialog open={open} onClose={onClose} title={t('employees.accountCreated')} size="sm" footer={<Button variant="primary" onClick={onClose}>{t('common.done')}</Button>}>
        <p className="text-sm text-ink-2">{t('employees.tempPasswordText', { name: personName(created), email: created.email })}</p>
        <div className="mt-3 flex items-center gap-2 rounded-lg border border-line bg-subtle p-3 font-mono text-sm">
          <span className="flex-1 select-all">{created.temporaryPassword}</span>
          <Button size="sm" variant="ghost" icon={<Copy className="h-4 w-4" />} onClick={() => (navigator.clipboard.writeText(created.temporaryPassword!), toast.success(t('common.copied')))}>
            {t('common.copy')}
          </Button>
        </div>
        <p className="mt-2 text-xs text-ink-3">{t('employees.tempPasswordOnce')}</p>
      </Dialog>
    );
  }

  const err = (k: keyof FormValues) => serverErrors[k] ?? (formState.errors[k]?.message as string | undefined);
  const req = { required: t('common.required') };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="lg"
      title={editing ? t('employees.edit', { name: personName(employee) }) : t('employees.new')}
      description={editing ? employee!.employeeNo : t('employees.newHint')}
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" loading={formState.isSubmitting} onClick={handleSubmit((v) => submit(v), fixFields)}>
            {editing ? t('common.save') : t('employees.create')}
          </Button>
        </>
      }
    >
      <form className="space-y-8" onSubmit={(e) => e.preventDefault()} noValidate>
        {duplicate && (
          <Alert tone="warning" title={t('employees.possibleDuplicate')}>
            <p>{duplicate.message}</p>
            {duplicate.confirmable && (
              <Button size="sm" className="mt-2" onClick={handleSubmit((v) => submit(v, true), fixFields)}>
                {t('employees.createAnyway')}
              </Button>
            )}
          </Alert>
        )}
        <FormSection title={t('employees.personal')}>
          <FormGrid>
            <Field label={t('employees.firstName')} required error={err('firstName')}>
              <Input {...register('firstName', req)} aria-invalid={!!err('firstName')} />
            </Field>
            <Field label={t('employees.lastName')} required error={err('lastName')}>
              <Input {...register('lastName', req)} aria-invalid={!!err('lastName')} />
            </Field>
            <Field label={t('employees.firstNameAr')}>
              <Input dir="rtl" {...register('firstNameAr')} />
            </Field>
            <Field label={t('employees.lastNameAr')}>
              <Input dir="rtl" {...register('lastNameAr')} />
            </Field>
            <Field label={t('employees.workEmail')} required error={err('email')}>
              <Input type="email" {...register('email', req)} aria-invalid={!!err('email')} />
            </Field>
            <Field label={t('employees.phone')} error={err('phone')} hint={t('employees.phoneHint')}>
              <Input type="tel" dir="ltr" {...register('phone', { validate: rules.phone })} aria-invalid={!!err('phone')} />
            </Field>
            <Field label={t('employees.gender')}>
              <Select {...register('gender')} placeholder={t('common.notSpecified')}>
                <option value="MALE">{t('employees.male')}</option>
                <option value="FEMALE">{t('employees.female')}</option>
              </Select>
            </Field>
            <Field label={t('employees.dateOfBirth')} error={err('dateOfBirth')}>
              <Input type="date" max={todayIso()} {...register('dateOfBirth', { validate: rules.dateOfBirth })} aria-invalid={!!err('dateOfBirth')} />
            </Field>
            <Field label={t('employees.nationality')} error={err('nationality')}>
              <Controller control={control} name="nationality" render={({ field }) => <CountryPicker value={field.value || null} onChange={(c) => field.onChange(c ?? '')} invalid={!!err('nationality')} />} />
            </Field>
            <Field label={t('employees.maritalStatus')}>
              <Select {...register('maritalStatus')} placeholder={t('common.notSpecified')}>
                {['SINGLE', 'MARRIED', 'DIVORCED', 'WIDOWED'].map((s) => (
                  <option key={s} value={s}>
                    {t(`employees.marital.${s}`)}
                  </option>
                ))}
              </Select>
            </Field>
            {sensitive && (
              <>
                <Field label={t('employees.nationalIdType')}>
                  <Select {...register('nationalIdType')} placeholder={t('employees.nationalIdTypeAuto')}>
                    {['EMIRATES_ID', 'PASSPORT', 'OTHER'].map((x) => (
                      <option key={x} value={x}>
                        {t(`employees.idType.${x}`)}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field
                  label={t('employees.nationalId')}
                  error={err('nationalId')}
                  hint={requiresEmiratesId(nationalIdType || null, nationality || null) ? t('employees.emiratesIdHint') : undefined}
                >
                  <Input dir="ltr" {...register('nationalId', { validate: rules.nationalId })} autoComplete="off" aria-invalid={!!err('nationalId')} />
                </Field>
              </>
            )}
            <Field label={t('employees.personalEmail')} error={err('personalEmail')}>
              <Input type="email" {...register('personalEmail')} />
            </Field>
            <Field label={t('employees.address')} className="sm:col-span-2">
              <Input {...register('address')} />
            </Field>
          </FormGrid>
        </FormSection>

        <FormSection title={t('employees.employment')}>
          <FormGrid>
            <Field label={t('common.branch')} required={!editing} error={err('branchId')}>
              <Controller control={control} name="branchId" rules={editing ? undefined : req} render={({ field }) => <OrgSelect entity="branches" value={field.value} onChange={field.onChange} invalid={!!err('branchId')} />} />
            </Field>
            <Field label={t('common.department')} required={!editing} error={err('departmentId')}>
              <Controller control={control} name="departmentId" rules={editing ? undefined : req} render={({ field }) => <OrgSelect entity="departments" value={field.value} onChange={field.onChange} invalid={!!err('departmentId')} />} />
            </Field>
            <Field label={t('common.position')} required={!editing} error={err('positionId')}>
              <Controller control={control} name="positionId" rules={editing ? undefined : req} render={({ field }) => <OrgSelect entity="positions" value={field.value} onChange={field.onChange} filter={departmentId ? { departmentId } : undefined} invalid={!!err('positionId')} />} />
            </Field>
            <Field label={t('employees.grade')}>
              <Controller control={control} name="gradeId" render={({ field }) => <OrgSelect entity="grades" value={field.value} onChange={field.onChange} />} />
            </Field>
            <Field label={t('common.manager')} error={err('managerId')}>
              <Controller
                control={control}
                name="managerId"
                render={({ field }) => (
                  <EmployeePicker value={field.value} onChange={(id) => field.onChange(id)} exclude={employee ? [employee.id] : []} valueLabel={employee?.manager ? personName(employee.manager) : undefined} />
                )}
              />
            </Field>
            <Field label={t('employees.category')}>
              <Controller control={control} name="categoryId" render={({ field }) => <OrgSelect entity="categories" value={field.value} onChange={field.onChange} />} />
            </Field>
            <Field label={t('employees.employmentType')}>
              <Controller control={control} name="employmentTypeId" render={({ field }) => <OrgSelect entity="employment-types" value={field.value} onChange={field.onChange} />} />
            </Field>
            <Field label={t('employees.costCenter')}>
              <Controller control={control} name="costCenterId" render={({ field }) => <OrgSelect entity="cost-centers" value={field.value} onChange={field.onChange} />} />
            </Field>
            <Field label={t('employees.shift')} hint={t('employees.shiftHint')}>
              <Controller
                control={control}
                name="shiftId"
                render={({ field }) => (
                  <Select value={field.value ?? ''} onChange={(e) => field.onChange(e.target.value || null)} placeholder={t('employees.defaultShift')}>
                    {shifts.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </Select>
                )}
              />
            </Field>
            <Field label={t('employees.pensionScheme')} error={err('pensionScheme')} hint={t('employees.pensionSchemeHint')}>
              <Select {...register('pensionScheme', { validate: rules.pensionScheme })} placeholder={editing ? undefined : t('employees.pensionSchemeAuto')} aria-invalid={!!err('pensionScheme')}>
                {['NONE', 'GPSSA_OLD', 'GPSSA_NEW', 'ADPF_OLD', 'ADPF_NEW'].map((x) => (
                  <option key={x} value={x}>
                    {t(`employees.pension.${x}`)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={t('employees.overtimeEligible')}>
              <Select {...register('overtimeEligible')}>
                <option value="">
                  {t('employees.overtimeInherit', { value: employee?.grade ? t(employee.grade.overtimeEligible ? 'common.yes' : 'common.no') : t('common.yes') })}
                </option>
                <option value="true">{t('common.yes')}</option>
                <option value="false">{t('common.no')}</option>
              </Select>
            </Field>
            <Field label={t('employees.hireDate')} required error={err('hireDate')}>
              <Input type="date" {...register('hireDate', req)} />
            </Field>
            <Field label={t('employees.probationEnd')} hint={!editing ? t('employees.probationHint') : undefined}>
              <Input type="date" {...register('probationEndDate')} />
            </Field>
            <Field label={t('employees.contractStart')}>
              <Input type="date" {...register('contractStartDate')} />
            </Field>
            <Field label={t('employees.contractEnd')} error={err('contractEndDate')}>
              <Input type="date" {...register('contractEndDate')} />
            </Field>
            {editing && !['RESIGNED', 'TERMINATED', 'RETIRED'].includes(employee!.status) && (
              <Field label={t('common.status')}>
                <Select {...register('status')}>
                  {['PROBATION', 'ACTIVE', 'SUSPENDED'].map((s) => (
                    <option key={s} value={s}>
                      {t(`status.${s}`)}
                    </option>
                  ))}
                </Select>
              </Field>
            )}
          </FormGrid>
          {editing && (
            <FormGrid>
              <Field label={t('employees.changeReason')} hint={t('employees.changeReasonHint')}>
                <Input {...register('changeReason')} />
              </Field>
              <Field label={t('employees.effectiveDate')}>
                <Input type="date" {...register('effectiveDate')} />
              </Field>
            </FormGrid>
          )}
        </FormSection>

        <FormSection title={t('employees.emergencyContact')}>
          <FormGrid cols={3}>
            <Field label={t('common.name')}>
              <Input {...register('ecName')} />
            </Field>
            <Field label={t('employees.relation')}>
              <Input {...register('ecRelation')} />
            </Field>
            <Field label={t('employees.phone')}>
              <Input type="tel" {...register('ecPhone')} />
            </Field>
          </FormGrid>
        </FormSection>

        <FormSection title={t('employees.bank')} description={sensitive ? t('employees.bankEncrypted') : t('employees.bankHidden')}>
          <FormGrid cols={3}>
            <Field label={t('employees.bankName')}>
              <Input {...register('bankName')} />
            </Field>
            {sensitive && (
              <>
                <Field label={t('employees.bankAccount')}>
                  <Input {...register('bankAccount')} autoComplete="off" />
                </Field>
                <Field label={t('employees.iban')} error={err('iban')}>
                  <Input {...register('iban')} autoComplete="off" />
                </Field>
              </>
            )}
          </FormGrid>
        </FormSection>

        {!editing && can('user.manage') && <Checkbox label={t('employees.createAccount')} {...register('createUserAccount')} />}
      </form>
    </Dialog>
  );
}
