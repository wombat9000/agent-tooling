import { parseEmploymentType, type EmploymentType } from './accrual-policy.ts';

export type LeaveStatus = 'active' | 'parental_leave';
export type AccrualPeriod = 'monthly' | 'year_end';

export interface EmployeeLeaveRecord {
  readonly employeeId: string;
  readonly employmentType: EmploymentType;
  readonly tenureMonths: number;
  readonly currentBalanceHours: number;
  readonly unpaidLeaveDaysThisMonth: number;
  readonly leaveStatus: LeaveStatus;
  readonly accrualPeriod: AccrualPeriod;
}

export interface RawEmployeeLeaveFields {
  readonly employeeId: string;
  readonly employmentType: string;
  readonly tenureMonths: number;
  readonly currentBalanceHours: number;
  readonly unpaidLeaveDaysThisMonth: number;
  readonly onParentalLeave?: boolean;
  readonly isYearEnd?: boolean;
}

function assertNonNegativeFinite(value: number, fieldName: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`Employee ${fieldName} must be a non-negative finite number`);
  }
  return value;
}

export function createEmployeeLeaveRecord(input: RawEmployeeLeaveFields): EmployeeLeaveRecord {
  return {
    employeeId: input.employeeId,
    employmentType: parseEmploymentType(input.employmentType),
    tenureMonths: assertNonNegativeFinite(input.tenureMonths, 'tenureMonths'),
    currentBalanceHours: assertNonNegativeFinite(input.currentBalanceHours, 'currentBalanceHours'),
    unpaidLeaveDaysThisMonth: assertNonNegativeFinite(
      input.unpaidLeaveDaysThisMonth,
      'unpaidLeaveDaysThisMonth',
    ),
    leaveStatus: input.onParentalLeave === true ? 'parental_leave' : 'active',
    accrualPeriod: input.isYearEnd === true ? 'year_end' : 'monthly',
  };
}
