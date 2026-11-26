import assert from 'node:assert/strict';
import test from 'node:test';
import { quoteCartDiscount } from '../context/discount';

test('does not throw for valid subtotal', () => {
  assert.doesNotThrow(() => quoteCartDiscount(2_000));
});
