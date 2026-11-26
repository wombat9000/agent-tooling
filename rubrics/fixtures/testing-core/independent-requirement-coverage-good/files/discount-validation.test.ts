import assert from 'node:assert/strict';
import test from 'node:test';
import { quoteCartDiscount } from '../context/discount';

test('rejects negative subtotals with RangeError', () => {
  assert.throws(() => quoteCartDiscount(-1), RangeError);
  assert.throws(() => quoteCartDiscount(-5_000), RangeError);
});

test('rejects non-integer fractional cents with RangeError', () => {
  assert.throws(() => quoteCartDiscount(100.5), RangeError);
});
