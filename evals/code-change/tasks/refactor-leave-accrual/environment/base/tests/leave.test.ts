import assert from 'node:assert/strict';
import test from 'node:test';
import { calculateMonthlyAccruals } from '../src/leave.ts';

test('calculates monthly accrual for a full-time employee', () => {
  const results = calculateMonthlyAccruals([
    {
      employeeId: 'EMP-001',
      employmentType: 'full_time',
      tenureMonths: 30,
      currentBalanceHours: 235,
      unpaidLeaveDaysThisMonth: 3,
    },
  ]);

  assert.equal(results.length, 1);
  assert.equal(results[0].endingBalanceHours, 240);
  assert.equal(results[0].forfeitedHours, 7);
});
