/**
 * One CSV cell. Numbers pass through; text that a spreadsheet would run as a formula
 * (starting with = + - @ tab or CR) is prefixed with an apostrophe so it stays text.
 */
export function csvCell(v: unknown) {
  if (v === null || v === undefined) return '';
  let s = String(v);
  if (typeof v !== 'number' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
