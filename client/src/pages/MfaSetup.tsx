import { useTranslation } from 'react-i18next';
import { useAuth } from '@/lib/auth';
import { Logo } from '@/components/Logo';
import { Alert } from '@/components/ui/display';
import { Mfa } from './Account';

/** Shown instead of the app when an administrative account must enrol MFA first. */
export default function MfaSetup() {
  const { t } = useTranslation();
  const { reload, logout } = useAuth();
  return (
    <div className="flex min-h-full flex-col items-center justify-center gap-8 p-6">
      <Logo size={40} />
      <div className="w-full max-w-md space-y-4">
        <h1 className="text-xl font-semibold">{t('account.mfaRequiredTitle')}</h1>
        <Alert tone="info">{t('account.mfaRequired')}</Alert>
        <Mfa enabled={false} onChange={() => void reload()} />
        <button className="text-sm text-ink-3 hover:text-ink" onClick={() => void logout()}>
          {t('topbar.signOut')}
        </button>
      </div>
    </div>
  );
}
