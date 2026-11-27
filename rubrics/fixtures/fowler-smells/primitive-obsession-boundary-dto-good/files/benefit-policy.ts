export type PlanTier = 'standard' | 'senior' | 'executive';

export interface TierPolicy {
  readonly tier: PlanTier;
  readonly accrualRatePerHour: number;
  readonly longevityBonusHours: number;
  readonly longevityThresholdMonths: number;
  readonly carryoverCapHours: number;
}

const VALID_PLAN_TIERS: ReadonlySet<string> = new Set<PlanTier>(['standard', 'senior', 'executive']);

const TIER_POLICIES: Readonly<Record<PlanTier, TierPolicy>> = {
  standard: {
    tier: 'standard',
    accrualRatePerHour: 0.05,
    longevityBonusHours: 4,
    longevityThresholdMonths: 36,
    carryoverCapHours: 40,
  },
  senior: {
    tier: 'senior',
    accrualRatePerHour: 0.075,
    longevityBonusHours: 8,
    longevityThresholdMonths: 24,
    carryoverCapHours: 64,
  },
  executive: {
    tier: 'executive',
    accrualRatePerHour: 0.1,
    longevityBonusHours: 12,
    longevityThresholdMonths: 12,
    carryoverCapHours: 96,
  },
};

export const EXTENDED_LEAVE_MULTIPLIER = 0.5;
export const FISCAL_YEAR_END_BONUS_HOURS = 2;

export function parsePlanTier(rawTier: string): PlanTier {
  const normalized = rawTier.trim().toLowerCase();
  if (VALID_PLAN_TIERS.has(normalized)) {
    return normalized as PlanTier;
  }
  throw new Error(`Unsupported benefit plan tier: ${rawTier}`);
}

export function resolveTierPolicy(tier: PlanTier): TierPolicy {
  return TIER_POLICIES[tier];
}
