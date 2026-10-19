import { ReactNode, useEffect, useRef, useState } from 'react';
import { Link, NavLink, useLocation, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import {
  BarChart3, Bell, Building2, CalendarCheck, CalendarDays, CheckSquare, ChevronsLeft, Clock, FileText, Home, Languages, LayoutDashboard,
  LogOut, Megaphone, Search, Menu as MenuIcon, Moon, Network, Receipt, ScrollText, Settings, Shield, Sun, User, Users, Wallet, Workflow, X, Server,
} from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { api } from '@/lib/api';
import { applyLocale, localized, personName } from '@/lib/i18n';
import { applyTheme, isDark } from '@/lib/theme';
import { cn } from '@/lib/utils';
import { relativeTime } from '@/lib/format';
import { useDebounced } from '@/lib/hooks';
import { Menu, MenuItem } from '@/components/ui/nav';
import { Avatar } from '@/components/ui/display';
import { Logo, LogoMark } from '@/components/Logo';
import type { EmployeeLite } from '@/components/ui/pickers';

interface NavItem {
  to: string;
  label: string;
  icon: ReactNode;
  show: boolean;
  badge?: number;
  end?: boolean;
}

function usePersisted(key: string, initial: boolean) {
  const [v, setV] = useState<boolean>(() => {
    try {
      return localStorage.getItem(key) === null ? initial : localStorage.getItem(key) === '1';
    } catch {
      return initial;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(key, v ? '1' : '0');
    } catch {
      /* ignore */
    }
  }, [key, v]);
  return [v, setV] as const;
}

export function AppShell({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const { me, can } = useAuth();
  const [collapsed, setCollapsed] = usePersisted('hrms.sidebar.collapsed', false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const location = useLocation();
  useEffect(() => setMobileOpen(false), [location.pathname]);

  const { data: inbox } = useQuery({ queryKey: ['/approvals/inbox/count'], queryFn: () => api.get<{ count: number }>('/approvals/inbox/count'), refetchInterval: 60_000, enabled: can('approval.act') });

  const groups: { title?: string; items: NavItem[] }[] = [
    {
      items: [
        { to: '/', label: t('nav.home'), icon: <Home />, show: true, end: true },
        { to: '/dashboard', label: t('nav.dashboard'), icon: <LayoutDashboard />, show: can('dashboard.read') },
        { to: '/approvals', label: t('nav.approvals'), icon: <CheckSquare />, show: can('approval.act'), badge: inbox?.count },
      ],
    },
    {
      title: t('nav.groupPeople'),
      items: [
        { to: '/employees', label: t('nav.employees'), icon: <Users />, show: can('employee.read') },
        { to: '/organization', label: t('nav.organization'), icon: <Building2 />, show: can('org.manage'), end: true },
        { to: '/organization/chart', label: t('nav.orgChart'), icon: <Network />, show: can('employee.read') },
      ],
    },
    {
      title: t('nav.groupTime'),
      items: [
        { to: '/attendance', label: t('nav.attendance'), icon: <Clock />, show: can('attendance.self', 'attendance.read') },
        { to: '/leave', label: t('nav.leave'), icon: <CalendarDays />, show: can('leave.request', 'leave.read') },
        { to: '/leave/calendar', label: t('nav.leaveCalendar'), icon: <CalendarCheck />, show: can('leave.read') },
      ],
    },
    {
      title: t('nav.groupPay'),
      items: [
        { to: '/payroll', label: t('nav.payroll'), icon: <Wallet />, show: can('payroll.read') },
        { to: '/me/payslips', label: t('nav.myPayslips'), icon: <Receipt />, show: can('payslip.self') && !!me?.employee },
      ],
    },
    {
      title: t('nav.groupInsight'),
      items: [
        { to: '/reports', label: t('nav.reports'), icon: <BarChart3 />, show: can('report.read') },
        { to: '/announcements', label: t('nav.announcements'), icon: <Megaphone />, show: true },
      ],
    },
    {
      title: t('nav.groupAdmin'),
      items: [
        { to: '/admin/users', label: t('nav.users'), icon: <User />, show: can('user.manage') },
        { to: '/admin/roles', label: t('nav.roles'), icon: <Shield />, show: can('role.manage') },
        { to: '/admin/workflows', label: t('nav.workflows'), icon: <Workflow />, show: can('workflow.manage') },
        { to: '/admin/settings', label: t('nav.settings'), icon: <Settings />, show: can('settings.manage', 'leavetype.manage', 'shift.manage', 'holiday.manage', 'paycomponent.manage') },
        { to: '/admin/audit', label: t('nav.audit'), icon: <ScrollText />, show: can('audit.read') },
        { to: '/admin/system', label: t('nav.system'), icon: <Server />, show: can('settings.manage') },
      ],
    },
  ];

  const sidebar = (mobile: boolean) => (
    <nav aria-label={t('nav.main')} className="flex h-full flex-col">
      <div className={cn('flex h-16 items-center gap-2 border-b border-white/10 px-4', collapsed && !mobile && 'justify-center px-0')}>
        <Link to="/" className="rounded-lg focus-visible:outline-accent" aria-label={t('app.name')}>
          <Logo tone="dark" size={34} collapsed={collapsed && !mobile} subtitle={t('app.tagline')} />
        </Link>
        {mobile && (
          <button className="ms-auto rounded-md p-1 text-white/60 hover:bg-white/10 hover:text-white" onClick={() => setMobileOpen(false)} aria-label={t('common.close')}>
            <X className="h-5 w-5" />
          </button>
        )}
      </div>
      <div className="flex-1 space-y-5 overflow-y-auto px-3 py-4 [scrollbar-color:rgb(255_255_255/0.15)_transparent]">
        {groups.map((g, gi) => {
          const items = g.items.filter((i) => i.show);
          if (!items.length) return null;
          return (
            <div key={gi}>
              {g.title && (!collapsed || mobile) && <p className="mb-1.5 px-3 text-[11px] font-semibold uppercase tracking-[0.12em] text-white/40">{g.title}</p>}
              <ul className="space-y-0.5">
                {items.map((i) => (
                  <li key={i.to}>
                    <NavLink
                      to={i.to}
                      end={i.end}
                      title={collapsed && !mobile ? i.label : undefined}
                      className={({ isActive }) =>
                        cn(
                          'group relative flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors focus-visible:outline-accent [&_svg]:h-[18px] [&_svg]:w-[18px] [&_svg]:shrink-0',
                          isActive
                            ? 'bg-white/[0.12] text-white before:absolute before:inset-y-1.5 before:start-0 before:w-[3px] before:rounded-full before:bg-accent [&_svg]:text-accent'
                            : 'text-white/70 hover:bg-white/[0.07] hover:text-white',
                          collapsed && !mobile && 'justify-center px-0',
                        )
                      }
                    >
                      {i.icon}
                      {(!collapsed || mobile) && <span className="truncate">{i.label}</span>}
                      {!!i.badge && (
                        <span className={cn('rounded-full bg-danger px-1.5 text-[11px] font-semibold text-white tabular', collapsed && !mobile ? 'absolute -top-0.5 end-1' : 'ms-auto')}>{i.badge}</span>
                      )}
                    </NavLink>
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </div>
      {!mobile && (
        <button onClick={() => setCollapsed(!collapsed)} className="flex h-12 items-center justify-center gap-2 border-t border-white/10 text-sm text-white/50 hover:text-white" aria-label={collapsed ? t('nav.expand') : t('nav.collapse')}>
          <ChevronsLeft className={cn('h-4 w-4 transition-transform rtl:rotate-180', collapsed && 'rotate-180 rtl:rotate-0')} />
          {!collapsed && t('nav.collapse')}
        </button>
      )}
    </nav>
  );

  return (
    <div className="flex h-full">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:z-50 focus:m-2 focus:rounded focus:bg-surface focus:px-3 focus:py-2">
        {t('nav.skip')}
      </a>
      <aside className={cn('hidden shrink-0 bg-navy transition-[width] duration-200 lg:block', collapsed ? 'w-[68px]' : 'w-64')}>{sidebar(false)}</aside>
      {mobileOpen && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <div className="absolute inset-0 bg-black/40" onClick={() => setMobileOpen(false)} aria-hidden />
          <aside className="absolute inset-y-0 start-0 w-72 bg-navy shadow-pop animate-fade-in">{sidebar(true)}</aside>
        </div>
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar onMenu={() => setMobileOpen(true)} />
        <main id="main" className="flex-1 overflow-y-auto">
          <div className="mx-auto max-w-[1440px] px-4 py-6 sm:px-6 lg:px-8">{children}</div>
        </main>
      </div>
    </div>
  );
}

function TopBar({ onMenu }: { onMenu: () => void }) {
  const { t, i18n } = useTranslation();
  const { me, logout, can, companies, company, setCompany } = useAuth();
  const navigate = useNavigate();
  const [dark, setDark] = useState(isDark());

  const switchLocale = async () => {
    const next = i18n.language === 'ar' ? 'en' : 'ar';
    applyLocale(next);
    await api.patch('/auth/preferences', { locale: next }).catch(() => undefined);
  };
  const toggleTheme = async () => {
    const next = dark ? 'light' : 'dark';
    applyTheme(next);
    setDark(!dark);
    await api.patch('/auth/preferences', { theme: next }).catch(() => undefined);
  };

  return (
    <header className="sticky top-0 z-30 flex h-14 items-center gap-2 border-b border-line bg-surface/90 px-3 shadow-[0_1px_0_rgb(16_42_67/0.02)] backdrop-blur sm:px-5">
      <button className="rounded-lg p-2 text-ink-2 hover:bg-subtle lg:hidden" onClick={onMenu} aria-label={t('nav.openMenu')}>
        <MenuIcon className="h-5 w-5" />
      </button>
      <Link to="/" className="lg:hidden" aria-label={t('app.name')}>
        <LogoMark size={28} />
      </Link>
      {companies.length > 1 ? (
        <select value={company?.id} onChange={(e) => setCompany(e.target.value)} className="hidden h-9 max-w-[14rem] rounded-lg border border-line bg-surface px-2 text-sm sm:block" aria-label={t('common.company')}>
          {companies.map((c) => (
            <option key={c.id} value={c.id}>
              {localized(c as unknown as Record<string, unknown>, 'name')}
            </option>
          ))}
        </select>
      ) : (
        company && <span className="hidden truncate text-sm font-medium text-ink-2 sm:block">{localized(company as unknown as Record<string, unknown>, 'name')}</span>
      )}
      <div className="flex-1">
        {can('employee.read') && (
          <>
            <div className="hidden sm:block">
              <GlobalSearch />
            </div>
            <Link to="/employees" className="ms-auto flex w-fit rounded-lg p-2 text-ink-2 hover:bg-subtle sm:hidden" aria-label={t('common.search')}>
              <Search className="h-5 w-5" />
            </Link>
          </>
        )}
      </div>
      <button onClick={switchLocale} className="inline-flex h-9 items-center gap-1.5 rounded-lg px-2.5 text-sm font-medium text-ink-2 hover:bg-subtle" aria-label={t('topbar.language')}>
        <Languages className="h-4 w-4" />
        <span className="hidden sm:inline">{i18n.language === 'ar' ? 'English' : 'العربية'}</span>
      </button>
      <button onClick={toggleTheme} className="rounded-lg p-2 text-ink-2 hover:bg-subtle" aria-label={t('topbar.theme')}>
        {dark ? <Sun className="h-5 w-5" /> : <Moon className="h-5 w-5" />}
      </button>
      <NotificationBell />
      <Menu
        trigger={() => (
          <button className="flex items-center gap-2 rounded-lg p-1 hover:bg-subtle" aria-label={t('topbar.account')}>
            <Avatar name={me?.displayName ?? ''} size="sm" />
          </button>
        )}
      >
        {(close) => (
          <>
            <div className="border-b border-line px-3 py-2">
              <p className="truncate text-sm font-medium">{me?.employee ? personName(me.employee) : me?.displayName}</p>
              <p className="truncate text-xs text-ink-3">{me?.email}</p>
            </div>
            {me?.employee && (
              <MenuItem icon={<User className="h-4 w-4" />} onClick={() => (close(), navigate(`/employees/${me.employee!.id}`))}>
                {t('topbar.myProfile')}
              </MenuItem>
            )}
            <MenuItem icon={<Settings className="h-4 w-4" />} onClick={() => (close(), navigate('/account'))}>
              {t('topbar.accountSettings')}
            </MenuItem>
            {import.meta.env.DEV && (
              <MenuItem icon={<FileText className="h-4 w-4" />} onClick={() => (close(), window.open('/api/docs', '_blank', 'noopener'))}>
                {t('topbar.apiDocs')}
              </MenuItem>
            )}
            <MenuItem danger icon={<LogOut className="h-4 w-4" />} onClick={() => (close(), void logout())}>
              {t('topbar.signOut')}
            </MenuItem>
          </>
        )}
      </Menu>
    </header>
  );
}

function GlobalSearch() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const search = useDebounced(q, 200);
  const ref = useRef<HTMLDivElement>(null);
  const { data = [] } = useQuery({ queryKey: ['/employees/lookup', search], queryFn: () => api.get<EmployeeLite[]>('/employees/lookup', { search }), enabled: search.length >= 2 });
  useEffect(() => {
    const onDoc = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        ref.current?.querySelector('input')?.focus();
      }
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, []);
  return (
    <div ref={ref} className="relative mx-auto w-full max-w-md">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          setOpen(false);
          navigate(`/employees?search=${encodeURIComponent(q)}`);
        }}
      >
        <input
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          placeholder={t('topbar.search')}
          aria-label={t('topbar.search')}
          className="h-9 w-full rounded-lg border border-line bg-subtle px-3 text-sm placeholder:text-ink-3 focus:border-primary focus:bg-surface focus:outline-none focus:ring-2 focus:ring-primary/20"
        />
      </form>
      {open && search.length >= 2 && (
        <div className="absolute z-40 mt-1 w-full rounded-xl border border-line bg-surface p-1 shadow-pop">
          {data.length === 0 && <p className="px-3 py-2 text-sm text-ink-3">{t('common.noResults')}</p>}
          {data.slice(0, 8).map((e) => (
            <Link key={e.id} to={`/employees/${e.id}`} onClick={() => setOpen(false)} className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm hover:bg-subtle">
              <Avatar name={personName(e)} size="sm" />
              <span className="flex-1 truncate">{personName(e)}</span>
              <span className="text-xs text-ink-3 tabular">{e.employeeNo}</span>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

interface Notification {
  id: string;
  type: string;
  title: string;
  body: string | null;
  link: string | null;
  readAt: string | null;
  createdAt: string;
}

function NotificationBell() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { data, refetch } = useQuery({
    queryKey: ['/notifications', 'bell'],
    queryFn: () => api.get<{ items: Notification[]; unread: number }>('/notifications', { pageSize: 8 }),
    refetchInterval: 60_000,
  });
  const open = async (n: Notification, close: () => void) => {
    close();
    if (!n.readAt) await api.post(`/notifications/${n.id}/read`).catch(() => undefined);
    void refetch();
    if (n.link) navigate(n.link);
  };
  return (
    <Menu
      trigger={() => (
        <button className="relative rounded-lg p-2 text-ink-2 hover:bg-subtle" aria-label={t('topbar.notifications', { count: data?.unread ?? 0 })}>
          <Bell className="h-5 w-5" />
          {!!data?.unread && <span className="absolute end-1 top-1 min-w-[1.1rem] rounded-full bg-danger px-1 text-[10px] font-semibold leading-4 text-white tabular">{data.unread > 99 ? '99+' : data.unread}</span>}
        </button>
      )}
    >
      {(close) => (
        <div className="w-80 max-w-[calc(100vw-2rem)]">
          <div className="flex items-center justify-between px-3 py-2">
            <p className="text-sm font-semibold">{t('topbar.notificationsTitle')}</p>
            {!!data?.unread && (
              <button className="text-xs text-primary-ink hover:underline" onClick={async () => (await api.post('/notifications/read-all'), refetch())}>
                {t('topbar.markAllRead')}
              </button>
            )}
          </div>
          <div className="max-h-96 overflow-y-auto">
            {!data?.items.length && <p className="px-3 py-6 text-center text-sm text-ink-3">{t('topbar.noNotifications')}</p>}
            {data?.items.map((n) => (
              <button key={n.id} onClick={() => open(n, close)} className={cn('flex w-full gap-2 rounded-lg px-3 py-2 text-start hover:bg-subtle', !n.readAt && 'bg-primary-soft/40')}>
                <span className={cn('mt-1.5 h-2 w-2 shrink-0 rounded-full', n.readAt ? 'bg-transparent' : 'bg-primary')} aria-hidden />
                <span className="min-w-0">
                  <span className="block text-sm text-ink">{n.title}</span>
                  {n.body && <span className="block truncate text-xs text-ink-3">{n.body}</span>}
                  <span className="block text-[11px] text-ink-3">{relativeTime(n.createdAt)}</span>
                </span>
              </button>
            ))}
          </div>
          <button onClick={() => (close(), navigate('/notifications'))} className="w-full border-t border-line px-3 py-2 text-center text-sm text-primary-ink hover:bg-subtle">
            {t('topbar.allNotifications')}
          </button>
        </div>
      )}
    </Menu>
  );
}
