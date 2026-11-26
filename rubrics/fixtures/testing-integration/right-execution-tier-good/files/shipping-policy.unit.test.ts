import assert from 'node:assert/strict';
import test from 'node:test';
import { calculateShippingCents } from '../context/shipping-policy';

test('calculates domestic, regional, and international shipping rates with fragile surcharge', () => {
  assert.equal(calculateShippingCents({ weightGrams: 400, zone: 'domestic', fragile: false }), 650);
  assert.equal(calculateShippingCents({ weightGrams: 1_200, zone: 'regional', fragile: true }), 2_000);
  assert.equal(calculateShippingCents({ weightGrams: 750, zone: 'international', fragile: false }), 3_300);
});

test('rejects zero and negative parcel weights', () => {
  assert.throws(() => calculateShippingCents({ weightGrams: 0, zone: 'domestic', fragile: false }), RangeError);
  assert.throws(() => calculateShippingCents({ weightGrams: -10, zone: 'domestic', fragile: false }), RangeError);
});
