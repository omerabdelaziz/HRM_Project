import { describe, expect, it } from 'vitest';
import { Prisma, type PayComponent } from '@prisma/client';
import { computePension, DEFAULT_PENSION_RULES, resolvePensionRules, type PensionRules } from '../../src/modules/payroll/pension';
import { calculatePayslip, type PayrollInput } from '../../src/modules/payroll/calc';

const rules = DEFAULT_PENSION_RULES;
const n = (d: Prisma.Decimal | undefined) => d?.toDecimalPlaces(2).toNumber();

describe('statutory pension (computePension)', () => {
  it('returns nothing for employees outside the pension system', () => {
    expect(computePension('NONE', 30000, rules)).toBeNull();
  });

  it('GPSSA old scheme: 5% employee, 15% employer above the subsidy threshold', () => {
    const r = computePension('GPSSA_OLD', 36000, rules)!;
    expect(n(r.base)).toBe(36000);
    expect(n(r.employee)).toBe(1800);
    expect(n(r.employer)).toBe(5400);
    expect(n(r.subsidy)).toBe(0);
  });

  it('GPSSA new scheme: 11% employee', () => {
    const r = computePension('GPSSA_NEW', 36000, rules)!;
    expect(n(r.employee)).toBe(3960);
    expect(n(r.employer)).toBe(5400);
  });

  it('applies the per-scheme cap to the contribution salary', () => {
    expect(n(computePension('GPSSA_OLD', 60000, rules)!.base)).toBe(50000);
    expect(n(computePension('GPSSA_OLD', 60000, rules)!.employee)).toBe(2500);
    expect(n(computePension('GPSSA_NEW', 90000, rules)!.base)).toBe(70000);
    expect(n(computePension('GPSSA_NEW', 90000, rules)!.employee)).toBe(7700);
    expect(n(computePension('ADPF_NEW', 120000, rules)!.base)).toBe(100000);
    expect(n(computePension('ADPF_NEW', 120000, rules)!.employee)).toBe(11000);
  });

  it('raises a contribution salary below the minimum base', () => {
    const r = computePension('GPSSA_OLD', 2500, rules)!;
    expect(n(r.base)).toBe(3000);
    expect(n(r.employee)).toBe(150);
  });

  it('GPSSA private sector under AED 20,000: employer pays 12.5% and the 2.5% subsidy is separate', () => {
    const r = computePension('GPSSA_OLD', 15000, rules)!;
    expect(r.employerRate).toBe(12.5);
    expect(r.subsidyRate).toBe(2.5);
    expect(n(r.employer)).toBe(1875);
    expect(n(r.subsidy)).toBe(375);
  });

  it('no subsidy at the threshold, for ADPF, or for public-sector employers', () => {
    expect(n(computePension('GPSSA_OLD', 20000, rules)!.subsidy)).toBe(0);
    const adpf = computePension('ADPF_OLD', 15000, rules)!;
    expect(n(adpf.subsidy)).toBe(0);
    expect(n(adpf.employer)).toBe(2250);
    const publicSector: PensionRules = { ...rules, privateSector: false };
    expect(n(computePension('GPSSA_OLD', 15000, publicSector)!.employer)).toBe(2250);
  });

  it('prorates a partial month', () => {
    expect(n(computePension('GPSSA_OLD', 36000, rules, 0.5)!.employee)).toBe(900);
  });

  it('merges partial stored rules over the UAE defaults', () => {
    const r = resolvePensionRules({ minBase: 3500, schemes: { GPSSA_OLD: { cap: 55000 } } });
    expect(r.minBase).toBe(3500);
    expect(r.schemes.GPSSA_OLD).toEqual({ employeeRate: 5, cap: 55000 });
    expect(r.schemes.GPSSA_NEW).toEqual(DEFAULT_PENSION_RULES.schemes.GPSSA_NEW);
    expect(resolvePensionRules(null)).toEqual(DEFAULT_PENSION_RULES);
  });
});

// ── Engine integration ──

const D = (v: number) => new Prisma.Decimal(v);
function component(p: Partial<PayComponent> & Pick<PayComponent, 'code' | 'type' | 'calcType'>): PayComponent {
  return {
    id: p.code, companyId: 'c', name: p.code, nameAr: null, defaultValue: null, brackets: null, bracketBase: null, minAmount: null, maxAmount: null,
    baseCap: null, isTaxable: true, pensionable: false, includeInRateBase: false, isRecurring: true, appliesToAll: false, eligibility: null, sortOrder: 100, isActive: true,
    createdAt: new Date(), updatedAt: new Date(), ...p,
  } as PayComponent;
}
const housing = component({ code: 'HOUSING', type: 'EARNING', calcType: 'FIXED', pensionable: true });
const transport = component({ code: 'TRANSPORT', type: 'EARNING', calcType: 'FIXED' });
const legacyEE = component({ code: 'PENSION_EE', type: 'DEDUCTION', calcType: 'PERCENT_OF_BASIC', defaultValue: D(5) as never, appliesToAll: true });
const legacyER = component({ code: 'PENSION_ER', type: 'EMPLOYER_CONTRIBUTION', calcType: 'PERCENT_OF_BASIC', defaultValue: D(12.5) as never, appliesToAll: true });

function input(over: Partial<PayrollInput> = {}): PayrollInput {
  return {
    settings: {
      dailyRateBasis: 'FIXED_30', rateBase: 'BASIC', standardHoursPerDay: D(8), overtimeMultiplier: D(1.25), weekendOvertimeMultiplier: D(1.5), holidayOvertimeMultiplier: D(2),
      nightOvertimeMultiplier: D(1.5), deductUnpaidLeave: true, deductAbsence: true, deductLateMinutes: false, lateDeductionGraceMinutesPerMonth: 0, prorateNewJoiners: true, roundingDecimals: 2,
    },
    periodDays: 30,
    periodWorkingDays: 22,
    // Fatima Al Zaabi in the demo: basic 27,000, housing 9,000, transport 1,500.
    segments: [{ days: 30, workingDays: 22, basicSalary: 27000, items: [{ component: housing, amount: 9000 }, { component: transport, amount: 1500 }] }],
    globalComponents: [],
    unpaidLeaveDays: 0,
    absentDays: 0,
    lateMinutes: 0,
    overtime: { normalMinutes: 0, weekendMinutes: 0, holidayMinutes: 0, nightMinutes: 0 },
    adjustments: [],
    pension: { scheme: 'GPSSA_OLD', rules },
    ...over,
  };
}
const line = (r: ReturnType<typeof calculatePayslip>, code: string) => r.lines.find((l) => l.componentCode === code);

describe('pension in the payroll engine', () => {
  it('uses basic + pensionable allowances (not basic only, not transport)', () => {
    const r = calculatePayslip(input());
    expect(line(r, 'PENSION_EE')!.amount.toNumber()).toBe(1800); // 5% × 36,000 (was 1,350 on basic only)
    expect(line(r, 'PENSION_EE')!.quantity).toBe(36000);
    expect(line(r, 'PENSION_ER')!.amount.toNumber()).toBe(5400);
    expect(r.netPay.toNumber()).toBe(37500 - 1800);
  });

  it('excludes overtime and one-off earnings from the contribution salary', () => {
    const r = calculatePayslip(input({ overtime: { normalMinutes: 600, weekendMinutes: 0, holidayMinutes: 0, nightMinutes: 0 }, adjustments: [{ type: 'EARNING', code: 'BONUS', description: 'Bonus', amount: 5000 }] }));
    expect(line(r, 'OT_NORMAL')).toBeDefined();
    expect(line(r, 'PENSION_EE')!.amount.toNumber()).toBe(1800);
  });

  it('never applies the legacy pension components on top of the statutory engine', () => {
    const r = calculatePayslip(input({ globalComponents: [legacyEE, legacyER] }));
    expect(r.lines.filter((l) => l.componentCode === 'PENSION_EE')).toHaveLength(1);
    expect(r.lines.filter((l) => l.componentCode === 'PENSION_ER')).toHaveLength(1);
    expect(line(r, 'PENSION_EE')!.amount.toNumber()).toBe(1800);
  });

  it('keeps legacy components for employees without a scheme', () => {
    const r = calculatePayslip(input({ globalComponents: [legacyEE], pension: { scheme: 'NONE', rules } }));
    expect(line(r, 'PENSION_EE')!.amount.toNumber()).toBe(1350);
  });

  it('shows the government subsidy as an information line excluded from every total', () => {
    const r = calculatePayslip(input({ segments: [{ days: 30, workingDays: 22, basicSalary: 9000, items: [{ component: housing, amount: 3000 }] }] }));
    const sub = line(r, 'PENSION_SUBSIDY')!;
    expect(sub.type).toBe('INFORMATION');
    expect(sub.amount.toNumber()).toBe(300); // 2.5% × 12,000
    expect(line(r, 'PENSION_ER')!.amount.toNumber()).toBe(1500); // 12.5% × 12,000
    expect(r.employerContributions.toNumber()).toBe(1500);
    expect(r.employerCost.toNumber()).toBe(12000 + 1500);
    expect(r.totalDeductions.toNumber()).toBe(600);
  });
});
