import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Check, ChevronDown, X } from 'lucide-react';
import { api } from '@/lib/api';
import { useDebounced, useAuthedImage, useGet } from '@/lib/hooks';
import { localized, personName } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { COUNTRY_CODES, countryName, nationalityName } from '@shared/countries';
import { Avatar } from './display';
import { Select } from './form';

export interface EmployeeLite {
  id: string;
  employeeNo: string;
  firstName: string;
  lastName: string;
  firstNameAr?: string | null;
  lastNameAr?: string | null;
  user?: { id: string } | null;
}

/** Async employee search limited to the user's data scope. */
export function EmployeePicker({ value, onChange, placeholder, exclude, valueLabel, disabled, invalid }: { value: string | null | undefined; onChange: (id: string | null, emp?: EmployeeLite) => void; placeholder?: string; exclude?: string[]; valueLabel?: string; disabled?: boolean; invalid?: boolean }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [label, setLabel] = useState(valueLabel ?? '');
  const search = useDebounced(q, 200);
  const ref = useRef<HTMLDivElement>(null);
  const { data = [], isFetching } = useQuery({
    queryKey: ['/employees/lookup', search],
    queryFn: () => api.get<EmployeeLite[]>('/employees/lookup', { search: search || undefined }),
    enabled: open,
  });
  useEffect(() => setLabel(valueLabel ?? ''), [valueLabel]);
  useEffect(() => {
    const onDoc = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);
  const list = data.filter((e) => !exclude?.includes(e.id));
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        disabled={disabled}
        aria-invalid={invalid}
        onClick={() => setOpen((o) => !o)}
        className="flex h-10 w-full items-center justify-between gap-2 rounded-lg border border-line bg-surface px-3 text-start text-sm hover:border-ink-3/40 focus:border-primary focus:outline-none focus:ring-[3px] focus:ring-primary/15 disabled:bg-subtle aria-[invalid=true]:border-danger"
      >
        <span className={cn('truncate', !value && 'text-ink-3')}>{value ? label || t('common.selected') : placeholder ?? t('employees.selectEmployee')}</span>
        <span className="flex items-center gap-1 text-ink-3">
          {value && !disabled && (
            <X
              className="h-4 w-4 hover:text-ink"
              onClick={(e) => {
                e.stopPropagation();
                onChange(null);
                setLabel('');
              }}
            />
          )}
          <ChevronDown className="h-4 w-4" />
        </span>
      </button>
      {open && (
        <div className="absolute z-40 mt-1 w-full min-w-[16rem] rounded-xl border border-line bg-surface p-1 shadow-pop">
          <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('common.searchPlaceholder')} className="mb-1 h-9 w-full rounded-lg border border-line bg-surface px-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20" />
          <div className="max-h-64 overflow-y-auto">
            {isFetching && !list.length && <p className="px-3 py-2 text-sm text-ink-3">{t('common.loading')}</p>}
            {!isFetching && !list.length && <p className="px-3 py-2 text-sm text-ink-3">{t('common.noResults')}</p>}
            {list.map((e) => (
              <button
                key={e.id}
                type="button"
                onClick={() => {
                  onChange(e.id, e);
                  setLabel(`${personName(e)} · ${e.employeeNo}`);
                  setOpen(false);
                }}
                className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-start text-sm hover:bg-subtle"
              >
                <Avatar name={personName(e)} size="sm" />
                <span className="min-w-0 flex-1 truncate">{personName(e)}</span>
                <span className="text-xs text-ink-3 tabular">{e.employeeNo}</span>
                {value === e.id && <Check className="h-4 w-4 text-primary" />}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

interface Named {
  id: string;
  name?: string;
  nameAr?: string | null;
  title?: string;
  titleAr?: string | null;
  code?: string;
}

/** Select bound to an org lookup endpoint (branches, departments, positions…). */
export function OrgSelect({ entity, value, onChange, placeholder, filter, invalid, id }: { entity: 'branches' | 'departments' | 'positions' | 'grades' | 'cost-centers' | 'categories' | 'employment-types'; value: string | null | undefined; onChange: (v: string | null) => void; placeholder?: string; filter?: Record<string, string>; invalid?: boolean; id?: string }) {
  const { t } = useTranslation();
  const { data = [] } = useGet<Named[]>(`/org/${entity}`, filter, { staleTime: 60_000 });
  const label = (x: Named) => (x.title !== undefined ? localized(x as unknown as Record<string, unknown>, 'title') : localized(x as unknown as Record<string, unknown>, 'name'));
  return (
    <Select id={id} aria-invalid={invalid} value={value ?? ''} onChange={(e) => onChange(e.target.value || null)} placeholder={placeholder ?? t('common.none')}>
      {data.map((x) => (
        <option key={x.id} value={x.id}>
          {label(x)}
          {x.code ? ` (${x.code})` : ''}
        </option>
      ))}
    </Select>
  );
}

export function EmployeeAvatar({ employee, size = 'md' }: { employee: { id: string; firstName: string; lastName: string; firstNameAr?: string | null; lastNameAr?: string | null; photoPath?: string | null }; size?: 'sm' | 'md' | 'lg' | 'xl' }) {
  const src = useAuthedImage(employee.photoPath ? `/employees/${employee.id}/photo` : null);
  return <Avatar name={`${employee.firstName} ${employee.lastName}`} src={src} size={size} />;
}

export function PersonCell({ employee, sub }: { employee: { id: string; firstName: string; lastName: string; firstNameAr?: string | null; lastNameAr?: string | null; photoPath?: string | null; employeeNo?: string }; sub?: string }) {
  return (
    <div className="flex items-center gap-3 min-w-0">
      <EmployeeAvatar employee={employee} size="sm" />
      <div className="min-w-0">
        <p className="truncate font-medium text-ink">{personName(employee)}</p>
        <p className="truncate text-xs text-ink-3">{sub ?? employee.employeeNo}</p>
      </div>
    </div>
  );
}

/** Searchable ISO 3166 country picker. Shows nationality names ("Jordanian") with the country beneath, in the UI language. */
export function CountryPicker({ value, onChange, invalid, id, placeholder }: { value: string | null | undefined; onChange: (code: string | null) => void; invalid?: boolean; id?: string; placeholder?: string }) {
  const { t, i18n } = useTranslation();
  const lang = i18n.language === 'ar' ? 'ar' : 'en';
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onDoc = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);
  const items = COUNTRY_CODES.map((code) => ({ code, nationality: nationalityName(code, lang), country: countryName(code, lang) })).sort((a, b) => a.nationality.localeCompare(b.nationality, lang));
  const needle = q.trim().toLowerCase();
  // Search in both languages so either spelling finds the country.
  const list = needle
    ? items.filter((x) => [x.code, x.nationality, x.country, nationalityName(x.code, lang === 'ar' ? 'en' : 'ar'), countryName(x.code, lang === 'ar' ? 'en' : 'ar')].some((s) => s.toLowerCase().includes(needle)))
    : items;
  return (
    <div ref={ref} className="relative">
      <button
        id={id}
        type="button"
        aria-invalid={invalid}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="flex h-10 w-full items-center justify-between gap-2 rounded-lg border border-line bg-surface px-3 text-start text-sm hover:border-ink-3/40 focus:border-primary focus:outline-none focus:ring-[3px] focus:ring-primary/15 aria-[invalid=true]:border-danger"
      >
        <span className={cn('truncate', !value && 'text-ink-3')}>{value ? nationalityName(value, lang) : placeholder ?? t('common.selectPlaceholder')}</span>
        <span className="flex items-center gap-1 text-ink-3">
          {value && (
            <X
              className="h-4 w-4 hover:text-ink"
              aria-label={t('common.clear')}
              onClick={(e) => {
                e.stopPropagation();
                onChange(null);
              }}
            />
          )}
          <ChevronDown className="h-4 w-4" />
        </span>
      </button>
      {open && (
        <div className="absolute z-40 mt-1 w-full min-w-[16rem] rounded-xl border border-line bg-surface p-1 shadow-pop">
          <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('common.searchPlaceholder')} aria-label={t('common.search')} className="mb-1 h-9 w-full rounded-lg border border-line bg-surface px-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20" />
          <div role="listbox" className="max-h-64 overflow-y-auto">
            {!list.length && <p className="px-3 py-2 text-sm text-ink-3">{t('common.noResults')}</p>}
            {list.map((x) => (
              <button
                key={x.code}
                type="button"
                role="option"
                aria-selected={value === x.code}
                onClick={() => {
                  onChange(x.code);
                  setQ('');
                  setOpen(false);
                }}
                className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-start text-sm hover:bg-subtle"
              >
                <span className="min-w-0 flex-1 truncate">
                  {x.nationality}
                  {x.nationality !== x.country && <span className="text-xs text-ink-3"> · {x.country}</span>}
                </span>
                <span className="text-xs text-ink-3">{x.code}</span>
                {value === x.code && <Check className="h-4 w-4 text-primary" />}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
