import { describe, expect, it } from 'vitest';
import { Prisma, type LeaveType } from '@prisma/client';
import { available, computeEntitlement } from '../../src/modules/leave/balances';
import { toDateOnly } from '../../src/lib/dates';

const type = (p: Partial<LeaveType>): LeaveType =>
  ({ annualEntitlement: new Prisma.Decimal(24), accrualMethod: 'ANNUAL', prorateFirstYear: true, ...p }) as LeaveType;

describe('leave entitlement', () => {
  it('grants the full annual amount to employees hired before the year', () => {
    expect(computeEntitlement(type({}), toDateOnly('2020-05-01'), 2026)).toBe(24);
  });

  it('pro-rates the joining year to the nearest half day', () => {
    // Joined 1 July: 184 of 365 days remaining → 12.1 → 12
    expect(computeEntitlement(type({}), toDateOnly('2026-07-01'), 2026)).toBe(12);
    expect(computeEntitlement(type({ prorateFirstYear: false }), toDateOnly('2026-07-01'), 2026)).toBe(24);
  });

  it('gives nothing for a year before hire', () => {
    expect(computeEntitlement(type({}), toDateOnly('2027-01-10'), 2026)).toBe(0);
  });

  it('accrues monthly at month end', () => {
    const t = type({ accrualMethod: 'MONTHLY' });
    expect(computeEntitlement(t, toDateOnly('2020-01-01'), 2026, toDateOnly('2026-03-15'))).toBe(4); // Jan + Feb
    expect(computeEntitlement(t, toDateOnly('2020-01-01'), 2026, toDateOnly('2026-03-31'))).toBe(6);
    expect(computeEntitlement(t, toDateOnly('2020-01-01'), 2025, toDateOnly('2026-03-31'))).toBe(24); // past year fully accrued
  });

  it('counts the joining month only when joined by the 15th', () => {
    const t = type({ accrualMethod: 'MONTHLY' });
    expect(computeEntitlement(t, toDateOnly('2026-02-10'), 2026, toDateOnly('2026-04-30'))).toBe(6); // Feb, Mar, Apr
    expect(computeEntitlement(t, toDateOnly('2026-02-20'), 2026, toDateOnly('2026-04-30'))).toBe(4); // Mar, Apr
  });

  it('NONE accrual is not balance-tracked', () => {
    expect(computeEntitlement(type({ accrualMethod: 'NONE' }), toDateOnly('2020-01-01'), 2026)).toBe(0);
  });

  it('available = entitled + carried + adjusted − used − pending', () => {
    const D = (n: number) => new Prisma.Decimal(n);
    expect(available({ entitled: D(24), carriedOver: D(5), adjusted: D(-1), used: D(10), pending: D(2.5) }).toNumber()).toBe(15.5);
  });
});
