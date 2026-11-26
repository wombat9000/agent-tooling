import assert from 'node:assert/strict';
import test from 'node:test';
import { startTestApiServer } from './helpers/test-server';

test('POST /shipping/quotes persists and returns the calculated quote', async () => {
  const api = await startTestApiServer();
  const res = await api.post('/shipping/quotes', { id: 'q-42', weightGrams: 400, zone: 'domestic', fragile: false });
  assert.equal(res.status, 201);
  assert.deepEqual(res.body, { id: 'q-42', shippingCents: 650 });
});
