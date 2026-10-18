import { createContext, ReactNode, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from './button';
import { Textarea } from './form';

export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  size = 'md',
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  size?: 'sm' | 'md' | 'lg' | 'xl';
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    setTimeout(() => ref.current?.querySelector<HTMLElement>('input,select,textarea,button:not([data-close])')?.focus(), 30);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
      prev?.focus?.();
    };
  }, [open, onClose]);
  if (!open) return null;
  const width = { sm: 'max-w-md', md: 'max-w-xl', lg: 'max-w-3xl', xl: 'max-w-5xl' }[size];
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center sm:p-4" role="presentation">
      <div className="absolute inset-0 animate-fade-in bg-[#0b1421]/50 backdrop-blur-[2px]" onClick={onClose} aria-hidden />
      <div ref={ref} role="dialog" aria-modal="true" aria-label={typeof title === 'string' ? title : undefined} className={cn('relative flex max-h-[92vh] w-full animate-toast-in flex-col rounded-t-2xl border border-line bg-surface shadow-pop sm:rounded-2xl', width)}>
        <div className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
          <div>
            <h2 className="text-base font-semibold text-ink">{title}</h2>
            {description && <p className="mt-0.5 text-sm text-ink-3">{description}</p>}
          </div>
          <button data-close onClick={onClose} className="rounded-md p-1 text-ink-3 hover:bg-subtle hover:text-ink" aria-label="Close">
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="overflow-y-auto px-5 py-4">{children}</div>
        {footer && <div className="flex flex-wrap justify-end gap-2 rounded-b-2xl border-t border-line bg-subtle/50 px-5 py-3">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

interface ConfirmOptions {
  title: string;
  message?: ReactNode;
  confirmLabel?: string;
  tone?: 'danger' | 'primary';
  /** Ask for a reason; resolves with the text. */
  reason?: { label: string; required?: boolean; minLength?: number };
}

type ConfirmFn = (o: ConfirmOptions) => Promise<false | { reason: string }>;
const ConfirmCtx = createContext<ConfirmFn | null>(null);

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const [state, setState] = useState<(ConfirmOptions & { resolve: (v: false | { reason: string }) => void }) | null>(null);
  const [reason, setReason] = useState('');
  const confirm = useCallback<ConfirmFn>((o) => new Promise((resolve) => {
    setReason('');
    setState({ ...o, resolve });
  }), []);
  const close = (v: false | { reason: string }) => {
    state?.resolve(v);
    setState(null);
  };
  const tooShort = !!state?.reason && (state.reason.required || state.reason.minLength) && reason.trim().length < (state.reason.minLength ?? 1);
  return (
    <ConfirmCtx.Provider value={confirm}>
      {children}
      <Dialog
        open={!!state}
        onClose={() => close(false)}
        size="sm"
        title={
          <span className="flex items-center gap-2">
            {state?.tone === 'danger' && <AlertTriangle className="h-5 w-5 text-danger" aria-hidden />}
            {state?.title}
          </span>
        }
        footer={
          <>
            <Button onClick={() => close(false)}>{t('common.cancel')}</Button>
            <Button variant={state?.tone === 'danger' ? 'danger' : 'primary'} disabled={!!tooShort} onClick={() => close({ reason })}>
              {state?.confirmLabel ?? t('common.confirm')}
            </Button>
          </>
        }
      >
        {state?.message && <div className="text-sm text-ink-2">{state.message}</div>}
        {state?.reason && (
          <div className="mt-3 space-y-1.5">
            <label className="text-sm font-medium">{state.reason.label}</label>
            <Textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={3} />
          </div>
        )}
      </Dialog>
    </ConfirmCtx.Provider>
  );
}

export function useConfirm() {
  const c = useContext(ConfirmCtx);
  if (!c) throw new Error('useConfirm outside ConfirmProvider');
  return c;
}

/** Slide-over panel from the inline-end edge. */
export function Drawer({ open, onClose, title, children, footer }: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; footer?: ReactNode }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  return createPortal(
    <div className="fixed inset-0 z-50">
      <div className="absolute inset-0 bg-black/30" onClick={onClose} aria-hidden />
      <aside role="dialog" aria-modal="true" className="absolute inset-y-0 end-0 flex w-full max-w-lg flex-col bg-surface shadow-pop">
        <div className="flex items-center justify-between border-b border-line px-5 py-4">
          <h2 className="text-base font-semibold">{title}</h2>
          <button onClick={onClose} className="rounded-md p-1 text-ink-3 hover:bg-subtle" aria-label="Close">
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-5 py-4">{children}</div>
        {footer && <div className="flex justify-end gap-2 border-t border-line px-5 py-3">{footer}</div>}
      </aside>
    </div>,
    document.body,
  );
}
