import { createContext, ReactNode, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api, companyStore, refreshAccessToken, tokenStore } from './api';
import { setRegional } from './format';
import { applyLocale, Locale } from './i18n';
import { applyTheme, Theme } from './theme';

export interface Me {
  id: string;
  email: string;
  displayName: string;
  locale: Locale;
  theme: Theme;
  mfaEnabled: boolean;
  mustChangePassword: boolean;
  roles: string[];
  permissions: string[];
  scope: string;
  employee: null | {
    id: string;
    employeeNo: string;
    firstName: string;
    lastName: string;
    firstNameAr: string | null;
    lastNameAr: string | null;
    photoPath: string | null;
    companyId: string;
    company: { name: string; nameAr: string | null; baseCurrency: string; timezone: string; dateFormat: string; locale: string };
    department: { name: string; nameAr: string | null } | null;
    position: { title: string; titleAr: string | null } | null;
    _count: { reports: number };
  };
}

export interface Company {
  id: string;
  code: string;
  name: string;
  nameAr: string | null;
  baseCurrency: string;
  timezone: string;
  dateFormat: string;
  weekendDays: number[];
}

interface AuthState {
  me: Me | null;
  companies: Company[];
  company: Company | null;
  setCompany: (id: string) => void;
  loading: boolean;
  can: (...perms: string[]) => boolean;
  login: (email: string, password: string, mfaCode?: string) => Promise<{ mfaRequired?: boolean }>;
  logout: () => Promise<void>;
  reload: () => Promise<void>;
}

const Ctx = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);
  const [companies, setCompanies] = useState<Company[]>([]);
  const [company, setCompanyState] = useState<Company | null>(null);
  const qc = useQueryClient();

  const load = useCallback(async () => {
    const m = await api.get<Me>('/auth/me');
    const list = await api.get<Company[]>('/org/companies').catch(() => [] as Company[]);
    const chosen = list.find((c) => c.id === companyStore.get()) ?? list.find((c) => c.id === m.employee?.companyId) ?? list[0] ?? null;
    companyStore.set(chosen?.id ?? null);
    if (chosen) setRegional({ timeZone: chosen.timezone, currency: chosen.baseCurrency });
    setCompanies(list);
    setCompanyState(chosen);
    setMe(m);
    applyLocale(m.locale);
    applyTheme(m.theme);
  }, []);

  useEffect(() => {
    // Restore the session from the refresh cookie.
    (async () => {
      try {
        if (await refreshAccessToken()) await load();
      } catch {
        /* signed out */
      } finally {
        setLoading(false);
      }
    })();
    const unsubscribe = tokenStore.onExpired(() => {
      tokenStore.set(null);
      setMe(null);
      qc.clear();
    });
    return () => {
      unsubscribe();
    };
  }, [load, qc]);

  const login = useCallback(
    async (email: string, password: string, mfaCode?: string) => {
      const res = await api.post<{ accessToken?: string; mfaRequired?: boolean }>('/auth/login', { email, password, mfaCode });
      if (res.mfaRequired) return { mfaRequired: true };
      tokenStore.set(res.accessToken!);
      await load();
      return {};
    },
    [load],
  );

  const logout = useCallback(async () => {
    try {
      await api.post('/auth/logout');
    } finally {
      tokenStore.set(null);
      setMe(null);
      qc.clear();
    }
  }, [qc]);

  const value = useMemo<AuthState>(
    () => ({
      me,
      companies,
      company,
      setCompany: (id: string) => {
        const c = companies.find((x) => x.id === id);
        if (!c) return;
        companyStore.set(id);
        setRegional({ timeZone: c.timezone, currency: c.baseCurrency });
        setCompanyState(c);
        qc.invalidateQueries();
      },
      loading,
      can: (...perms) => !!me && perms.some((p) => me.permissions.includes(p)),
      login,
      logout,
      reload: load,
    }),
    [me, companies, company, loading, login, logout, load, qc],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth() {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAuth outside AuthProvider');
  return v;
}
