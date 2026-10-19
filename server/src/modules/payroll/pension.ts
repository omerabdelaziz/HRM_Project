import { z } from 'zod';
import { Prisma } from '@prisma/client';
import type { PensionScheme } from '@prisma/client';

const D = (v: Prisma.Decimal.Value) => new Prisma.Decimal(v);

export const PENSION_SCHEMES = ['NONE', 'GPSSA_OLD', 'GPSSA_NEW', 'ADPF_OLD', 'ADPF_NEW'] as const;
/** Component codes produced by the statutory engine; legacy components with these codes are never applied twice. */
export const PENSION_CODES = ['PENSION_EE', 'PENSION_ER', 'PENSION_SUBSIDY'] as const;

const schemeRule = z.object({
  /** Employee share, % of contribution salary. */
  employeeRate: z.number().min(0).max(100),
  /** Monthly contribution salary cap (AED); null = no cap. */
  cap: z.number().positive().nullable(),
});

/**
 * Configurable statutory pension rules (UAE defaults). Stored in PayrollSettings.pensionRules;
 * a missing value falls back to the default, so partial updates are safe.
 */
export const pensionRulesSchema = z.object({
  /** Contribution salary below this is raised to it. */
  minBase: z.number().min(0),
  /** Employer share, % of contribution salary, before any government subsidy. */
  employerRate: z.number().min(0).max(100),
  /** The government subsidy only applies to private-sector employers. */
  privateSector: z.boolean(),
  /** Part of the employer share paid by the government (GPSSA schemes only). */
  subsidyRate: z.number().min(0).max(100),
  /** The subsidy applies while the contribution salary is below this amount. */
  subsidyThreshold: z.number().min(0),
  schemes: z.object({ GPSSA_OLD: schemeRule, GPSSA_NEW: schemeRule, ADPF_OLD: schemeRule, ADPF_NEW: schemeRule }),
});
export type PensionRules = z.infer<typeof pensionRulesSchema>;

export const DEFAULT_PENSION_RULES: PensionRules = {
  minBase: 3000,
  employerRate: 15,
  privateSector: true,
  subsidyRate: 2.5,
  subsidyThreshold: 20000,
  schemes: {
    GPSSA_OLD: { employeeRate: 5, cap: 50000 },
    GPSSA_NEW: { employeeRate: 11, cap: 70000 },
    ADPF_OLD: { employeeRate: 5, cap: 50000 },
    ADPF_NEW: { employeeRate: 11, cap: 100000 },
  },
};

/** Merges stored (possibly partial or legacy) rules over the defaults. */
export function resolvePensionRules(stored: unknown): PensionRules {
  const s = (stored && typeof stored === 'object' ? stored : {}) as Partial<PensionRules>;
  const merged = {
    ...DEFAULT_PENSION_RULES,
    ...s,
    schemes: {
      GPSSA_OLD: { ...DEFAULT_PENSION_RULES.schemes.GPSSA_OLD, ...s.schemes?.GPSSA_OLD },
      GPSSA_NEW: { ...DEFAULT_PENSION_RULES.schemes.GPSSA_NEW, ...s.schemes?.GPSSA_NEW },
      ADPF_OLD: { ...DEFAULT_PENSION_RULES.schemes.ADPF_OLD, ...s.schemes?.ADPF_OLD },
      ADPF_NEW: { ...DEFAULT_PENSION_RULES.schemes.ADPF_NEW, ...s.schemes?.ADPF_NEW },
    },
  };
  const parsed = pensionRulesSchema.safeParse(merged);
  return parsed.success ? parsed.data : DEFAULT_PENSION_RULES;
}

export interface PensionResult {
  /** Monthly contribution salary after the minimum and the cap. */
  base: Prisma.Decimal;
  employeeRate: number;
  /** Employer rate actually charged (after the subsidy). */
  employerRate: number;
  subsidyRate: number;
  employee: Prisma.Decimal;
  employer: Prisma.Decimal;
  /** Paid by the government on the employer's behalf; informational on the payslip. */
  subsidy: Prisma.Decimal;
}

/**
 * Statutory pension for one month.
 * @param contributionSalary monthly basic + pensionable fixed allowances (overtime, bonuses and variable pay excluded)
 * @param factor proration of the month actually employed (1 for a full month)
 */
export function computePension(scheme: PensionScheme, contributionSalary: Prisma.Decimal.Value, rules: PensionRules, factor: Prisma.Decimal.Value = 1): PensionResult | null {
  if (scheme === 'NONE') return null;
  const rule = rules.schemes[scheme];
  let base = Prisma.Decimal.max(D(contributionSalary), D(rules.minBase));
  if (rule.cap !== null) base = Prisma.Decimal.min(base, D(rule.cap));

  const isGpssa = scheme === 'GPSSA_OLD' || scheme === 'GPSSA_NEW';
  const subsidised = isGpssa && rules.privateSector && rules.subsidyRate > 0 && base.lt(rules.subsidyThreshold);
  const subsidyRate = subsidised ? Math.min(rules.subsidyRate, rules.employerRate) : 0;
  const employerRate = rules.employerRate - subsidyRate;

  const f = D(factor);
  const pct = (rate: number) => base.times(rate).div(100).times(f);
  return {
    base,
    employeeRate: rule.employeeRate,
    employerRate,
    subsidyRate,
    employee: pct(rule.employeeRate),
    employer: pct(employerRate),
    subsidy: pct(subsidyRate),
  };
}
