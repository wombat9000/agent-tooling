export type EmploymentType =
  | 'full_time'
  | 'part_time'
  | 'contractor'
  | 'probation'
  | 'sabbatical';

export type UnpaidLeaveRule = 'prorate' | 'cancel_on_any' | 'ignore';

export interface TenureBonusTier {
  readonly minTenureMonths: number;
  readonly bonusHours: number;
}

export interface AccrualPolicy {
  readonly minEligibilityTenureMonths: number;
  readonly baseMonthlyHours: number;
  readonly tenureBonusTiers: ReadonlyArray<TenureBonusTier>;
  readonly unpaidLeaveRule: UnpaidLeaveRule;
  readonly monthlyBalanceCapHours: number;
  readonly yearEndCarryoverCapHours: number;
  readonly allowsCarryoverWhenEligible: boolean;
}

const WORKDAYS_PER_MONTH = 20;
const QUARTER_HOURS_PER_HOUR = 4;

const ACCRUAL_POLICIES: Readonly<Record<EmploymentType, AccrualPolicy>> = {
  full_time: {
    minEligibilityTenureMonths: 0,
    baseMonthlyHours: 12,
    tenureBonusTiers: [
      { minTenureMonths: 60, bonusHours: 4 },
      { minTenureMonths: 24, bonusHours: 2 },
    ],
    unpaidLeaveRule: 'prorate',
    monthlyBalanceCapHours: 240,
    yearEndCarryoverCapHours: 160,
    allowsCarryoverWhenEligible: true,
  },
  part_time: {
    minEligibilityTenureMonths: 0,
    baseMonthlyHours: 6,
    tenureBonusTiers: [{ minTenureMonths: 36, bonusHours: 2 }],
    unpaidLeaveRule: 'prorate',
    monthlyBalanceCapHours: 120,
    yearEndCarryoverCapHours: 80,
    allowsCarryoverWhenEligible: true,
  },
  contractor: {
    minEligibilityTenureMonths: 0,
    baseMonthlyHours: 0,
    tenureBonusTiers: [],
    unpaidLeaveRule: 'ignore',
    monthlyBalanceCapHours: 0,
    yearEndCarryoverCapHours: 0,
    allowsCarryoverWhenEligible: false,
  },
  probation: {
    minEligibilityTenureMonths: 0,
    baseMonthlyHours: 4,
    tenureBonusTiers: [],
    unpaidLeaveRule: 'cancel_on_any',
    monthlyBalanceCapHours: 40,
    yearEndCarryoverCapHours: 0,
    allowsCarryoverWhenEligible: false,
  },
  sabbatical: {
    minEligibilityTenureMonths: 36,
    baseMonthlyHours: 3,
    tenureBonusTiers: [],
    unpaidLeaveRule: 'ignore',
    monthlyBalanceCapHours: 160,
    yearEndCarryoverCapHours: 120,
    allowsCarryoverWhenEligible: true,
  },
};

function roundToQuarterHour(hours: number): number {
  return Math.round(hours * QUARTER_HOURS_PER_HOUR) / QUARTER_HOURS_PER_HOUR;
}

function clampWorkdays(days: number): number {
  return Math.min(WORKDAYS_PER_MONTH, Math.max(0, days));
}

export function parseEmploymentType(value: string): EmploymentType {
  if (!Object.hasOwn(ACCRUAL_POLICIES, value)) {
    throw new Error(`Unsupported employment type: ${value}`);
  }
  return value as EmploymentType;
}

export function policyForEmploymentType(employmentType: EmploymentType): AccrualPolicy {
  return ACCRUAL_POLICIES[employmentType];
}

export function isPolicyEligible(policy: AccrualPolicy, tenureMonths: number): boolean {
  return tenureMonths >= policy.minEligibilityTenureMonths;
}

export function resolveTenureBonusHours(policy: AccrualPolicy, tenureMonths: number): number {
  const matchedTier = policy.tenureBonusTiers.find((tier) => tenureMonths >= tier.minTenureMonths);
  return matchedTier ? matchedTier.bonusHours : 0;
}

export function applyUnpaidLeaveRule(
  policy: AccrualPolicy,
  grossHours: number,
  unpaidLeaveDays: number,
): number {
  switch (policy.unpaidLeaveRule) {
    case 'prorate': {
      const workedDays = WORKDAYS_PER_MONTH - clampWorkdays(unpaidLeaveDays);
      return roundToQuarterHour((grossHours * workedDays) / WORKDAYS_PER_MONTH);
    }
    case 'cancel_on_any':
      return unpaidLeaveDays > 0 ? 0 : grossHours;
    case 'ignore':
      return grossHours;
  }
}
