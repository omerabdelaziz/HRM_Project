import { FormEvent, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { KeyRound, Languages, ShieldCheck, Clock, Wallet } from 'lucide-react';
import { Logo } from '@/components/Logo';
import { useAuth } from '@/lib/auth';
import { applyLocale } from '@/lib/i18n';
import { errorMessage } from '@/lib/hooks';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/form';
import { Alert } from '@/components/ui/display';

/** Only same-app paths: "//host" and "/\host" would navigate to another site. */
function safeReturnPath(from: string | undefined) {
  return from && /^\/(?![/\\])/.test(from) ? from : '/';
}

export default function Login() {
  const { t, i18n } = useTranslation();
  const { login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation() as { state?: { from?: string } };
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [mfaCode, setMfaCode] = useState('');
  const [mfa, setMfa] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const res = await login(email, password, mfa ? mfaCode : undefined);
      if (res.mfaRequired) setMfa(true);
      else navigate(safeReturnPath(location.state?.from), { replace: true });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-full">
      <div className="relative hidden flex-1 flex-col justify-between overflow-hidden bg-navy p-12 text-white lg:flex">
        <div aria-hidden className="pointer-events-none absolute -end-32 -top-32 h-[28rem] w-[28rem] rounded-full bg-[#2563EB]/25 blur-3xl" />
        <div aria-hidden className="pointer-events-none absolute -bottom-40 -start-24 h-[24rem] w-[24rem] rounded-full bg-[#38BDF8]/15 blur-3xl" />
        <Logo tone="dark" size={44} subtitle={t('app.tagline')} />
        <div className="relative max-w-md">
          <h1 className="text-4xl font-bold leading-tight tracking-tight">{t('login.heroTitle')}</h1>
          <p className="mt-4 text-white/70">{t('login.heroText')}</p>
          <ul className="mt-8 space-y-3 text-sm text-white/80">
            {[
              [<Clock key="c" className="h-4 w-4" />, t('login.point1')],
              [<Wallet key="w" className="h-4 w-4" />, t('login.point2')],
              [<ShieldCheck key="s" className="h-4 w-4" />, t('login.point3')],
            ].map(([icon, text], i) => (
              <li key={i} className="flex items-center gap-3">
                <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-white/10 text-[#38BDF8]">{icon}</span>
                {text}
              </li>
            ))}
          </ul>
        </div>
        <p className="relative text-sm text-white/50">© {new Date().getFullYear()} Aziz HRM</p>
      </div>
      <div className="flex flex-1 items-center justify-center p-6">
        <div className="w-full max-w-sm">
          <Logo className="mb-8 lg:hidden" size={40} />
          <div className="mb-8 flex items-center justify-between">
            <h2 className="text-2xl font-semibold">{mfa ? t('login.mfaTitle') : t('login.title')}</h2>
            <button onClick={() => applyLocale(i18n.language === 'ar' ? 'en' : 'ar')} className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1 text-sm text-ink-2 hover:bg-subtle">
              <Languages className="h-4 w-4" />
              {i18n.language === 'ar' ? 'English' : 'العربية'}
            </button>
          </div>
          <form onSubmit={submit} className="space-y-4">
            {error && <Alert tone="danger">{error}</Alert>}
            {!mfa ? (
              <>
                <Field label={t('login.email')} htmlFor="email">
                  <Input id="email" type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />
                </Field>
                <Field label={t('login.password')} htmlFor="password">
                  <Input id="password" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
                </Field>
              </>
            ) : (
              <Field label={t('login.mfaCode')} hint={t('login.mfaHint')} htmlFor="mfa">
                <Input id="mfa" inputMode="numeric" autoComplete="one-time-code" pattern="\d{6}" maxLength={6} required autoFocus value={mfaCode} onChange={(e) => setMfaCode(e.target.value.replace(/\D/g, ''))} className="tracking-[0.4em] text-center text-lg" />
              </Field>
            )}
            <Button type="submit" variant="primary" size="lg" className="w-full justify-center" loading={busy} icon={<KeyRound className="h-4 w-4" />}>
              {mfa ? t('login.verify') : t('login.submit')}
            </Button>
            {mfa && (
              <button type="button" className="w-full text-center text-sm text-ink-3 hover:text-ink" onClick={() => (setMfa(false), setMfaCode(''))}>
                {t('common.back')}
              </button>
            )}
          </form>
          <p className="mt-8 text-center text-xs text-ink-3">{t('login.help')}</p>
        </div>
      </div>
    </div>
  );
}
