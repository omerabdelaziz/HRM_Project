import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import en from '../locales/en.json';
import ar from '../locales/ar.json';
import { setRegional } from './format';

export type Locale = 'en' | 'ar';

function savedLocale(): Locale {
  try {
    return (localStorage.getItem('hrms.locale') as Locale) || 'en';
  } catch {
    return 'en';
  }
}

i18n.use(initReactI18next).init({
  resources: { en: { translation: en }, ar: { translation: ar } },
  lng: savedLocale(),
  fallbackLng: 'en',
  interpolation: { escapeValue: false },
  returnNull: false,
});

export function applyLocale(locale: Locale) {
  try {
    localStorage.setItem('hrms.locale', locale);
  } catch {
    /* storage unavailable */
  }
  document.documentElement.lang = locale;
  document.documentElement.dir = locale === 'ar' ? 'rtl' : 'ltr';
  setRegional({ locale });
  if (i18n.language !== locale) void i18n.changeLanguage(locale);
}

applyLocale(savedLocale());

export const isRtl = () => document.documentElement.dir === 'rtl';

/** Picks the Arabic variant of a name when the UI is in Arabic and one exists. */
export function localized<T extends Record<string, unknown>>(obj: T | null | undefined, field: string): string {
  if (!obj) return '';
  const ar = obj[`${field}Ar`];
  return (i18n.language === 'ar' && typeof ar === 'string' && ar ? ar : (obj[field] as string)) ?? '';
}

export function personName(p: { firstName: string; lastName: string; firstNameAr?: string | null; lastNameAr?: string | null } | null | undefined) {
  if (!p) return '';
  if (i18n.language === 'ar' && p.firstNameAr) return `${p.firstNameAr} ${p.lastNameAr ?? ''}`.trim();
  return `${p.firstName} ${p.lastName}`;
}

/**
 * Translates an API message. Validation messages are i18n keys, optionally with one parameter after "|"
 * (e.g. "validation.minAge|18"); anything else (older plain-English messages) is shown as-is.
 */
export function translateMessage(message: string | undefined | null): string | undefined {
  if (!message) return undefined;
  const [key, param] = message.split('|');
  if (/^[a-z]+\.[A-Za-z.]+$/.test(key) && i18n.exists(key)) return i18n.t(key, { n: param });
  return message;
}

export default i18n;
