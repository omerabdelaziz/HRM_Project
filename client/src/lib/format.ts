// Locale-aware formatting driven by the user's language and the company's regional settings.

interface Regional {
  locale: string;
  timeZone: string;
  currency: string;
}

const regional: Regional = { locale: 'en', timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, currency: 'USD' };

export function setRegional(r: Partial<Regional>) {
  Object.assign(regional, Object.fromEntries(Object.entries(r).filter(([, v]) => v)));
}
export const getRegional = () => regional;

// Latin digits in both languages keep figures consistent in tables and exports.
const tag = () => (regional.locale === 'ar' ? 'ar-AE-u-nu-latn' : 'en-GB');

type DateLike = string | Date | null | undefined;
const toDate = (v: DateLike) => (v ? (v instanceof Date ? v : new Date(v)) : null);

/** Date-only values (stored as UTC midnight) are formatted in UTC so they never shift a day. */
export function fmtDate(v: DateLike, opts: Intl.DateTimeFormatOptions = { day: '2-digit', month: 'short', year: 'numeric' }) {
  const d = toDate(v);
  return d ? new Intl.DateTimeFormat(tag(), { ...opts, timeZone: 'UTC' }).format(d) : '—';
}

export function fmtDateShort(v: DateLike) {
  return fmtDate(v, { day: '2-digit', month: 'short' });
}

/** Instants (punch times, timestamps) are shown in the company time zone. */
export function fmtTime(v: DateLike) {
  const d = toDate(v);
  return d ? new Intl.DateTimeFormat(tag(), { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: regional.timeZone }).format(d) : '—';
}

export function fmtDateTime(v: DateLike) {
  const d = toDate(v);
  return d
    ? new Intl.DateTimeFormat(tag(), { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: regional.timeZone }).format(d)
    : '—';
}

export function fmtMonth(year: number, month: number) {
  return new Intl.DateTimeFormat(tag(), { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(Date.UTC(year, month - 1, 1)));
}

export function fmtNumber(v: number | string | null | undefined, digits = 0) {
  if (v === null || v === undefined || v === '') return '—';
  return new Intl.NumberFormat(tag(), { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(Number(v));
}

export function fmtCompact(v: number) {
  return new Intl.NumberFormat(tag(), { notation: 'compact', maximumFractionDigits: 1 }).format(v);
}

export function fmtMoney(v: number | string | null | undefined, currency = regional.currency, opts: { compact?: boolean } = {}) {
  if (v === null || v === undefined || v === '') return '—';
  return new Intl.NumberFormat(tag(), {
    style: 'currency',
    currency,
    currencyDisplay: 'code',
    notation: opts.compact ? 'compact' : 'standard',
    maximumFractionDigits: opts.compact ? 1 : 2,
    minimumFractionDigits: opts.compact ? 0 : 2,
  }).format(Number(v));
}

export function fmtPercent(v: number | null | undefined, digits = 1) {
  if (v === null || v === undefined) return '—';
  return new Intl.NumberFormat(tag(), { style: 'percent', minimumFractionDigits: digits, maximumFractionDigits: digits }).format(v);
}

/** Minutes → "7h 30m". */
export function fmtMinutes(min: number | null | undefined) {
  if (!min) return '0h';
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  return m ? `${h}h ${m}m` : `${h}h`;
}

export function fmtBytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 ** 2).toFixed(1)} MB`;
}

export function relativeTime(v: DateLike) {
  const d = toDate(v);
  if (!d) return '';
  const diff = (d.getTime() - Date.now()) / 1000;
  const rtf = new Intl.RelativeTimeFormat(tag(), { numeric: 'auto' });
  const abs = Math.abs(diff);
  if (abs < 60) return rtf.format(Math.round(diff), 'second');
  if (abs < 3600) return rtf.format(Math.round(diff / 60), 'minute');
  if (abs < 86400) return rtf.format(Math.round(diff / 3600), 'hour');
  if (abs < 86400 * 30) return rtf.format(Math.round(diff / 86400), 'day');
  return fmtDate(d);
}
