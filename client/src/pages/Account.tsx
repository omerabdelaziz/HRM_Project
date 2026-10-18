import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Laptop, LogOut, ShieldCheck } from 'lucide-react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useApiMutation, useGet } from '@/lib/hooks';
import { applyLocale } from '@/lib/i18n';
import { applyTheme, currentTheme, Theme } from '@/lib/theme';
import { fmtDateTime } from '@/lib/format';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/form';
import { Alert, Badge, Card, CardHeader, PageHeader } from '@/components/ui/display';
import { Segmented } from '@/components/ui/nav';
import { ChangePasswordForm } from './ChangePassword';
import { UserCircle as PageIcon } from 'lucide-react';

export default function Account() {
  const { t, i18n } = useTranslation();
  const { me, reload } = useAuth();
  const [theme, setTheme] = useState<Theme>(currentTheme());
  const setPref = async (p: { locale?: 'en' | 'ar'; theme?: Theme }) => {
    if (p.locale) applyLocale(p.locale);
    if (p.theme) {
      applyTheme(p.theme);
      setTheme(p.theme);
    }
    await api.patch('/auth/preferences', p).catch(() => undefined);
  };
  return (
    <div className="space-y-6">
      <PageHeader icon={<PageIcon />} title={t('topbar.accountSettings')} subtitle={me?.email} />
      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader title={t('account.preferences')} />
          <div className="space-y-4">
            <Field label={t('topbar.language')}>
              <Segmented value={i18n.language as 'en' | 'ar'} onChange={(v) => setPref({ locale: v })} options={[{ id: 'en', label: 'English' }, { id: 'ar', label: 'العربية' }]} />
            </Field>
            <Field label={t('topbar.theme')}>
              <Segmented value={theme} onChange={(v) => setPref({ theme: v })} options={[{ id: 'light', label: t('account.light') }, { id: 'dark', label: t('account.dark') }, { id: 'system', label: t('account.system') }]} />
            </Field>
          </div>
        </Card>
        <Card>
          <CardHeader title={t('account.changePassword')} />
          <ChangePasswordForm />
        </Card>
        <Mfa enabled={!!me?.mfaEnabled} onChange={() => void reload()} />
        <Sessions />
        <NotificationPrefs />
      </div>
    </div>
  );
}

function Mfa({ enabled, onChange }: { enabled: boolean; onChange: () => void }) {
  const { t } = useTranslation();
  const [setup, setSetup] = useState<{ secret: string; qrDataUrl: string } | null>(null);
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const start = useApiMutation(() => api.post<{ secret: string; qrDataUrl: string }>('/auth/mfa/setup'), { success: '', onSuccess: (r) => setSetup(r) });
  const enable = useApiMutation(() => api.post('/auth/mfa/enable', { code }), { success: t('account.mfaEnabled'), onSuccess: () => (setSetup(null), setCode(''), onChange()) });
  const disable = useApiMutation(() => api.post('/auth/mfa/disable', { password }), { success: t('account.mfaDisabled'), onSuccess: () => (setPassword(''), onChange()) });
  return (
    <Card>
      <CardHeader title={t('account.mfa')} subtitle={t('account.mfaHint')} actions={enabled ? <Badge tone="success"><ShieldCheck className="h-3 w-3" /> {t('common.on')}</Badge> : <Badge>{t('common.off')}</Badge>} />
      {enabled ? (
        <div className="space-y-3">
          <Field label={t('account.confirmWithPassword')}>
            <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
          </Field>
          <Button variant="danger" disabled={!password} loading={disable.isPending} onClick={() => disable.mutate(undefined)}>
            {t('account.disableMfa')}
          </Button>
        </div>
      ) : setup ? (
        <div className="space-y-4">
          <p className="text-sm text-ink-2">{t('account.scanQr')}</p>
          <img src={setup.qrDataUrl} alt={t('account.qrAlt')} className="h-44 w-44 rounded-lg border border-line bg-white p-2" />
          <p className="text-xs text-ink-3">
            {t('account.manualKey')}: <span className="font-mono select-all">{setup.secret}</span>
          </p>
          <Field label={t('login.mfaCode')}>
            <Input inputMode="numeric" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} className="max-w-[10rem] tracking-[0.3em]" />
          </Field>
          <Button variant="primary" disabled={code.length !== 6} loading={enable.isPending} onClick={() => enable.mutate(undefined)}>
            {t('account.verifyEnable')}
          </Button>
        </div>
      ) : (
        <Button variant="primary" icon={<ShieldCheck className="h-4 w-4" />} loading={start.isPending} onClick={() => start.mutate(undefined)}>
          {t('account.setupMfa')}
        </Button>
      )}
    </Card>
  );
}

function Sessions() {
  const { t } = useTranslation();
  const { data = [] } = useGet<{ id: string; ip: string | null; userAgent: string | null; createdAt: string; lastUsedAt: string; current: boolean }[]>('/auth/sessions');
  const end = useApiMutation((id: string) => api.delete(`/auth/sessions/${id}`), { success: t('account.sessionEnded'), invalidate: ['/auth/sessions'] });
  return (
    <Card>
      <CardHeader title={t('account.sessions')} subtitle={t('account.sessionsHint')} />
      <ul className="divide-y divide-line">
        {data.map((s) => (
          <li key={s.id} className="flex items-center justify-between gap-3 py-2.5 text-sm">
            <span className="flex min-w-0 items-center gap-3">
              <Laptop className="h-5 w-5 shrink-0 text-ink-3" aria-hidden />
              <span className="min-w-0">
                <span className="block truncate">{s.userAgent?.replace(/\s*\(.*?\)\s*/g, ' ').slice(0, 60) ?? t('account.unknownDevice')}</span>
                <span className="block text-xs text-ink-3">
                  {s.ip} · {t('account.lastActive', { when: fmtDateTime(s.lastUsedAt) })}
                </span>
              </span>
            </span>
            {s.current ? <Badge tone="primary">{t('account.thisDevice')}</Badge> : <Button size="sm" variant="ghost" icon={<LogOut className="h-4 w-4" />} onClick={() => end.mutate(s.id)}>{t('account.signOut')}</Button>}
          </li>
        ))}
      </ul>
    </Card>
  );
}

function NotificationPrefs() {
  const { t } = useTranslation();
  const { data } = useGet<{ type: string; inApp: boolean; email: boolean }[]>('/notifications/preferences');
  const [prefs, setPrefs] = useState<{ type: string; inApp: boolean; email: boolean }[] | null>(null);
  if (data && !prefs) setPrefs(data);
  const save = useApiMutation(() => api.put('/notifications/preferences', prefs), {});
  if (!prefs) return null;
  return (
    <Card className="lg:col-span-2">
      <CardHeader title={t('account.notifications')} subtitle={t('account.notificationsHint')} actions={<Button size="sm" variant="primary" loading={save.isPending} onClick={() => save.mutate(undefined)}>{t('common.save')}</Button>} />
      <table className="w-full text-sm">
        <thead className="text-xs text-ink-3">
          <tr>
            <th className="py-2 text-start font-medium">{t('account.notificationType')}</th>
            <th className="w-24 py-2 text-center font-medium">{t('account.inApp')}</th>
            <th className="w-24 py-2 text-center font-medium">{t('account.email')}</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {prefs.map((p, i) => (
            <tr key={p.type}>
              <td className="py-2">{t(`notificationType.${p.type}`)}</td>
              {(['inApp', 'email'] as const).map((k) => (
                <td key={k} className="py-2 text-center">
                  <input type="checkbox" aria-label={`${t(`notificationType.${p.type}`)} ${k}`} className="accent-[rgb(var(--primary))]" checked={p[k]} onChange={(e) => setPrefs(prefs.map((x, j) => (j === i ? { ...x, [k]: e.target.checked } : x)))} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <div className="mt-3">
        <Alert tone="info">{t('account.emailNote')}</Alert>
      </div>
    </Card>
  );
}
