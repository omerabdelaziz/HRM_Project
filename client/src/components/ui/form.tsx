import { createContext, forwardRef, InputHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes, useContext, useId } from 'react';

const FieldErrorsCtx = createContext<Record<string, string>>({});

/** Provides server-side validation messages (keyed by field path) to the Fields inside it. */
export function FieldErrors({ errors, children }: { errors: Record<string, string>; children: ReactNode }) {
  return <FieldErrorsCtx.Provider value={errors}>{children}</FieldErrorsCtx.Provider>;
}
import { Search } from 'lucide-react';
import { cn } from '@/lib/utils';

const control =
  'w-full rounded-lg border border-line bg-surface px-3 text-sm text-ink placeholder:text-ink-3 transition-colors hover:border-ink-3/40 focus:border-primary focus:outline-none focus:ring-[3px] focus:ring-primary/15 disabled:bg-subtle disabled:text-ink-3 aria-[invalid=true]:border-danger aria-[invalid=true]:ring-danger/15';

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input({ className, ...p }, ref) {
  return <input ref={ref} className={cn(control, 'h-10', className)} {...p} />;
});

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea({ className, rows = 3, ...p }, ref) {
  return <textarea ref={ref} rows={rows} className={cn(control, 'py-2', className)} {...p} />;
});

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement> & { placeholder?: string }>(function Select(
  { className, children, placeholder, ...p },
  ref,
) {
  return (
    <select ref={ref} className={cn(control, 'h-10 pe-8', className)} {...p}>
      {placeholder !== undefined && <option value="">{placeholder}</option>}
      {children}
    </select>
  );
});

export function SearchInput({ className, ...p }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <div className={cn('relative', className)}>
      <Search className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-3" aria-hidden />
      <Input type="search" className="ps-9" {...p} />
    </div>
  );
}

export function Field({ label, error: errorProp, hint, required, children, className, htmlFor, name }: { label?: ReactNode; error?: string; hint?: ReactNode; required?: boolean; children: ReactNode; className?: string; htmlFor?: string; name?: string }) {
  const ctx = useContext(FieldErrorsCtx);
  const error = errorProp ?? (name ? ctx[name] : undefined);
  return (
    <div className={cn('space-y-1.5', className)}>
      {label && (
        <label htmlFor={htmlFor} className="block text-sm font-medium text-ink">
          {label}
          {required && <span className="ms-0.5 text-danger" aria-hidden>*</span>}
        </label>
      )}
      {children}
      {error ? <p className="flex items-center gap-1 text-xs font-medium text-danger-ink" role="alert"><span aria-hidden>⚠</span>{error}</p> : hint ? <p className="text-xs text-ink-3">{hint}</p> : null}
    </div>
  );
}

export function Checkbox({ label, className, ...p }: InputHTMLAttributes<HTMLInputElement> & { label?: ReactNode }) {
  const id = useId();
  return (
    <label htmlFor={p.id ?? id} className={cn('inline-flex items-center gap-2 text-sm text-ink cursor-pointer select-none', className)}>
      <input id={p.id ?? id} type="checkbox" className="h-4 w-4 rounded border-line text-primary accent-[rgb(var(--primary))]" {...p} />
      {label}
    </label>
  );
}

export function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label?: ReactNode; disabled?: boolean }) {
  return (
    <label className={cn('inline-flex items-center gap-2.5 text-sm', disabled ? 'opacity-50' : 'cursor-pointer')}>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cn('relative inline-flex h-5 w-9 shrink-0 rounded-full transition-colors', checked ? 'bg-primary' : 'bg-muted')}
      >
        <span className={cn('absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all', checked ? 'start-[1.125rem]' : 'start-0.5')} />
      </button>
      {label && <span className="text-ink">{label}</span>}
    </label>
  );
}

export function FormGrid({ children, cols = 2 }: { children: ReactNode; cols?: 1 | 2 | 3 }) {
  return <div className={cn('grid gap-4', cols === 1 ? 'grid-cols-1' : cols === 2 ? 'grid-cols-1 sm:grid-cols-2' : 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-3')}>{children}</div>;
}

export function FormSection({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return (
    <section className="space-y-4">
      <div>
        <h3 className="text-sm font-semibold text-ink">{title}</h3>
        {description && <p className="text-xs text-ink-3 mt-0.5">{description}</p>}
      </div>
      {children}
    </section>
  );
}
