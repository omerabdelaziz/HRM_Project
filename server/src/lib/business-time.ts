import { addDays, isoDate, localDateOf, zonedTimeToUtc } from './dates';

export interface BusinessCalendar {
  timeZone: string;
  /** 0 = Sunday … 6 = Saturday */
  weekendDays: number[];
  /** Company-wide public holidays, YYYY-MM-DD */
  holidays: Set<string>;
}

const isBusinessDay = (localDate: Date, cal: BusinessCalendar) => !cal.weekendDays.includes(localDate.getUTCDay()) && !cal.holidays.has(isoDate(localDate));

/**
 * Adds a duration counted only on business days (company working days that are not public holidays).
 * Time on business days counts around the clock, so 24 business hours from Friday 16:47 with a
 * Saturday–Sunday weekend ends on Monday 16:47.
 */
export function addBusinessHours(start: Date, hours: number, cal: BusinessCalendar): Date {
  let remaining = hours * 3_600_000;
  let cursor = new Date(start);
  for (let guard = 0; guard < 3660; guard++) {
    const day = localDateOf(cursor, cal.timeZone);
    const nextDayStart = zonedTimeToUtc(addDays(day, 1), '00:00', cal.timeZone);
    if (!isBusinessDay(day, cal)) {
      cursor = nextDayStart;
      continue;
    }
    const available = nextDayStart.getTime() - cursor.getTime();
    if (remaining <= available) return new Date(cursor.getTime() + remaining);
    remaining -= available;
    cursor = nextDayStart;
  }
  throw new Error('Business calendar has no working days');
}
