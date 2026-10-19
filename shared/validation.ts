/**
 * Validation and normalisation rules shared by the API (zod schemas) and the web client (form rules),
 * so both sides accept and reject exactly the same input. Messages are i18n keys under "validation.*".
 */
import { parsePhoneNumberFromString, type CountryCode as PhoneRegion } from 'libphonenumber-js';

// ── Emirates ID ──────────────────────────────────────────────────────

/** Luhn (mod 10) check over a string of digits. */
export function luhnValid(digits: string): boolean {
  if (!/^\d+$/.test(digits)) return false;
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

/** Digits of an Emirates ID, accepting input with or without dashes/spaces. */
export const emiratesIdDigits = (v: string) => v.replace(/[\s-]/g, '');

export type EmiratesIdProblem = 'validation.emiratesIdFormat' | 'validation.emiratesIdChecksum';

/** Checks 784-YYYY-NNNNNNN-C: 15 digits, prefix 784, plausible year, valid Luhn check digit. */
export function emiratesIdProblem(value: string): EmiratesIdProblem | null {
  const digits = emiratesIdDigits(value);
  if (!/^784\d{12}$/.test(digits)) return 'validation.emiratesIdFormat';
  const year = Number(digits.slice(3, 7));
  if (year < 1900 || year > new Date().getFullYear()) return 'validation.emiratesIdFormat';
  if (!luhnValid(digits)) return 'validation.emiratesIdChecksum';
  return null;
}

/** Canonical stored form: 784-YYYY-NNNNNNN-C. */
export function formatEmiratesId(value: string): string {
  const d = emiratesIdDigits(value);
  return d.length === 15 ? `${d.slice(0, 3)}-${d.slice(3, 7)}-${d.slice(7, 14)}-${d.slice(14)}` : value.trim();
}

export const NATIONAL_ID_TYPES = ['EMIRATES_ID', 'PASSPORT', 'OTHER'] as const;
export type NationalIdType = (typeof NATIONAL_ID_TYPES)[number];

/** Emirates ID rules apply when the ID type says so, or (no type given) for UAE nationals. */
export function requiresEmiratesId(idType: string | null | undefined, nationality: string | null | undefined) {
  return idType === 'EMIRATES_ID' || (!idType && nationality?.toUpperCase() === 'AE');
}

// ── Phone numbers ────────────────────────────────────────────────────

/** Normalises to E.164 (e.g. +971501234567); null when the number is not valid. Default region: AE. */
export function normalizePhone(value: string, defaultRegion: PhoneRegion = 'AE'): string | null {
  const parsed = parsePhoneNumberFromString(value.trim(), defaultRegion);
  return parsed && parsed.isValid() ? parsed.number : null;
}

// ── Names ────────────────────────────────────────────────────────────

/** Arabic name particles kept lower-case in Latin script ("Saeed bin Rashid"). "Al" is capitalised by Gulf convention. */
const LOWER_PARTICLES = new Set(['bin', 'bint', 'ibn', 'binti', 'de', 'da', 'van', 'von', 'der', 'del', 'la', 'le']);

function capWord(word: string, isLast: boolean) {
  const lower = word.toLowerCase();
  // A particle joins two names ("Saeed bin Rashid", last name "bin Rashid"); alone at the end it is a name itself ("Li Bin").
  if (!isLast && LOWER_PARTICLES.has(lower)) return lower;
  // Capitalise each part of hyphenated or apostrophised words: "al-mansoori" → "Al-Mansoori", "o'neil" → "O'Neil".
  return lower.replace(/(^|[-'’])(\p{L})/gu, (_, sep: string, ch: string) => sep + ch.toUpperCase());
}

/**
 * Title-cases a Latin-script name typed all in upper or lower case. Names already in mixed case
 * ("McDonald", "DeSouza", "Al Mansoori") and non-Latin names are left as entered.
 */
export function capitalizeName(value: string): string {
  const name = value.trim().replace(/\s+/g, ' ');
  if (!name || !/[A-Za-z]/.test(name)) return name;
  const letters = name.replace(/[^A-Za-z]/g, '');
  const mixed = letters !== letters.toLowerCase() && letters !== letters.toUpperCase();
  if (mixed) return name;
  const words = name.split(' ');
  return words.map((w, i) => capWord(w, i === words.length - 1)).join(' ');
}

// ── Dates ────────────────────────────────────────────────────────────

/** Whole years between a YYYY-MM-DD birth date and a reference YYYY-MM-DD date. */
export function ageOn(birthDate: string, onDate: string): number {
  const [by, bm, bd] = birthDate.slice(0, 10).split('-').map(Number);
  const [y, m, d] = onDate.slice(0, 10).split('-').map(Number);
  let age = y - by;
  if (m < bm || (m === bm && d < bd)) age--;
  return age;
}

/** UAE law: no employment under 15; minors (15–17) only with restrictions. */
export const LEGAL_MIN_AGE = 15;
export const DEFAULT_MIN_EMPLOYEE_AGE = 18;

export const todayIso = () => new Date().toISOString().slice(0, 10);
