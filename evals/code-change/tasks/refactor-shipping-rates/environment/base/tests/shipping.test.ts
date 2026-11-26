import assert from 'node:assert/strict';
import test from 'node:test';
import { calculateShippingQuotes } from '../src/shipping.ts';

test('calculates a basic domestic standard quote', () => {
  const quotes = calculateShippingQuotes([
    {
      id: 'SHP-001',
      service: 'standard',
      weightKg: 4.2,
      lengthCm: 20,
      widthCm: 20,
      heightCm: 10,
      zone: 'domestic',
      declaredValueCents: 25000,
      fragile: true,
    },
  ]);

  assert.equal(quotes.length, 1);
  assert.equal(quotes[0].totalCents, 2178);
});
