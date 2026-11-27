import type { BenefitAccrualInput, BenefitAccrualResult } from './benefit-contract';
import {
  EXTENDED_LEAVE_MULTIPLIER,
  FISCAL_YEAR_END_BONUS_HOURS,
  parsePlanTier,
  resolveTierPolicy,
} from './benefit-policy';

function roundHours(hours: number): number {
  return Math.round(hours * 100) / 100;
}

function accrueForEmployee(input: BenefitAccrualInput): BenefitAccrualResult {
  const tier = parsePlanTier(input.planTier);
  const policy = resolveTierPolicy(tier);

  let hours = Math.max(0, input.baseHoursWorked) * policy.accrualRatePerHour;
  if (input.tenureMonths >= policy.longevityThresholdMonths) {
    hours += policy.longevityBonusHours;
  }
  if (input.onExtendedLeave) {
    hours *= EXTENDED_LEAVE_MULTIPLIER;
  }
  if (input.isFiscalYearEnd) {
    hours += FISCAL_YEAR_END_BONUS_HOURS;
  }

  const rounded = roundHours(hours);
  const capped = rounded > policy.carryoverCapHours;

  return {
    employeeId: input.employeeId,
    planTier: tier,
    accruedHours: capped ? policy.carryoverCapHours : rounded,
    carryoverCapHours: policy.carryoverCapHours,
    capped,
  };
}

export function calculateBenefitAccruals(
  inputs: readonly BenefitAccrualInput[],
): BenefitAccrualResult[] {
  return inputs.map((input) => accrueForEmployee(input));
}
