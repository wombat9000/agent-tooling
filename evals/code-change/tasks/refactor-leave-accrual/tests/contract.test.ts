import assert from 'node:assert/strict';
import test from 'node:test';
import { calculateMonthlyAccruals, type EmployeeLeaveInput } from '../src/leave.ts';

function employee(overrides: Partial<EmployeeLeaveInput> = {}): EmployeeLeaveInput {
  return {
    employeeId: 'EMP-DEFAULT',
    employmentType: 'full_time',
    tenureMonths: 12,
    currentBalanceHours: 40,
    unpaidLeaveDaysThisMonth: 0,
    ...overrides,
  };
}

test('returns an empty array for empty input', () => {
  assert.deepEqual(calculateMonthlyAccruals([]), []);
});

test('calculates full_time tenure milestones, unpaid-leave proration, parental freeze, and caps', () => {
  const results = calculateMonthlyAccruals([
    employee({
      employeeId: 'FT-JUNIOR',
      tenureMonths: 23,
      currentBalanceHours: 20,
      unpaidLeaveDaysThisMonth: 0,
    }),
    employee({
      employeeId: 'EMP-1',
      tenureMonths: 30,
      currentBalanceHours: 235,
      unpaidLeaveDaysThisMonth: 3,
    }),
    employee({
      employeeId: 'FT-TENURED-YE',
      tenureMonths: 60,
      currentBalanceHours: 150,
      unpaidLeaveDaysThisMonth: 5,
      isYearEnd: true,
    }),
    employee({
      employeeId: 'FT-PARENTAL',
      tenureMonths: 72,
      currentBalanceHours: 180,
      unpaidLeaveDaysThisMonth: 0,
      onParentalLeave: true,
      isYearEnd: true,
    }),
    employee({
      employeeId: 'FT-CLAMPED-UNPAID',
      tenureMonths: 24,
      currentBalanceHours: 10,
      unpaidLeaveDaysThisMonth: 25,
    }),
  ]);

  assert.deepEqual(results, [
    {
      employeeId: 'FT-JUNIOR',
      employmentType: 'full_time',
      accruedHours: 12,
      forfeitedHours: 0,
      endingBalanceHours: 32,
      eligibleForCarryover: true,
    },
    {
      employeeId: 'EMP-1',
      employmentType: 'full_time',
      accruedHours: 12,
      forfeitedHours: 7,
      endingBalanceHours: 240,
      eligibleForCarryover: true,
    },
    {
      employeeId: 'FT-TENURED-YE',
      employmentType: 'full_time',
      accruedHours: 12,
      forfeitedHours: 2,
      endingBalanceHours: 160,
      eligibleForCarryover: true,
    },
    {
      employeeId: 'FT-PARENTAL',
      employmentType: 'full_time',
      accruedHours: 0,
      forfeitedHours: 20,
      endingBalanceHours: 160,
      eligibleForCarryover: true,
    },
    {
      employeeId: 'FT-CLAMPED-UNPAID',
      employmentType: 'full_time',
      accruedHours: 0,
      forfeitedHours: 0,
      endingBalanceHours: 10,
      eligibleForCarryover: true,
    },
  ]);
});

test('calculates part_time tenure milestone at 36 months, proration, and mid-year vs year-end caps', () => {
  const results = calculateMonthlyAccruals([
    employee({
      employeeId: 'PT-35',
      employmentType: 'part_time',
      tenureMonths: 35,
      currentBalanceHours: 118,
      unpaidLeaveDaysThisMonth: 1,
    }),
    employee({
      employeeId: 'EMP-2',
      employmentType: 'part_time',
      tenureMonths: 40,
      currentBalanceHours: 78,
      unpaidLeaveDaysThisMonth: 5,
      isYearEnd: true,
    }),
    employee({
      employeeId: 'PT-36-PARENTAL',
      employmentType: 'part_time',
      tenureMonths: 36,
      currentBalanceHours: 50,
      unpaidLeaveDaysThisMonth: 0,
      onParentalLeave: true,
    }),
  ]);

  assert.deepEqual(results, [
    {
      employeeId: 'PT-35',
      employmentType: 'part_time',
      accruedHours: 5.75,
      forfeitedHours: 3.75,
      endingBalanceHours: 120,
      eligibleForCarryover: true,
    },
    {
      employeeId: 'EMP-2',
      employmentType: 'part_time',
      accruedHours: 6,
      forfeitedHours: 4,
      endingBalanceHours: 80,
      eligibleForCarryover: true,
    },
    {
      employeeId: 'PT-36-PARENTAL',
      employmentType: 'part_time',
      accruedHours: 0,
      forfeitedHours: 0,
      endingBalanceHours: 50,
      eligibleForCarryover: true,
    },
  ]);
});

test('calculates contractor and probation rules including strict unpaid-leave cancellation and year-end forfeiture', () => {
  const results = calculateMonthlyAccruals([
    employee({
      employeeId: 'CTR-1',
      employmentType: 'contractor',
      tenureMonths: 60,
      currentBalanceHours: 8,
      unpaidLeaveDaysThisMonth: 0,
    }),
    employee({
      employeeId: 'PRB-CLEAN',
      employmentType: 'probation',
      tenureMonths: 3,
      currentBalanceHours: 38,
      unpaidLeaveDaysThisMonth: 0,
    }),
    employee({
      employeeId: 'PRB-UNPAID',
      employmentType: 'probation',
      tenureMonths: 4,
      currentBalanceHours: 12,
      unpaidLeaveDaysThisMonth: 1,
    }),
    employee({
      employeeId: 'PRB-YEAR-END',
      employmentType: 'probation',
      tenureMonths: 5,
      currentBalanceHours: 16,
      unpaidLeaveDaysThisMonth: 0,
      isYearEnd: true,
    }),
  ]);

  assert.deepEqual(results, [
    {
      employeeId: 'CTR-1',
      employmentType: 'contractor',
      accruedHours: 0,
      forfeitedHours: 8,
      endingBalanceHours: 0,
      eligibleForCarryover: false,
    },
    {
      employeeId: 'PRB-CLEAN',
      employmentType: 'probation',
      accruedHours: 4,
      forfeitedHours: 2,
      endingBalanceHours: 40,
      eligibleForCarryover: false,
    },
    {
      employeeId: 'PRB-UNPAID',
      employmentType: 'probation',
      accruedHours: 0,
      forfeitedHours: 0,
      endingBalanceHours: 12,
      eligibleForCarryover: false,
    },
    {
      employeeId: 'PRB-YEAR-END',
      employmentType: 'probation',
      accruedHours: 4,
      forfeitedHours: 20,
      endingBalanceHours: 0,
      eligibleForCarryover: false,
    },
  ]);
});

test('calculates sabbatical eligibility threshold, unpaid-leave immunity, parental freeze, and balance caps', () => {
  const results = calculateMonthlyAccruals([
    employee({
      employeeId: 'SAB-INELIG-MID',
      employmentType: 'sabbatical',
      tenureMonths: 35,
      currentBalanceHours: 50,
      unpaidLeaveDaysThisMonth: 0,
    }),
    employee({
      employeeId: 'SAB-INELIG-YE',
      employmentType: 'sabbatical',
      tenureMonths: 24,
      currentBalanceHours: 50,
      unpaidLeaveDaysThisMonth: 0,
      isYearEnd: true,
    }),
    employee({
      employeeId: 'EMP-3',
      employmentType: 'sabbatical',
      tenureMonths: 36,
      currentBalanceHours: 125,
      unpaidLeaveDaysThisMonth: 10,
      isYearEnd: true,
    }),
    employee({
      employeeId: 'SAB-MID-CAP',
      employmentType: 'sabbatical',
      tenureMonths: 48,
      currentBalanceHours: 159,
      unpaidLeaveDaysThisMonth: 15,
    }),
    employee({
      employeeId: 'SAB-PARENTAL',
      employmentType: 'sabbatical',
      tenureMonths: 48,
      currentBalanceHours: 100,
      unpaidLeaveDaysThisMonth: 0,
      onParentalLeave: true,
    }),
  ]);

  assert.deepEqual(results, [
    {
      employeeId: 'SAB-INELIG-MID',
      employmentType: 'sabbatical',
      accruedHours: 0,
      forfeitedHours: 0,
      endingBalanceHours: 50,
      eligibleForCarryover: false,
    },
    {
      employeeId: 'SAB-INELIG-YE',
      employmentType: 'sabbatical',
      accruedHours: 0,
      forfeitedHours: 50,
      endingBalanceHours: 0,
      eligibleForCarryover: false,
    },
    {
      employeeId: 'EMP-3',
      employmentType: 'sabbatical',
      accruedHours: 3,
      forfeitedHours: 8,
      endingBalanceHours: 120,
      eligibleForCarryover: true,
    },
    {
      employeeId: 'SAB-MID-CAP',
      employmentType: 'sabbatical',
      accruedHours: 3,
      forfeitedHours: 2,
      endingBalanceHours: 160,
      eligibleForCarryover: true,
    },
    {
      employeeId: 'SAB-PARENTAL',
      employmentType: 'sabbatical',
      accruedHours: 0,
      forfeitedHours: 0,
      endingBalanceHours: 100,
      eligibleForCarryover: true,
    },
  ]);
});

test('throws an error for an unsupported employment type', () => {
  assert.throws(
    () => calculateMonthlyAccruals([employee({ employmentType: 'intern' })]),
    /employment type/i,
  );
});
