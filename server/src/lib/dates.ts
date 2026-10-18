// All "date-only" values are handled as UTC midnight Date objects, matching Postgres DATE columns.

export function toDateOnly(input: Date | string): Date {
  if (typeof input === 'string') {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(input);
    if (m) return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    input = new Date(input);
  }
  return new Date(Date.UTC(input.getUTCFullYear(), input.getUTCMonth(), input.getUTCDate()));
}

export function isoDate(d: Date) {
  return d.toISOString().slice(0, 10);
}

export function addDays(d: Date, days: number) {
  const r = new Date(d);
  r.setUTCDate(r.getUTCDate() + days);
  return r;
}

export function eachDay(start: Date, end: Date): Date[] {
  const days: Date[] = [];
  for (let d = toDateOnly(start); d <= end; d = addDays(d, 1)) days.push(d);
  return days;
}

export function daysBetweenInclusive(start: Date, end: Date) {
  return Math.round((toDateOnly(end).getTime() - toDateOnly(start).getTime()) / 86_400_000) + 1;
}

export function monthRange(year: number, month: number) {
  const start = new Date(Date.UTC(year, month - 1, 1));
  const end = new Date(Date.UTC(year, month, 0));
  return { start, end };
}

export function monthsBetween(start: Date, end: Date) {
  return (end.getUTCFullYear() - start.getUTCFullYear()) * 12 + (end.getUTCMonth() - start.getUTCMonth());
}

/** Converts a wall-clock time ("HH:mm") on a given date in an IANA time zone to a UTC instant. */
export function zonedTimeToUtc(date: Date, hhmm: string, timeZone: string): Date {
  const [h, m] = hhmm.split(':').map(Number);
  const guess = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), h, m));
  const offset = tzOffsetMinutes(guess, timeZone);
  const result = new Date(guess.getTime() - offset * 60_000);
  // Re-check around DST transitions.
  const offset2 = tzOffsetMinutes(result, timeZone);
  return offset2 === offset ? result : new Date(guess.getTime() - offset2 * 60_000);
}

export function tzOffsetMinutes(instant: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(instant);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return Math.round((asUtc - instant.getTime()) / 60_000);
}

/** The calendar date (in the given zone) that an instant falls on. */
export function localDateOf(instant: Date, timeZone: string): Date {
  const s = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(
    instant,
  );
  return toDateOnly(s);
}
