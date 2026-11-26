import assert from 'node:assert/strict';
import test from 'node:test';
import { validateCouponCode } from '../coupons';

test('rejects blank coupon code', () => {
  assert.deepEqual(validateCouponCode(''), { ok: false, error: 'EMPTY_CODE' });
});

test('rejects too short coupon code', () => {
  assert.deepEqual(validateCouponCode('AB'), { ok: false, error: 'INVALID_LENGTH' });
});

test('rejects coupon code with symbols', () => {
  assert.deepEqual(validateCouponCode('SAVE$20'), { ok: false, error: 'INVALID_CHARACTERS' });
});

test('rejects expired coupon code', () => {
  assert.deepEqual(validateCouponCode('OLD2020'), { ok: false, error: 'EXPIRED' });
});

test('rejects overly long coupon code', () => {
  assert.deepEqual(validateCouponCode('SUPERLONGCOUPONCODE999'), { ok: false, error: 'INVALID_LENGTH' });
});
