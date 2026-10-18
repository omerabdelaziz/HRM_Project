import { clsx, type ClassValue } from 'clsx';

export const cn = (...v: ClassValue[]) => clsx(v);

export function initials(name: string) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase())
    .join('');
}

export const todayIso = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

export function addDaysIso(iso: string, days: number) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function monthStartIso(offsetMonths = 0) {
  const d = new Date();
  return new Date(Date.UTC(d.getFullYear(), d.getMonth() + offsetMonths, 1)).toISOString().slice(0, 10);
}

export function monthEndIso(offsetMonths = 0) {
  const d = new Date();
  return new Date(Date.UTC(d.getFullYear(), d.getMonth() + offsetMonths + 1, 0)).toISOString().slice(0, 10);
}

/** Converts a datetime-local input value ("2026-03-02T09:00") to ISO with the browser's offset. */
export function localInputToIso(v: string) {
  return v ? new Date(v).toISOString() : null;
}

export function isoToLocalInput(iso: string | null | undefined) {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
