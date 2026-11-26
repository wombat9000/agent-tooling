import assert from 'node:assert/strict';
import test from 'node:test';
import { calculateMonthlyAccruals, type EmployeeLeaveInput } from '../src/leave.ts';

function makeEmployee(overrides: Partial<EmployeeLeaveInput> = {}): EmployeeLeaveInput {
  return {
    employeeId: 'EMP-100',
    employmentType: 'full_time',
    tenureMonths: 12,
    currentBalanceHours: 20,
    unpaidLeaveDaysThisMonth: 0,
    ...overrides,
  };
}

test('returns empty list for empty employee batch', () => {
  assert.deepEqual(calculateMonthlyAccruals([]), []);
});

test('does not mutate caller employee input records', () => {
  const input = makeEmployee({ currentBalanceHours: 235, unpaidLeaveDaysThisMonth: 25 });
  const snapshot = { ...input };

  calculateMonthlyAccruals([input]);

  assert.deepEqual(input, snapshot);
});

test('applies full_time tenure milestones, quarter-hour proration, and monthly cap', () => {
  const [result] = calculateMonthlyAccruals([
    makeEmployee({
      employeeId: 'EMP-1',
      employmentType: 'full_time',
      tenureMonths: 30,
      currentBalanceHours: 235,
      unpaidLeaveDaysThisMonth: 3,
    }),
  ]);

  assert.deepEqual(result, {
    employeeId: 'EMP-1',
    employmentType: 'full_time',
    accruedHours: 12,
    forfeitedHours: 7,
    endingBalanceHours: 240,
    eligibleForCarryover: true,
  });
});

test('applies part_time tenure milestone and year-end carryover cap', () => {
  const [result] = calculateMonthlyAccruals([
    makeEmployee({
      employeeId: 'EMP-2',
      employmentType: 'part_time',
      tenureMonths: 40,
      currentBalanceHours: 78,
      unpaidLeaveDaysThisMonth: 5,
      isYearEnd: true,
    }),
  ]);

  assert.deepEqual(result, {
    employeeId: 'EMP-2',
    employmentType: 'part_time',
    accruedHours: 6,
    forfeitedHours: 4,
    endingBalanceHours: 80,
    eligibleForCarryover: true,
  });
});

test('cancels probation accrual on any unpaid leave and forfeits at year-end', () => {
  const [withUnpaid, atYearEnd] = calculateMonthlyAccruals([
    makeEmployee({
      employeeId: 'PRB-1',
      employmentType: 'probation',
      tenureMonths: 3,
      currentBalanceHours: 10,
      unpaidLeaveDaysThisMonth: 1,
    }),
    makeEmployee({
      employeeId: 'PRB-2',
      employmentType: 'probation',
      tenureMonths: 4,
      currentBalanceHours: 16,
      unpaidLeaveDaysThisMonth: 0,
      isYearEnd: true,
    }),
  ]);

  assert.equal(withUnpaid.accruedHours, 0);
  assert.equal(withUnpaid.endingBalanceHours, 10);
  assert.equal(atYearEnd.forfeitedHours, 20);
  assert.equal(atYearEnd.endingBalanceHours, 0);
  assert.equal(atYearEnd.eligibleForCarryover, false);
});

test('enforces sabbatical tenure eligibility, unpaid-leave immunity, parental freeze, and year-end caps', () => {
  const results = calculateMonthlyAccruals([
    makeEmployee({
      employeeId: 'SAB-INELIG-MID',
      employmentType: 'sabbatical',
      tenureMonths: 24,
      currentBalanceHours: 50,
      unpaidLeaveDaysThisMonth: 0,
    }),
    makeEmployee({
      employeeId: 'SAB-INELIG-YE',
      employmentType: 'sabbatical',
      tenureMonths: 24,
      currentBalanceHours: 50,
      unpaidLeaveDaysThisMonth: 0,
      isYearEnd: true,
    }),
    makeEmployee({
      employeeId: 'EMP-3',
      employmentType: 'sabbatical',
      tenureMonths: 36,
      currentBalanceHours: 125,
      unpaidLeaveDaysThisMonth: 10,
      isYearEnd: true,
    }),
    makeEmployee({
      employeeId: 'SAB-PARENTAL',
      employmentType: 'sabbatical',
      tenureMonths: 48,
      currentBalanceHours: 100,
      unpaidLeaveDaysThisMonth: 0,
      onParentalLeave: true,
    }),
  ]);

  assert.deepEqual(results[0], {
    employeeId: 'SAB-INELIG-MID',
    employmentType: 'sabbatical',
    accruedHours: 0,
    forfeitedHours: 0,
    endingBalanceHours: 50,
    eligibleForCarryover: false,
  });
  assert.deepEqual(results[1], {
    employeeId: 'SAB-INELIG-YE',
    employmentType: 'sabbatical',
    accruedHours: 0,
    forfeitedHours: 50,
    endingBalanceHours: 0,
    eligibleForCarryover: false,
  });
  assert.deepEqual(results[2], {
    employeeId: 'EMP-3',
    employmentType: 'sabbatical',
    accruedHours: 3,
    forfeitedHours: 8,
    endingBalanceHours: 120,
    eligibleForCarryover: true,
  });
  assert.deepEqual(results[3], {
    employeeId: 'SAB-PARENTAL',
    employmentType: 'sabbatical',
    accruedHours: 0,
    forfeitedHours: 0,
    endingBalanceHours: 100,
    eligibleForCarryover: true,
  });
});

test('rejects unsupported employment types', () => {
  assert.throws(
    () => calculateMonthlyAccruals([makeEmployee({ employmentType: 'seasonal' })]),
    /Unsupported employment type/,
  );
});
