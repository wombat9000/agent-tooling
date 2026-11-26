import assert from 'node:assert/strict';
import test from 'node:test';
import { createTestServer } from './helpers/server';

test('POST /checkout rejects blank coupon code', async () => {
  const server = await createTestServer();
  const res = await server.post('/checkout', { subtotalCents: 10_000, couponCode: '' });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'EMPTY_CODE');
});

test('POST /checkout rejects too short coupon code', async () => {
  const server = await createTestServer();
  const res = await server.post('/checkout', { subtotalCents: 10_000, couponCode: 'AB' });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'INVALID_LENGTH');
});

test('POST /checkout rejects coupon code with symbols', async () => {
  const server = await createTestServer();
  const res = await server.post('/checkout', { subtotalCents: 10_000, couponCode: 'SAVE$20' });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'INVALID_CHARACTERS');
});

test('POST /checkout rejects expired coupon code', async () => {
  const server = await createTestServer();
  const res = await server.post('/checkout', { subtotalCents: 10_000, couponCode: 'OLD2020' });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'EXPIRED');
});

test('POST /checkout rejects overly long coupon code', async () => {
  const server = await createTestServer();
  const res = await server.post('/checkout', { subtotalCents: 10_000, couponCode: 'SUPERLONGCOUPONCODE999' });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'INVALID_LENGTH');
});
