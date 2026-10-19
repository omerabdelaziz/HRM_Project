import { describe, expect, it } from 'vitest';
import { addBusinessHours } from '../../src/lib/business-time';
import { sanitizeAuditPayload } from '../../src/lib/audit';

const dubai = (holidays: string[] = []) => ({ timeZone: 'Asia/Dubai', weekendDays: [0, 6], holidays: new Set(holidays) });

describe('business-hours SLA', () => {
  it('skips the weekend: Friday 16:47 + 24h is Monday 16:47', () => {
    // 2026-10-16 is a Friday; 16:47 in Dubai is 12:47 UTC.
    expect(addBusinessHours(new Date('2026-10-16T12:47:00Z'), 24, dubai()).toISOString()).toBe('2026-10-19T12:47:00.000Z');
  });

  it('skips company holidays too', () => {
    expect(addBusinessHours(new Date('2026-10-16T12:47:00Z'), 24, dubai(['2026-10-19'])).toISOString()).toBe('2026-10-20T12:47:00.000Z');
  });

  it('a timer started on a weekend begins on the next working day', () => {
    expect(addBusinessHours(new Date('2026-10-17T08:00:00Z'), 2, dubai()).toISOString()).toBe('2026-10-18T22:00:00.000Z');
  });

  it('works with a Friday–Saturday weekend', () => {
    const cal = { timeZone: 'Asia/Dubai', weekendDays: [5, 6], holidays: new Set<string>() };
    // Thursday 2026-10-15 20:00 Dubai + 8h → Sunday 04:00 Dubai.
    expect(addBusinessHours(new Date('2026-10-15T16:00:00Z'), 8, cal).toISOString()).toBe('2026-10-18T00:00:00.000Z');
  });
});

describe('audit payload sanitising', () => {
  it('drops *Hash fields and masks *Enc fields, at any depth', () => {
    const out = sanitizeAuditPayload({
      firstName: 'Fatima', nationalIdHash: 'abc', nationalIdEnc: 'xyz', ibanEnc: null, passwordHash: 'p',
      nested: [{ tokenHash: 't', bankAccountEnc: 'q', note: 'ok' }],
    });
    expect(out).toEqual({ firstName: 'Fatima', nationalId: '[protected]', nested: [{ bankAccount: '[protected]', note: 'ok' }] });
  });
});
