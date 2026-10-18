import { ReactNode, useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/utils';

export function Tabs<T extends string>({ tabs, value, onChange, className }: { tabs: { id: T; label: ReactNode; count?: number; hidden?: boolean }[]; value: T; onChange: (v: T) => void; className?: string }) {
  return (
    <div role="tablist" className={cn('flex gap-1 overflow-x-auto border-b border-line', className)}>
      {tabs
        .filter((t) => !t.hidden)
        .map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={value === t.id}
            onClick={() => onChange(t.id)}
            className={cn(
              '-mb-px inline-flex items-center gap-2 whitespace-nowrap border-b-2 px-3 py-2.5 text-sm font-medium transition-colors',
              value === t.id ? 'border-primary text-primary-ink' : 'border-transparent text-ink-3 hover:text-ink',
            )}
          >
            {t.label}
            {t.count !== undefined && <span className="rounded-full bg-subtle px-1.5 text-xs text-ink-2 tabular">{t.count}</span>}
          </button>
        ))}
    </div>
  );
}

export function Segmented<T extends string>({ options, value, onChange }: { options: { id: T; label: ReactNode }[]; value: T; onChange: (v: T) => void }) {
  return (
    <div className="inline-flex rounded-lg border border-line bg-subtle p-0.5" role="radiogroup">
      {options.map((o) => (
        <button
          key={o.id}
          role="radio"
          aria-checked={value === o.id}
          onClick={() => onChange(o.id)}
          className={cn('rounded-md px-3 py-1 text-sm font-medium transition-colors', value === o.id ? 'bg-surface text-ink shadow-sm' : 'text-ink-3 hover:text-ink')}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Menu({ trigger, children, align = 'end' }: { trigger: (open: boolean) => ReactNode; children: (close: () => void) => ReactNode; align?: 'start' | 'end' }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);
  return (
    <div ref={ref} className="relative">
      <div onClick={() => setOpen((o) => !o)}>{trigger(open)}</div>
      {open && (
        <div role="menu" className={cn('absolute z-40 mt-1 min-w-[12rem] rounded-xl border border-line bg-surface p-1 shadow-pop', align === 'end' ? 'end-0' : 'start-0')}>
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

export function MenuItem({ onClick, icon, children, danger }: { onClick: () => void; icon?: ReactNode; children: ReactNode; danger?: boolean }) {
  return (
    <button role="menuitem" onClick={onClick} className={cn('flex w-full items-center gap-2 rounded-lg px-3 py-2 text-start text-sm hover:bg-subtle', danger ? 'text-danger-ink' : 'text-ink')}>
      {icon && <span className="text-ink-3">{icon}</span>}
      {children}
    </button>
  );
}
