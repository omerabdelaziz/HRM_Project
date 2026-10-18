import { FormEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from '@/lib/toast';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { errorMessage } from '@/lib/hooks';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/form';
import { Alert, Card } from '@/components/ui/display';
import { Logo } from '@/components/Logo';

export function ChangePasswordForm({ onDone }: { onDone?: () => void }) {
  const { t } = useTranslation();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const weak = next.length > 0 && (next.length < 8 || !/[A-Za-z]/.test(next) || !/\d/.test(next));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (next !== confirm) return setError(t('account.passwordMismatch'));
    setBusy(true);
    setError('');
    try {
      await api.post('/auth/change-password', { currentPassword: current, newPassword: next });
      toast.success(t('account.passwordChanged'));
      setCurrent('');
      setNext('');
      setConfirm('');
      onDone?.();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={submit} className="space-y-4">
      {error && <Alert tone="danger">{error}</Alert>}
      <Field label={t('account.currentPassword')} htmlFor="cp">
        <Input id="cp" type="password" autoComplete="current-password" required value={current} onChange={(e) => setCurrent(e.target.value)} />
      </Field>
      <Field label={t('account.newPassword')} htmlFor="np" hint={t('account.passwordRules')} error={weak ? t('account.passwordRules') : undefined}>
        <Input id="np" type="password" autoComplete="new-password" required value={next} onChange={(e) => setNext(e.target.value)} aria-invalid={weak} />
      </Field>
      <Field label={t('account.confirmPassword')} htmlFor="cf">
        <Input id="cf" type="password" autoComplete="new-password" required value={confirm} onChange={(e) => setConfirm(e.target.value)} />
      </Field>
      <Button type="submit" variant="primary" loading={busy} disabled={weak}>
        {t('account.changePassword')}
      </Button>
    </form>
  );
}

export default function ChangePassword({ forced }: { forced?: boolean }) {
  const { t } = useTranslation();
  const { reload, logout } = useAuth();
  return (
    <div className="flex min-h-full flex-col items-center justify-center gap-8 p-6">
      <Logo size={40} />
      <Card className="w-full max-w-md">
        <h1 className="text-xl font-semibold">{t('account.changePassword')}</h1>
        {forced && <p className="mt-1 mb-4 text-sm text-ink-3">{t('account.mustChange')}</p>}
        <ChangePasswordForm onDone={() => void reload()} />
        <button className="mt-4 text-sm text-ink-3 hover:text-ink" onClick={() => void logout()}>
          {t('topbar.signOut')}
        </button>
      </Card>
    </div>
  );
}
