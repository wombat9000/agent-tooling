import assert from 'node:assert/strict';
import test from 'node:test';
import { Money, TaxPolicy } from '../context/money';

test('computes rounded tax directly on real Money values', () => {
  const policy = new TaxPolicy(825);
  assert.deepEqual(policy.taxFor(new Money(1_000, 'USD')), new Money(83, 'USD'));
});

test('rejects adding mismatched currencies', () => {
  assert.throws(() => new Money(500, 'USD').add(new Money(500, 'EUR')), /Currency mismatch/);
});
