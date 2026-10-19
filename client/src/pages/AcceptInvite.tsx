import { FormEvent, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { toast } from '@/lib/toast';
import { api } from '@/lib/api';
import { errorMessage, useGet } from '@/lib/hooks';
import { fmtDateTime } from '@/lib/format';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/form';
import { Alert, Card, Spinner } from '@/components/ui/display';
import { Logo } from '@/components/Logo';

/** Public page behind the emailed invitation link: the new user chooses their own password (link valid 72 hours, once). */
export default function AcceptInvite() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const invite = useGet<{ email: string; displayName: string; expiresAt: string }>(token ? `/auth/invite?token=${encodeURIComponent(token)}` : null);
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
      await api.post('/auth/invite/accept', { token, password: next });
      toast.success(t('invite.done'), t('invite.doneText'));
      navigate('/login', { replace: true });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-full flex-col items-center justify-center gap-8 p-6">
      <Logo size={40} />
      <Card className="w-full max-w-md">
        <h1 className="text-xl font-semibold">{t('invite.title')}</h1>
        {!token || invite.error ? (
          <div className="mt-4 space-y-4">
            <Alert tone="danger">{t('invite.invalid')}</Alert>
            <Button onClick={() => navigate('/login')}>{t('invite.toLogin')}</Button>
          </div>
        ) : invite.isLoading || !invite.data ? (
          <Spinner />
        ) : (
          <>
            <p className="mt-1 mb-4 text-sm text-ink-3">
              {t('invite.intro', { name: invite.data.displayName, email: invite.data.email, date: fmtDateTime(invite.data.expiresAt) })}
            </p>
            <form onSubmit={submit} className="space-y-4">
              {error && <Alert tone="danger">{error}</Alert>}
              <input type="email" autoComplete="username" value={invite.data.email} readOnly hidden />
              <Field label={t('account.newPassword')} htmlFor="np" hint={t('account.passwordRules')} error={weak ? t('account.passwordRules') : undefined}>
                <Input id="np" type="password" autoComplete="new-password" required value={next} onChange={(e) => setNext(e.target.value)} aria-invalid={weak} />
              </Field>
              <Field label={t('account.confirmPassword')} htmlFor="cf">
                <Input id="cf" type="password" autoComplete="new-password" required value={confirm} onChange={(e) => setConfirm(e.target.value)} />
              </Field>
              <Button type="submit" variant="primary" loading={busy} disabled={weak || !next}>
                {t('invite.submit')}
              </Button>
            </form>
          </>
        )}
      </Card>
    </div>
  );
}
