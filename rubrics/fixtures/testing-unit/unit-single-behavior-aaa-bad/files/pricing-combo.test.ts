import assert from 'node:assert/strict';
import test from 'node:test';
import { applyCoupon, computeTax, formatCurrency } from '../pricing';

test('calculates discounts, rejects invalid coupons, computes tax, and formats money', () => {
  const discounted = applyCoupon(10_000, 'SAVE10');
  assert.equal(discounted, 9_000);
  assert.throws(() => applyCoupon(10_000, 'EXPIRED'));
  assert.throws(() => applyCoupon(-5, 'SAVE10'));
  const tax = computeTax(discounted, 'US-CA');
  assert.equal(tax, 743);
  assert.equal(computeTax(0, 'US-OR'), 0);
  assert.equal(formatCurrency(discounted + tax, 'USD'), '$97.43');
  assert.equal(formatCurrency(0, 'EUR'), '€0.00');
});
