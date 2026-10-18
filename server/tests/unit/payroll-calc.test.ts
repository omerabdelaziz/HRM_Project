import { describe, expect, it } from 'vitest';
import { Prisma, type PayComponent } from '@prisma/client';
import { applyBrackets, calculatePayslip, isEligible, PayrollInput } from '../../src/modules/payroll/calc';

const D = (n: number) => new Prisma.Decimal(n);

function component(p: Partial<PayComponent> & Pick<PayComponent, 'code' | 'type' | 'calcType'>): PayComponent {
  return {
    id: p.code, companyId: 'c', name: p.code, nameAr: null, defaultValue: null, brackets: null, bracketBase: null, minAmount: null, maxAmount: null,
    baseCap: null, isTaxable: true, includeInRateBase: false, isRecurring: true, appliesToAll: false, eligibility: null, sortOrder: 100, isActive: true,
    createdAt: new Date(), updatedAt: new Date(), ...p,
  } as PayComponent;
}

const housing = component({ code: 'HOUSING', type: 'EARNING', calcType: 'FIXED' });
const settings: PayrollInput['settings'] = {
  dailyRateBasis: 'FIXED_30', rateBase: 'BASIC', standardHoursPerDay: D(8), overtimeMultiplier: D(1.25), weekendOvertimeMultiplier: D(1.5), holidayOvertimeMultiplier: D(2),
  deductUnpaidLeave: true, deductAbsence: true, deductLateMinutes: false, lateDeductionGraceMinutesPerMonth: 0, prorateNewJoiners: true, roundingDecimals: 2,
};

function input(over: Partial<PayrollInput> = {}): PayrollInput {
  return {
    settings,
    periodDays: 31,
    periodWorkingDays: 22,
    segments: [{ days: 31, workingDays: 22, basicSalary: 9000, items: [{ component: housing, amount: 3000 }] }],
    globalComponents: [],
    unpaidLeaveDays: 0,
    absentDays: 0,
    lateMinutes: 0,
    overtime: { normalMinutes: 0, weekendMinutes: 0, holidayMinutes: 0 },
    adjustments: [],
    ...over,
  };
}

const line = (r: ReturnType<typeof calculatePayslip>, code: string) => r.lines.find((l) => l.componentCode === code);

describe('payroll calculation', () => {
  it('full month pays the full structure', () => {
    const r = calculatePayslip(input());
    expect(r.grossEarnings.toNumber()).toBe(12000);
    expect(r.netPay.toNumber()).toBe(12000);
    expect(r.dailyRate.toNumber()).toBe(300);
    expect(r.hourlyRate.toNumber()).toBe(37.5);
  });

  it('prorates a mid-month joiner per day out of 30 (FIXED_30)', () => {
    const r = calculatePayslip(input({ segments: [{ days: 16, workingDays: 12, basicSalary: 9000, items: [{ component: housing, amount: 3000 }] }] }));
    expect(line(r, 'BASIC')!.amount.toNumber()).toBe(4800); // 9000 × 16/30
    expect(line(r, 'HOUSING')!.amount.toNumber()).toBe(1600);
  });

  it('prorates by calendar days and by working days when configured', () => {
    const seg = [{ days: 10, workingDays: 8, basicSalary: 9300, items: [] }];
    expect(calculatePayslip(input({ settings: { ...settings, dailyRateBasis: 'CALENDAR_DAYS' }, segments: seg })).basicSalary.toNumber()).toBe(3000);
    expect(calculatePayslip(input({ settings: { ...settings, dailyRateBasis: 'WORKING_DAYS' }, segments: seg })).basicSalary.toNumber()).toBe(3381.82);
  });

  it('a salary change mid-month splits the month without overpaying', () => {
    const r = calculatePayslip(input({
      segments: [
        { days: 15, workingDays: 11, basicSalary: 9000, items: [] },
        { days: 16, workingDays: 11, basicSalary: 12000, items: [] },
      ],
    }));
    // 9000×15/31 + 12000×16/31
    expect(r.basicSalary.toNumber()).toBeCloseTo(4354.84 + 6193.55, 1);
    expect(r.basicSalary.toNumber()).toBeLessThan(12000);
  });

  it('does not prorate joiners when proration is disabled', () => {
    const r = calculatePayslip(input({ settings: { ...settings, prorateNewJoiners: false }, segments: [{ days: 10, workingDays: 8, basicSalary: 9000, items: [] }] }));
    expect(r.basicSalary.toNumber()).toBe(9000);
  });

  it('deducts unpaid leave and absence at the daily rate', () => {
    const r = calculatePayslip(input({ unpaidLeaveDays: 2, absentDays: 1 }));
    expect(line(r, 'UNPAID_LEAVE')!.amount.toNumber()).toBe(600);
    expect(line(r, 'ABSENCE')!.amount.toNumber()).toBe(300);
    expect(r.netPay.toNumber()).toBe(11100);
    expect(r.payableDays).toBe(28);
  });

  it('respects switches that disable attendance deductions', () => {
    const r = calculatePayslip(input({ settings: { ...settings, deductUnpaidLeave: false, deductAbsence: false }, unpaidLeaveDays: 2, absentDays: 1 }));
    expect(r.netPay.toNumber()).toBe(12000);
  });

  it('pays overtime with the configured multipliers', () => {
    const r = calculatePayslip(input({ overtime: { normalMinutes: 120, weekendMinutes: 60, holidayMinutes: 30 } }));
    expect(line(r, 'OT_NORMAL')!.amount.toNumber()).toBe(93.75); // 2h × 37.5 × 1.25
    expect(line(r, 'OT_WEEKEND')!.amount.toNumber()).toBe(56.25); // 1h × 37.5 × 1.5
    expect(line(r, 'OT_HOLIDAY')!.amount.toNumber()).toBe(37.5); // 0.5h × 37.5 × 2
  });

  it('can use gross (basic + flagged allowances) as the rate base', () => {
    const h = component({ code: 'HOUSING', type: 'EARNING', calcType: 'FIXED', includeInRateBase: true });
    const r = calculatePayslip(input({ settings: { ...settings, rateBase: 'GROSS' }, segments: [{ days: 31, workingDays: 22, basicSalary: 9000, items: [{ component: h, amount: 3000 }] }] }));
    expect(r.dailyRate.toNumber()).toBe(400);
  });

  it('late deduction after monthly grace', () => {
    const r = calculatePayslip(input({ settings: { ...settings, deductLateMinutes: true, lateDeductionGraceMinutesPerMonth: 30 }, lateMinutes: 90 }));
    expect(line(r, 'LATE')!.amount.toNumber()).toBe(37.5); // 1h chargeable
  });

  it('applies statutory percentages with base cap, eligibility and employer contributions', () => {
    const pensionEe = component({ code: 'PENSION_EE', type: 'DEDUCTION', calcType: 'PERCENT_OF_BASIC', defaultValue: D(5) as never, baseCap: D(5000) as never, appliesToAll: true });
    const pensionEr = component({ code: 'PENSION_ER', type: 'EMPLOYER_CONTRIBUTION', calcType: 'PERCENT_OF_BASIC', defaultValue: D(12.5) as never, appliesToAll: true });
    const r = calculatePayslip(input({ globalComponents: [pensionEe, pensionEr] }));
    expect(line(r, 'PENSION_EE')!.amount.toNumber()).toBe(250); // 5% of capped 5000
    expect(line(r, 'PENSION_ER')!.amount.toNumber()).toBe(1125);
    expect(r.netPay.toNumber()).toBe(11750);
    expect(r.employerCost.toNumber()).toBe(13125);
  });

  it('percent of gross uses gross after attendance deductions; min/max clamp', () => {
    const ins = component({ code: 'INS', type: 'DEDUCTION', calcType: 'PERCENT_OF_GROSS', defaultValue: D(10) as never, appliesToAll: true, maxAmount: D(1000) as never });
    const r = calculatePayslip(input({ globalComponents: [ins], absentDays: 1 }));
    expect(line(r, 'INS')!.amount.toNumber()).toBe(1000); // 10% of 11700 = 1170 → max 1000
  });

  it('progressive brackets tax each band separately', () => {
    const brackets = [{ upTo: 1000, rate: 0 }, { upTo: 3000, rate: 10 }, { upTo: null, rate: 20 }];
    expect(applyBrackets(D(800), brackets).toNumber()).toBe(0);
    expect(applyBrackets(D(2000), brackets).toNumber()).toBe(100);
    expect(applyBrackets(D(5000), brackets).toNumber()).toBe(200 + 400);
    const tax = component({ code: 'TAX', type: 'DEDUCTION', calcType: 'BRACKET', bracketBase: 'TAXABLE', brackets: brackets as never, appliesToAll: true });
    const nonTaxable = component({ code: 'HOUSING', type: 'EARNING', calcType: 'FIXED', isTaxable: false });
    const r = calculatePayslip(input({ globalComponents: [tax], segments: [{ days: 31, workingDays: 22, basicSalary: 9000, items: [{ component: nonTaxable, amount: 3000 }] }] }));
    // Taxable = basic only (9000): 0 + 200 + 1200
    expect(line(r, 'TAX')!.amount.toNumber()).toBe(1400);
  });

  it('includes adjustments and flags negative net pay', () => {
    const r = calculatePayslip(input({ adjustments: [{ type: 'EARNING', code: 'BONUS', description: 'Bonus', amount: 500 }, { type: 'DEDUCTION', code: 'ADV', description: 'Advance', amount: 13000 }] }));
    expect(r.grossEarnings.toNumber()).toBe(12500);
    expect(r.netPay.toNumber()).toBe(-500);
    expect(r.warnings[0]).toMatch(/negative/i);
  });

  it('gross minus deductions always equals net, and lines sum to totals', () => {
    const pension = component({ code: 'P', type: 'DEDUCTION', calcType: 'PERCENT_OF_BASIC', defaultValue: D(7.33) as never, appliesToAll: true });
    const r = calculatePayslip(input({ globalComponents: [pension], unpaidLeaveDays: 1.5, overtime: { normalMinutes: 77, weekendMinutes: 0, holidayMinutes: 0 } }));
    const earn = r.lines.filter((l) => l.type === 'EARNING').reduce((a, l) => a.plus(l.amount), D(0));
    const ded = r.lines.filter((l) => l.type === 'DEDUCTION').reduce((a, l) => a.plus(l.amount), D(0));
    expect(earn.toNumber()).toBe(r.grossEarnings.toNumber());
    expect(ded.toNumber()).toBe(r.totalDeductions.toNumber());
    expect(r.grossEarnings.minus(r.totalDeductions).toNumber()).toBe(r.netPay.toNumber());
  });

  it('eligibility rules', () => {
    const c = component({ code: 'X', type: 'DEDUCTION', calcType: 'FIXED', eligibility: { nationalities: ['AE'], categoryCodes: ['NATIONAL'] } as never });
    expect(isEligible(c, { nationality: 'AE', categoryCode: 'NATIONAL' })).toBe(true);
    expect(isEligible(c, { nationality: 'IN', categoryCode: 'NATIONAL' })).toBe(false);
    expect(isEligible(component({ code: 'Y', type: 'EARNING', calcType: 'FIXED' }), {})).toBe(true);
  });

  it('refuses to calculate without a salary structure', () => {
    expect(() => calculatePayslip(input({ segments: [] }))).toThrow(/salary structure/);
  });
});
