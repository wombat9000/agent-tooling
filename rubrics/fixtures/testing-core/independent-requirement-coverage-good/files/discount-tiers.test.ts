import assert from 'node:assert/strict';
import test from 'node:test';
import { quoteCartDiscount } from '../context/discount';

test('applies no discount below $50.00', () => {
  assert.deepEqual(quoteCartDiscount(0), { subtotalCents: 0, discountCents: 0, totalCents: 0 });
  assert.deepEqual(quoteCartDiscount(4_999), { subtotalCents: 4_999, discountCents: 0, totalCents: 4_999 });
});

test('applies 10% discount from $50.00 through $99.99 rounded down', () => {
  assert.deepEqual(quoteCartDiscount(5_000), { subtotalCents: 5_000, discountCents: 500, totalCents: 4_500 });
  assert.deepEqual(quoteCartDiscount(9_999), { subtotalCents: 9_999, discountCents: 999, totalCents: 9_000 });
});

test('applies 20% discount at $100.00 and above up to the $40.00 cap', () => {
  assert.deepEqual(quoteCartDiscount(10_000), { subtotalCents: 10_000, discountCents: 2_000, totalCents: 8_000 });
  assert.deepEqual(quoteCartDiscount(20_000), { subtotalCents: 20_000, discountCents: 4_000, totalCents: 16_000 });
  assert.deepEqual(quoteCartDiscount(25_000), { subtotalCents: 25_000, discountCents: 4_000, totalCents: 21_000 });
});
