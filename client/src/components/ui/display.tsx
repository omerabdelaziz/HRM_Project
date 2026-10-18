import { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, ArrowDownRight, ArrowUpRight, Inbox, Loader2 } from 'lucide-react';
import { cn, initials } from '@/lib/utils';
import { Button } from './button';

export function Card({ children, className, padded = true }: { children: ReactNode; className?: string; padded?: boolean }) {
  return <div className={cn('rounded-xl border border-line bg-surface shadow-card', padded && 'p-5', className)}>{children}</div>;
}

export function CardHeader({ title, subtitle, actions, className }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode; className?: string }) {
  return (
    <div className={cn('flex items-start justify-between gap-3 mb-4', className)}>
      <div className="min-w-0">
        <h2 className="text-[0.95rem] font-semibold text-ink">{title}</h2>
        {subtitle && <p className="text-sm text-ink-3 mt-0.5">{subtitle}</p>}
      </div>
      {actions && <div className="flex items-center gap-2 shrink-0">{actions}</div>}
    </div>
  );
}

type Tone = 'neutral' | 'primary' | 'success' | 'warning' | 'danger' | 'info';
const tones: Record<Tone, string> = {
  neutral: 'bg-subtle text-ink-2 border-line',
  primary: 'bg-primary-soft text-primary-ink border-primary/20',
  success: 'bg-success-soft text-success-ink border-success/20',
  warning: 'bg-warning-soft text-warning-ink border-warning/30',
  danger: 'bg-danger-soft text-danger-ink border-danger/20',
  info: 'bg-info-soft text-info-ink border-info/20',
};

export function Badge({ tone = 'neutral', children, className, dot }: { tone?: Tone; children: ReactNode; className?: string; dot?: boolean }) {
  return (
    <span className={cn('inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium whitespace-nowrap', tones[tone], className)}>
      {dot && <span className="h-1.5 w-1.5 rounded-full bg-current" aria-hidden />}
      {children}
    </span>
  );
}

const STATUS_TONE: Record<string, Tone> = {
  ACTIVE: 'success', PROBATION: 'info', SUSPENDED: 'warning', RESIGNED: 'neutral', TERMINATED: 'danger', RETIRED: 'neutral',
  PENDING: 'warning', APPROVED: 'success', REJECTED: 'danger', CANCELLED: 'neutral', DRAFT: 'neutral',
  PRESENT: 'success', LATE: 'warning', ABSENT: 'danger', HALF_DAY: 'warning', ON_LEAVE: 'info', HOLIDAY: 'primary', WEEKEND: 'neutral', MISSED_PUNCH: 'danger',
  CALCULATED: 'info', PENDING_APPROVAL: 'warning', PAID: 'success', UNPAID: 'neutral', ON_HOLD: 'warning',
  OPEN: 'warning', DONE: 'success', SUPERSEDED: 'neutral', QUEUED: 'neutral', RUNNING: 'info', FAILED: 'danger',
};

/** A status pill with a translated label; color always comes with text, never alone. */
export function StatusBadge({ status }: { status: string }) {
  const { t } = useTranslation();
  return (
    <Badge tone={STATUS_TONE[status] ?? 'neutral'} dot>
      {t(`status.${status}`, status.replace(/_/g, ' ').toLowerCase())}
    </Badge>
  );
}

export function Avatar({ name, src, size = 'md' }: { name: string; src?: string | null; size?: 'sm' | 'md' | 'lg' | 'xl' }) {
  const s = { sm: 'h-7 w-7 text-[11px]', md: 'h-9 w-9 text-xs', lg: 'h-12 w-12 text-sm', xl: 'h-20 w-20 text-xl' }[size];
  if (src) return <img src={src} alt="" className={cn('rounded-full object-cover bg-subtle', s)} />;
  return (
    <span aria-hidden className={cn('inline-flex shrink-0 items-center justify-center rounded-full bg-primary-soft font-semibold text-primary-ink', s)}>
      {initials(name)}
    </span>
  );
}

export function Spinner({ className, label }: { className?: string; label?: string }) {
  return (
    <div className={cn('flex items-center justify-center gap-2 py-10 text-sm text-ink-3', className)} role="status">
      <Loader2 className="h-5 w-5 animate-spin" aria-hidden />
      {label}
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn('animate-pulse rounded-md bg-subtle', className)} aria-hidden />;
}

export function EmptyState({ icon, title, description, action }: { icon?: ReactNode; title: string; description?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center text-center py-12 px-6">
      <div className="mb-3 rounded-full bg-subtle p-3 text-ink-3">{icon ?? <Inbox className="h-6 w-6" aria-hidden />}</div>
      <p className="text-sm font-medium text-ink">{title}</p>
      {description && <p className="mt-1 max-w-sm text-sm text-ink-3">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col items-center py-10 text-center" role="alert">
      <AlertTriangle className="h-6 w-6 text-danger mb-2" aria-hidden />
      <p className="text-sm font-medium text-ink">{t('common.loadFailed')}</p>
      <p className="text-sm text-ink-3 mt-1">{(error as Error)?.message}</p>
      {onRetry && (
        <Button className="mt-3" size="sm" onClick={onRetry}>
          {t('common.retry')}
        </Button>
      )}
    </div>
  );
}

export function Alert({ tone = 'info', title, children, icon }: { tone?: Tone; title?: ReactNode; children?: ReactNode; icon?: ReactNode }) {
  return (
    <div className={cn('flex gap-3 rounded-lg border px-4 py-3 text-sm', tones[tone])} role={tone === 'danger' ? 'alert' : 'status'}>
      {icon && <span className="mt-0.5 shrink-0">{icon}</span>}
      <div className="min-w-0">
        {title && <p className="font-medium">{title}</p>}
        {children && <div className={cn(title && 'mt-0.5', 'opacity-90')}>{children}</div>}
      </div>
    </div>
  );
}

const ICON_TONE: Record<Tone | 'navy', string> = {
  neutral: 'bg-subtle text-ink-2',
  primary: 'bg-primary-soft text-primary',
  success: 'bg-success-soft text-success',
  warning: 'bg-warning-soft text-warning',
  danger: 'bg-danger-soft text-danger',
  info: 'bg-info-soft text-info',
  navy: 'bg-navy text-accent dark:bg-primary-soft dark:text-primary-ink',
};

/** KPI tile: icon · label · large value · optional delta and caption. */
export function StatTile({ label, value, caption, delta, deltaGood, icon, tone = 'primary', onClick }: { label: string; value: ReactNode; caption?: ReactNode; delta?: number | null; deltaGood?: 'up' | 'down'; icon?: ReactNode; tone?: Tone | 'navy'; onClick?: () => void }) {
  const showDelta = delta !== undefined && delta !== null && Number.isFinite(delta);
  const up = (delta ?? 0) >= 0;
  const good = deltaGood ? (deltaGood === 'up' ? up : !up) : null;
  const Comp = onClick ? 'button' : 'div';
  return (
    <Comp onClick={onClick} className={cn('group w-full rounded-xl border border-line bg-surface p-4 text-start shadow-card transition-shadow sm:p-5', onClick && 'hover:shadow-lift focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40')}>
      <div className="flex items-start justify-between gap-3">
        <p className="text-sm font-medium text-ink-2">{label}</p>
        {icon && <span className={cn('flex h-9 w-9 shrink-0 items-center justify-center rounded-lg [&_svg]:h-[18px] [&_svg]:w-[18px]', ICON_TONE[tone])}>{icon}</span>}
      </div>
      <p className="mt-1 text-[1.75rem] font-bold leading-tight tracking-tight text-ink tabular">{value}</p>
      <div className="mt-1.5 flex min-h-[1rem] items-center gap-2 text-xs">
        {showDelta && (
          <span className={cn('inline-flex items-center gap-0.5 font-medium', good === null ? 'text-ink-2' : good ? 'text-success-ink' : 'text-danger-ink')}>
            {up ? <ArrowUpRight className="h-3.5 w-3.5" aria-hidden /> : <ArrowDownRight className="h-3.5 w-3.5" aria-hidden />}
            {Math.abs(delta!).toFixed(1)}%
          </span>
        )}
        {caption && <span className="truncate text-ink-3">{caption}</span>}
      </div>
    </Comp>
  );
}

export function DescriptionList({ items, cols = 2 }: { items: [ReactNode, ReactNode][]; cols?: 1 | 2 | 3 }) {
  return (
    <dl className={cn('grid gap-x-6 gap-y-4', cols === 1 ? 'grid-cols-1' : cols === 2 ? 'grid-cols-1 sm:grid-cols-2' : 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-3')}>
      {items.map(([k, v], i) => (
        <div key={i} className="min-w-0">
          <dt className="text-xs font-medium uppercase tracking-wide text-ink-3">{k}</dt>
          <dd className="mt-1 text-sm text-ink break-words">{v ?? '—'}</dd>
        </div>
      ))}
    </dl>
  );
}

export function PageHeader({ title, subtitle, actions, back, icon }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode; back?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
      <div className="flex min-w-0 items-center gap-3.5">
        {icon && <span className="hidden h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-navy text-accent shadow-card dark:bg-primary-soft dark:text-primary-ink sm:flex [&_svg]:h-5 [&_svg]:w-5">{icon}</span>}
        <div className="min-w-0">
          {back}
          <h1 className="text-xl font-bold tracking-tight text-ink sm:text-2xl">{title}</h1>
          {subtitle && <p className="mt-0.5 text-sm text-ink-3">{subtitle}</p>}
        </div>
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}
