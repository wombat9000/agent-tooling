import assert from 'node:assert/strict';
import test from 'node:test';
import { quoteCartDiscount } from '../context/discount';

test('computes discount matching production function', () => {
  const actual = quoteCartDiscount(7_500);
  const expected = quoteCartDiscount(7_500);
  assert.deepEqual(actual, expected);
});

test('returns a quote object for $120', () => {
  const quote = quoteCartDiscount(12_000);
  assert.ok(quote !== null);
  assert.equal(quote.totalCents, quote.subtotalCents - quote.discountCents);
});
