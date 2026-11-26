import {
  applyUnpaidLeaveRule,
  isPolicyEligible,
  policyForEmploymentType,
  resolveTenureBonusHours,
  type AccrualPolicy,
} from './accrual-policy.ts';
import { createEmployeeLeaveRecord, type EmployeeLeaveRecord } from './employee-leave.ts';

export interface EmployeeLeaveInput {
  employeeId: string;
  employmentType: string;
  tenureMonths: number;
  currentBalanceHours: number;
  unpaidLeaveDaysThisMonth: number;
  onParentalLeave?: boolean;
  isYearEnd?: boolean;
}

export interface LeaveAccrualResult {
  employeeId: string;
  employmentType: string;
  accruedHours: number;
  forfeitedHours: number;
  endingBalanceHours: number;
  eligibleForCarryover: boolean;
}

interface AccrualEvaluationContext {
  readonly record: EmployeeLeaveRecord;
  readonly policy: AccrualPolicy;
  readonly eligible: boolean;
  readonly eligibleForCarryover: boolean;
}

function calculateAccruedHours(context: AccrualEvaluationContext): number {
  const { record, policy, eligible } = context;
  if (record.leaveStatus === 'parental_leave' || !eligible) {
    return 0;
  }
  const grossMonthlyHours =
    policy.baseMonthlyHours + resolveTenureBonusHours(policy, record.tenureMonths);
  if (grossMonthlyHours === 0) {
    return 0;
  }
  return applyUnpaidLeaveRule(policy, grossMonthlyHours, record.unpaidLeaveDaysThisMonth);
}

function resolveActiveBalanceCap(context: AccrualEvaluationContext): number {
  const { record, policy, eligibleForCarryover } = context;
  if (record.accrualPeriod === 'monthly') {
    return policy.monthlyBalanceCapHours;
  }
  return eligibleForCarryover ? policy.yearEndCarryoverCapHours : 0;
}

function calculateEmployeeAccrual(record: EmployeeLeaveRecord): LeaveAccrualResult {
  const policy = policyForEmploymentType(record.employmentType);
  const eligible = isPolicyEligible(policy, record.tenureMonths);
  const eligibleForCarryover = eligible && policy.allowsCarryoverWhenEligible;
  const context: AccrualEvaluationContext = { record, policy, eligible, eligibleForCarryover };

  const accruedHours = calculateAccruedHours(context);
  const rawBalanceHours = record.currentBalanceHours + accruedHours;
  const activeCapHours = resolveActiveBalanceCap(context);
  const endingBalanceHours = Math.min(rawBalanceHours, activeCapHours);
  const forfeitedHours = Math.max(0, rawBalanceHours - endingBalanceHours);

  return {
    employeeId: record.employeeId,
    employmentType: record.employmentType,
    accruedHours,
    forfeitedHours,
    endingBalanceHours,
    eligibleForCarryover,
  };
}

export function calculateMonthlyAccruals(employees: EmployeeLeaveInput[]): LeaveAccrualResult[] {
  return employees.map((input) => calculateEmployeeAccrual(createEmployeeLeaveRecord(input)));
}
