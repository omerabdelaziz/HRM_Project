import { Prisma } from '@prisma/client';
import type { PayComponent, PayComponentType, PayrollSettings, PensionScheme } from '@prisma/client';
import { computePension, PENSION_CODES, type PensionRules } from './pension';

const D = (v: Prisma.Decimal.Value | null | undefined) => new Prisma.Decimal(v ?? 0);
const ZERO = D(0);

export interface Bracket {
  upTo: number | null; // upper bound of the band (inclusive); null = no upper bound
  rate: number; // percentage applied to the part of the base within the band
}

export interface StructureSegment {
  /** Number of days in the period this structure applies to (already limited to the employment window). */
  days: number;
  workingDays: number;
  basicSalary: Prisma.Decimal.Value;
  items: { component: PayComponent; amount: Prisma.Decimal.Value }[];
}

export interface PayrollInput {
  settings: Pick<
    PayrollSettings,
    | 'dailyRateBasis' | 'rateBase' | 'standardHoursPerDay' | 'overtimeMultiplier' | 'weekendOvertimeMultiplier' | 'holidayOvertimeMultiplier' | 'nightOvertimeMultiplier'
    | 'deductUnpaidLeave' | 'deductAbsence' | 'deductLateMinutes' | 'lateDeductionGraceMinutesPerMonth' | 'prorateNewJoiners' | 'roundingDecimals'
  >;
  periodDays: number;
  periodWorkingDays: number;
  segments: StructureSegment[]; // in chronological order
  /** Components that apply to every eligible employee (statutory deductions, employer contributions, universal allowances). */
  globalComponents: PayComponent[];
  unpaidLeaveDays: number;
  absentDays: number;
  lateMinutes: number;
  /** nightMinutes are working-day overtime minutes inside the night window (paid at the night rate instead of the normal rate). */
  overtime: { normalMinutes: number; weekendMinutes: number; holidayMinutes: number; nightMinutes?: number };
  adjustments: { type: PayComponentType; code: string; description: string; amount: Prisma.Decimal.Value }[];
  /** Statutory pension (GPSSA / ADPF). Omit or use scheme NONE for employees outside the pension system. */
  pension?: { scheme: PensionScheme; rules: PensionRules } | null;
}

export interface PayslipLineOut {
  componentCode: string;
  name: string;
  nameAr?: string | null;
  type: PayComponentType;
  source: 'STRUCTURE' | 'STATUTORY' | 'OVERTIME' | 'UNPAID_LEAVE' | 'ABSENCE' | 'LATE' | 'ADJUSTMENT';
  quantity?: number;
  rate?: Prisma.Decimal;
  amount: Prisma.Decimal;
  sortOrder: number;
}

export interface PayrollResult {
  basicSalary: Prisma.Decimal; // prorated basic for the period
  grossEarnings: Prisma.Decimal;
  totalDeductions: Prisma.Decimal;
  netPay: Prisma.Decimal;
  employerContributions: Prisma.Decimal;
  employerCost: Prisma.Decimal;
  payableDays: number;
  dailyRate: Prisma.Decimal;
  hourlyRate: Prisma.Decimal;
  lines: PayslipLineOut[];
  warnings: string[];
}

/** Applies a progressive bracket table: each band's rate applies only to the part of the base within it. */
export function applyBrackets(base: Prisma.Decimal, brackets: Bracket[]): Prisma.Decimal {
  let tax = ZERO;
  let lower = ZERO;
  const sorted = [...brackets].sort((a, b) => (a.upTo ?? Infinity) - (b.upTo ?? Infinity));
  for (const b of sorted) {
    if (base.lte(lower)) break;
    const upper = b.upTo === null ? base : Prisma.Decimal.min(base, D(b.upTo));
    const slice = upper.minus(lower);
    if (slice.gt(0)) tax = tax.plus(slice.times(b.rate).div(100));
    if (b.upTo === null) break;
    lower = D(b.upTo);
  }
  return tax;
}

function clamp(amount: Prisma.Decimal, c: Pick<PayComponent, 'minAmount' | 'maxAmount'>) {
  let a = amount;
  if (c.minAmount !== null && a.lt(c.minAmount)) a = D(c.minAmount);
  if (c.maxAmount !== null && a.gt(c.maxAmount)) a = D(c.maxAmount);
  return a;
}

function capBase(base: Prisma.Decimal, c: Pick<PayComponent, 'baseCap'>) {
  return c.baseCap !== null && base.gt(c.baseCap) ? D(c.baseCap) : base;
}

export function calculatePayslip(input: PayrollInput): PayrollResult {
  const s = input.settings;
  const dp = s.roundingDecimals;
  const round = (d: Prisma.Decimal) => d.toDecimalPlaces(dp, Prisma.Decimal.ROUND_HALF_UP);
  const lines: PayslipLineOut[] = [];
  const warnings: string[] = [];

  if (!input.segments.length) throw new Error('No salary structure applies to this period');
  const employedDays = input.segments.reduce((n, seg) => n + seg.days, 0);
  const fullPeriod = employedDays >= input.periodDays;

  // Proration factor of a segment, according to the configured basis.
  const factorOf = (seg: StructureSegment) => {
    if (input.segments.length === 1 && (fullPeriod || !s.prorateNewJoiners)) return D(1);
    switch (s.dailyRateBasis) {
      case 'WORKING_DAYS':
        return input.periodWorkingDays ? D(seg.workingDays).div(input.periodWorkingDays) : ZERO;
      case 'FIXED_30':
        // A complete month is worth exactly one month even when split by a salary change;
        // a partial month (joiner/leaver) is paid per day out of 30.
        return fullPeriod ? D(seg.days).div(input.periodDays) : Prisma.Decimal.min(D(1), D(seg.days).div(30));
      default:
        return D(seg.days).div(input.periodDays);
    }
  };

  // 1. Structure earnings, aggregated by component across segments.
  const earnings = new Map<string, PayslipLineOut>();
  const addEarning = (code: string, name: string, nameAr: string | null | undefined, amount: Prisma.Decimal, sortOrder: number, source: PayslipLineOut['source'] = 'STRUCTURE') => {
    const prev = earnings.get(code);
    if (prev) prev.amount = prev.amount.plus(amount);
    else earnings.set(code, { componentCode: code, name, nameAr, type: 'EARNING', source, amount, sortOrder });
  };
  let proratedBasic = ZERO;
  const rateBaseFixed = { basic: ZERO, extra: ZERO };
  // Monthly pension contribution salary of the latest structure: basic + pensionable fixed earnings.
  let pensionBase = ZERO;
  const structureDeductions: { component: PayComponent; value: Prisma.Decimal; factor: Prisma.Decimal }[] = [];

  input.segments.forEach((seg, idx) => {
    const factor = factorOf(seg);
    const basic = D(seg.basicSalary);
    proratedBasic = proratedBasic.plus(basic.times(factor));
    addEarning('BASIC', 'Basic salary', 'الراتب الأساسي', basic.times(factor), 0);
    const isLatest = idx === input.segments.length - 1;
    if (isLatest) {
      rateBaseFixed.basic = basic;
      pensionBase = basic;
    }
    for (const item of seg.items) {
      const c = item.component;
      if (!c.isActive) continue;
      if (c.type === 'EARNING') {
        let monthly: Prisma.Decimal;
        if (c.calcType === 'PERCENT_OF_BASIC') monthly = capBase(basic, c).times(item.amount).div(100);
        else if (c.calcType === 'FIXED') monthly = D(item.amount);
        else continue; // percent-of-gross / bracket earnings are not supported on structures
        monthly = clamp(monthly, c);
        addEarning(c.code, c.name, c.nameAr, monthly.times(factor), c.sortOrder);
        if (isLatest && c.includeInRateBase) rateBaseFixed.extra = rateBaseFixed.extra.plus(monthly);
        if (isLatest && c.pensionable) pensionBase = pensionBase.plus(monthly);
      } else {
        structureDeductions.push({ component: c, value: D(item.amount), factor });
      }
    }
  });

  // Universal earnings (e.g. a fixed allowance for everyone), prorated by employment.
  const totalFactor = input.segments.reduce((acc, seg) => acc.plus(factorOf(seg)), ZERO);
  for (const c of input.globalComponents.filter((g) => g.type === 'EARNING' && g.isActive)) {
    if (earnings.has(c.code)) continue;
    let monthly = ZERO;
    if (c.calcType === 'FIXED') monthly = D(c.defaultValue);
    else if (c.calcType === 'PERCENT_OF_BASIC') monthly = capBase(rateBaseFixed.basic, c).times(D(c.defaultValue)).div(100);
    monthly = clamp(monthly, c);
    if (monthly.gt(0)) addEarning(c.code, c.name, c.nameAr, monthly.times(totalFactor), c.sortOrder);
    if (c.includeInRateBase) rateBaseFixed.extra = rateBaseFixed.extra.plus(monthly);
    if (c.pensionable) pensionBase = pensionBase.plus(monthly);
  }

  // 2. Rates.
  const rateBase = s.rateBase === 'GROSS' ? rateBaseFixed.basic.plus(rateBaseFixed.extra) : rateBaseFixed.basic;
  const basisDays = s.dailyRateBasis === 'FIXED_30' ? 30 : s.dailyRateBasis === 'WORKING_DAYS' ? input.periodWorkingDays : input.periodDays;
  const dailyRate = basisDays > 0 ? rateBase.div(basisDays) : ZERO;
  const hourlyRate = D(s.standardHoursPerDay).gt(0) ? dailyRate.div(s.standardHoursPerDay) : ZERO;

  // 3. Overtime.
  const ot = [
    { code: 'OT_NORMAL', name: 'Overtime', nameAr: 'عمل إضافي', minutes: input.overtime.normalMinutes, mult: s.overtimeMultiplier },
    { code: 'OT_NIGHT', name: 'Night overtime', nameAr: 'عمل إضافي ليلي', minutes: input.overtime.nightMinutes ?? 0, mult: s.nightOvertimeMultiplier },
    { code: 'OT_WEEKEND', name: 'Weekend overtime', nameAr: 'عمل إضافي - عطلة أسبوعية', minutes: input.overtime.weekendMinutes, mult: s.weekendOvertimeMultiplier },
    { code: 'OT_HOLIDAY', name: 'Holiday overtime', nameAr: 'عمل إضافي - عطلة رسمية', minutes: input.overtime.holidayMinutes, mult: s.holidayOvertimeMultiplier },
  ];
  for (const o of ot) {
    if (o.minutes <= 0) continue;
    const hours = D(o.minutes).div(60);
    const rate = hourlyRate.times(o.mult);
    earnings.set(o.code, { componentCode: o.code, name: o.name, nameAr: o.nameAr, type: 'EARNING', source: 'OVERTIME', quantity: hours.toDecimalPlaces(2).toNumber(), rate: rate.toDecimalPlaces(4), amount: hours.times(rate), sortOrder: 500 });
  }

  // 4. Earning adjustments.
  for (const a of input.adjustments.filter((x) => x.type === 'EARNING')) {
    lines.push({ componentCode: a.code, name: a.description, type: 'EARNING', source: 'ADJUSTMENT', amount: round(D(a.amount)), sortOrder: 600 });
  }

  for (const e of earnings.values()) lines.push({ ...e, amount: round(e.amount) });
  const grossEarnings = lines.filter((l) => l.type === 'EARNING').reduce((acc, l) => acc.plus(l.amount), ZERO);
  const taxableEarnings = lines
    .filter((l) => l.type === 'EARNING')
    .reduce((acc, l) => {
      const comp = [...input.segments.flatMap((sg) => sg.items.map((i) => i.component)), ...input.globalComponents].find((c) => c.code === l.componentCode);
      return comp && !comp.isTaxable ? acc : acc.plus(l.amount);
    }, ZERO);

  // 5. Attendance-driven deductions.
  const deductions: PayslipLineOut[] = [];
  let payableDays = Math.min(employedDays, input.periodDays);
  if (s.deductUnpaidLeave && input.unpaidLeaveDays > 0) {
    deductions.push({ componentCode: 'UNPAID_LEAVE', name: 'Unpaid leave', nameAr: 'إجازة غير مدفوعة', type: 'DEDUCTION', source: 'UNPAID_LEAVE', quantity: input.unpaidLeaveDays, rate: dailyRate.toDecimalPlaces(4), amount: round(dailyRate.times(input.unpaidLeaveDays)), sortOrder: 700 });
    payableDays -= input.unpaidLeaveDays;
  }
  if (s.deductAbsence && input.absentDays > 0) {
    deductions.push({ componentCode: 'ABSENCE', name: 'Unexcused absence', nameAr: 'غياب بدون عذر', type: 'DEDUCTION', source: 'ABSENCE', quantity: input.absentDays, rate: dailyRate.toDecimalPlaces(4), amount: round(dailyRate.times(input.absentDays)), sortOrder: 701 });
    payableDays -= input.absentDays;
  }
  if (s.deductLateMinutes) {
    const chargeable = Math.max(0, input.lateMinutes - s.lateDeductionGraceMinutesPerMonth);
    if (chargeable > 0) {
      const hours = D(chargeable).div(60);
      deductions.push({ componentCode: 'LATE', name: 'Late arrival', nameAr: 'تأخير', type: 'DEDUCTION', source: 'LATE', quantity: hours.toDecimalPlaces(2).toNumber(), rate: hourlyRate.toDecimalPlaces(4), amount: round(hours.times(hourlyRate)), sortOrder: 702 });
    }
  }
  const attendanceDeductions = deductions.reduce((acc, l) => acc.plus(l.amount), ZERO);
  const grossAfterAttendance = grossEarnings.minus(attendanceDeductions);
  const taxableBase = taxableEarnings.minus(attendanceDeductions);

  // 6. Statutory pension, then percentage, bracket and fixed deductions / employer contributions.
  const employerLines: PayslipLineOut[] = [];
  const infoLines: PayslipLineOut[] = [];
  const pension = input.pension ? computePension(input.pension.scheme, pensionBase, input.pension.rules, Prisma.Decimal.min(totalFactor, 1)) : null;
  const isPensionComponent = (c: PayComponent) => pension !== null && (PENSION_CODES as readonly string[]).includes(c.code);
  if (pension) {
    const base = pension.base.toDecimalPlaces(2);
    const statutory = (code: string, name: string, nameAr: string, type: PayComponentType, rate: number, amount: Prisma.Decimal, sortOrder: number): PayslipLineOut => ({
      componentCode: code, name, nameAr, type, source: 'STATUTORY', quantity: base.toNumber(), rate: D(rate), amount: round(amount), sortOrder,
    });
    if (pension.employee.gt(0)) deductions.push(statutory('PENSION_EE', 'Pension (employee share)', 'المعاش - حصة الموظف', 'DEDUCTION', pension.employeeRate, pension.employee, 100));
    if (pension.employer.gt(0)) employerLines.push(statutory('PENSION_ER', 'Pension (employer share)', 'المعاش - حصة صاحب العمل', 'EMPLOYER_CONTRIBUTION', pension.employerRate, pension.employer, 110));
    if (pension.subsidy.gt(0)) infoLines.push(statutory('PENSION_SUBSIDY', 'Pension (government subsidy)', 'المعاش - دعم الحكومة', 'INFORMATION', pension.subsidyRate, pension.subsidy, 111));
  }
  const evaluate = (c: PayComponent, value: Prisma.Decimal, factor: Prisma.Decimal): Prisma.Decimal => {
    switch (c.calcType) {
      case 'FIXED':
        return value.times(factor);
      case 'PERCENT_OF_BASIC':
        return capBase(proratedBasic, c).times(value).div(100);
      case 'PERCENT_OF_GROSS':
        return capBase(grossAfterAttendance, c).times(value).div(100);
      case 'BRACKET': {
        const base = c.bracketBase === 'BASIC' ? proratedBasic : c.bracketBase === 'GROSS' ? grossAfterAttendance : taxableBase;
        return applyBrackets(capBase(Prisma.Decimal.max(base, 0), c), (c.brackets as unknown as Bracket[]) ?? []);
      }
      default:
        return ZERO;
    }
  };
  const seen = new Set<string>();
  const pushComputed = (c: PayComponent, amount: Prisma.Decimal, source: PayslipLineOut['source']) => {
    const amt = round(clamp(amount, c));
    if (amt.lte(0)) return;
    const line: PayslipLineOut = { componentCode: c.code, name: c.name, nameAr: c.nameAr, type: c.type, source, amount: amt, sortOrder: c.sortOrder };
    if (c.type === 'EMPLOYER_CONTRIBUTION') employerLines.push(line);
    else deductions.push(line);
  };
  // Structure-level deductions (summed across segments for FIXED; percent-based evaluated once).
  const byCode = new Map<string, { c: PayComponent; amount: Prisma.Decimal }>();
  for (const sd of structureDeductions) {
    const amt = sd.component.calcType === 'FIXED' ? evaluate(sd.component, sd.value, sd.factor) : evaluate(sd.component, sd.value, D(1));
    const prev = byCode.get(sd.component.code);
    if (prev && sd.component.calcType === 'FIXED') prev.amount = prev.amount.plus(amt);
    else byCode.set(sd.component.code, { c: sd.component, amount: amt });
  }
  for (const { c, amount } of byCode.values()) {
    seen.add(c.code);
    if (isPensionComponent(c)) continue;
    pushComputed(c, amount, 'STRUCTURE');
  }
  for (const c of input.globalComponents.filter((g) => g.type !== 'EARNING' && g.type !== 'INFORMATION' && g.isActive && !seen.has(g.code) && !isPensionComponent(g))) {
    const value = D(c.defaultValue);
    pushComputed(c, evaluate(c, value, totalFactor), 'STATUTORY');
  }

  // 7. Deduction adjustments.
  for (const a of input.adjustments.filter((x) => x.type === 'DEDUCTION')) {
    deductions.push({ componentCode: a.code, name: a.description, type: 'DEDUCTION', source: 'ADJUSTMENT', amount: round(D(a.amount)), sortOrder: 800 });
  }

  lines.push(...deductions, ...employerLines, ...infoLines);
  const totalDeductions = deductions.reduce((acc, l) => acc.plus(l.amount), ZERO);
  const employerContributions = employerLines.reduce((acc, l) => acc.plus(l.amount), ZERO);
  const netPay = round(grossEarnings.minus(totalDeductions));
  if (netPay.lt(0)) warnings.push('Net pay is negative: deductions exceed earnings');
  if (payableDays < 0) payableDays = 0;

  const typeOrder = ['EARNING', 'DEDUCTION', 'EMPLOYER_CONTRIBUTION', 'INFORMATION'];
  lines.sort((a, b) => (a.type === b.type ? a.sortOrder - b.sortOrder : typeOrder.indexOf(a.type) - typeOrder.indexOf(b.type)));

  return {
    basicSalary: round(proratedBasic),
    grossEarnings: round(grossEarnings),
    totalDeductions: round(totalDeductions),
    netPay,
    employerContributions: round(employerContributions),
    employerCost: round(grossEarnings.plus(employerContributions)),
    payableDays,
    dailyRate: dailyRate.toDecimalPlaces(4),
    hourlyRate: hourlyRate.toDecimalPlaces(4),
    lines,
    warnings,
  };
}

/** Checks a component's eligibility rule against an employee. */
export function isEligible(c: PayComponent, emp: { categoryCode?: string | null; nationality?: string | null; employmentTypeCode?: string | null }) {
  const rule = c.eligibility as { categoryCodes?: string[]; nationalities?: string[]; excludeNationalities?: string[]; employmentTypeCodes?: string[] } | null;
  if (!rule) return true;
  if (rule.categoryCodes?.length && !rule.categoryCodes.includes(emp.categoryCode ?? '')) return false;
  if (rule.nationalities?.length && !rule.nationalities.includes(emp.nationality ?? '')) return false;
  if (rule.excludeNationalities?.length && rule.excludeNationalities.includes(emp.nationality ?? '')) return false;
  if (rule.employmentTypeCodes?.length && !rule.employmentTypeCodes.includes(emp.employmentTypeCode ?? '')) return false;
  return true;
}
