// Centralized notifications: shown at the top of the screen (below the top bar), slide down,
// auto-dismiss, closable, and de-duplicated. Success is only ever raised from a mutation's
// onSuccess, i.e. after the server has confirmed the operation.
import { useEffect, useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, CheckCircle2, Info, X, XCircle } from 'lucide-react';
import { cn } from './utils';
import i18n from './i18n';

export type ToastKind = 'success' | 'error' | 'warning' | 'info';

interface ToastItem {
  id: number;
  key: string;
  kind: ToastKind;
  title: string;
  description?: string;
  duration: number;
  leaving: boolean;
  /** Bumped when an identical toast is raised again, restarting its timer instead of stacking. */
  version: number;
}

const DURATION: Record<ToastKind, number> = { success: 4000, info: 4000, warning: 5000, error: 6000 };
const MAX = 3;

let items: ToastItem[] = [];
let nextId = 1;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
const timers = new Map<number, ReturnType<typeof setTimeout>>();

function schedule(item: ToastItem) {
  clearTimeout(timers.get(item.id));
  timers.set(item.id, setTimeout(() => dismiss(item.id), item.duration));
}

export function dismiss(id: number) {
  clearTimeout(timers.get(id));
  timers.delete(id);
  items = items.map((t) => (t.id === id ? { ...t, leaving: true } : t));
  emit();
  setTimeout(() => {
    items = items.filter((t) => t.id !== id);
    emit();
  }, 180);
}

function push(kind: ToastKind, title: string, description?: string, duration = DURATION[kind]) {
  const key = `${kind}|${title}|${description ?? ''}`;
  const existing = items.find((t) => t.key === key && !t.leaving);
  if (existing) {
    // Same message already on screen: keep one and restart its timer.
    existing.version++;
    items = [...items];
    schedule(existing);
    emit();
    return existing.id;
  }
  const item: ToastItem = { id: nextId++, key, kind, title, description, duration, leaving: false, version: 0 };
  items = [...items, item];
  const visible = items.filter((t) => !t.leaving);
  if (visible.length > MAX) dismiss(visible[0].id);
  schedule(item);
  emit();
  return item.id;
}

/**
 * success(message?) — message becomes the headline; with no message the standard
 *   "Saved successfully!" headline and description are used.
 * error(message) — "Something went wrong" headline with the server's message underneath.
 */
export const toast = {
  success: (title?: string, description?: string) =>
    push('success', title || i18n.t('toast.savedTitle'), title ? description : description ?? i18n.t('toast.savedText')),
  error: (message: string, title?: string) => push('error', title ?? i18n.t('toast.errorTitle'), message),
  warning: (title: string, description?: string) => push('warning', title, description),
  info: (title: string, description?: string) => push('info', title, description),
  dismiss,
};

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};
const snapshot = () => items;

const STYLE: Record<ToastKind, { box: string; icon: string; bar: string; Icon: typeof CheckCircle2 }> = {
  success: { box: 'border-success/30 bg-success-soft', icon: 'text-success', bar: 'bg-success', Icon: CheckCircle2 },
  error: { box: 'border-danger/30 bg-danger-soft', icon: 'text-danger', bar: 'bg-danger', Icon: XCircle },
  warning: { box: 'border-warning/40 bg-warning-soft', icon: 'text-warning', bar: 'bg-warning', Icon: AlertTriangle },
  info: { box: 'border-primary/30 bg-primary-soft', icon: 'text-primary', bar: 'bg-primary', Icon: Info },
};

function ToastCard({ t }: { t: ToastItem }) {
  const { t: tr } = useTranslation();
  const s = STYLE[t.kind];
  const [paused, setPaused] = useState(false);
  useEffect(() => {
    if (paused) clearTimeout(timers.get(t.id));
    else if (!t.leaving) schedule(t);
  }, [paused, t]);
  return (
    <div
      role={t.kind === 'error' ? 'alert' : 'status'}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      className={cn('pointer-events-auto relative w-full overflow-hidden rounded-xl border shadow-lift backdrop-blur', s.box, t.leaving ? 'animate-toast-out' : 'animate-toast-in')}
    >
      <div className="flex items-start gap-3 px-4 py-3 pe-10">
        <s.Icon className={cn('mt-0.5 h-5 w-5 shrink-0', s.icon)} aria-hidden />
        <div className="min-w-0">
          <p className="text-sm font-semibold text-ink">{t.title}</p>
          {t.description && <p className="mt-0.5 break-words text-sm text-ink-2">{t.description}</p>}
        </div>
      </div>
      <button onClick={() => dismiss(t.id)} className="absolute end-2 top-2 rounded-md p-1 text-ink-3 hover:bg-black/5 hover:text-ink dark:hover:bg-white/10" aria-label={tr('common.close')}>
        <X className="h-4 w-4" />
      </button>
      <span
        key={t.version}
        aria-hidden
        className={cn('absolute bottom-0 start-0 h-0.5 w-full origin-left opacity-60 rtl:origin-right', s.bar)}
        style={{ animation: `toast-progress ${t.duration}ms linear forwards`, animationPlayState: paused ? 'paused' : 'running' }}
      />
    </div>
  );
}

/** Mount once. `belowTopBar` offsets the stack so it appears under the app's top navigation. */
export function Toaster({ belowTopBar }: { belowTopBar: boolean }) {
  const list = useSyncExternalStore(subscribe, snapshot);
  return (
    <div aria-live="polite" className={cn('pointer-events-none fixed inset-x-0 z-[60] flex flex-col items-center gap-2 px-4', belowTopBar ? 'top-[4.25rem]' : 'top-4')}>
      <div className="flex w-full max-w-md flex-col gap-2">
        {list.map((t) => (
          <ToastCard key={t.id} t={t} />
        ))}
      </div>
    </div>
  );
}
