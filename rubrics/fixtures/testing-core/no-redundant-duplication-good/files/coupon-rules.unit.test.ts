import assert from 'node:assert/strict';
import test from 'node:test';
import { validateCouponCode } from '../coupons';

const CASES = [
  { label: 'blank code', code: '', expectedError: 'EMPTY_CODE' },
  { label: 'too short', code: 'AB', expectedError: 'INVALID_LENGTH' },
  { label: 'invalid symbols', code: 'SAVE$20', expectedError: 'INVALID_CHARACTERS' },
  { label: 'expired prefix', code: 'OLD2020', expectedError: 'EXPIRED' },
  { label: 'exceeds max length', code: 'SUPERLONGCOUPONCODE999', expectedError: 'INVALID_LENGTH' },
] as const;

test('rejects invalid coupon codes with specific error codes', () => {
  for (const { label, code, expectedError } of CASES) {
    assert.deepEqual(validateCouponCode(code), { ok: false, error: expectedError }, label);
  }
});

test('accepts a valid alphanumeric coupon code', () => {
  assert.deepEqual(validateCouponCode('SPRING25'), { ok: true, normalized: 'SPRING25' });
});
