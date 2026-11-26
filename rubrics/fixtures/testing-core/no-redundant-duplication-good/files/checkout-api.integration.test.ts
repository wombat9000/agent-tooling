import assert from 'node:assert/strict';
import test from 'node:test';
import { createTestServer } from './helpers/server';

test('POST /checkout applies a valid coupon end-to-end', async () => {
  const server = await createTestServer();
  const res = await server.post('/checkout', { subtotalCents: 10_000, couponCode: 'SPRING25' });
  assert.equal(res.status, 200);
  assert.equal(res.body.totalCents, 7_500);
});

test('POST /checkout surfaces coupon validation errors as 400', async () => {
  const server = await createTestServer();
  const res = await server.post('/checkout', { subtotalCents: 10_000, couponCode: 'AB' });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'INVALID_LENGTH');
});
