/**
 * Public API contract for employee benefit accrual calculations.
 */
export interface BenefitAccrualInput {
  readonly employeeId: string;
  readonly planTier: string;
  readonly baseHoursWorked: number;
  readonly tenureMonths: number;
  readonly onExtendedLeave?: boolean;
  readonly isFiscalYearEnd?: boolean;
}

export interface BenefitAccrualResult {
  readonly employeeId: string;
  readonly planTier: string;
  readonly accruedHours: number;
  readonly carryoverCapHours: number;
  readonly capped: boolean;
}
