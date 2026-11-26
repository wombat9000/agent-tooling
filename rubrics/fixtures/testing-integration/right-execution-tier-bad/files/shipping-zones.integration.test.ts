import assert from 'node:assert/strict';
import test from 'node:test';
import { bootFullStackAppWithPostgres } from './helpers/full-stack';

test('boots full HTTP server + Postgres to verify international weight brackets and negative weight validation', async () => {
  const { api } = await bootFullStackAppWithPostgres();

  const intl = await api.post('/shipping/quotes', { id: 'q-3', weightGrams: 750, zone: 'international', fragile: false });
  assert.equal(intl.body.shippingCents, 3_300);

  const neg = await api.post('/shipping/quotes', { id: 'q-4', weightGrams: -10, zone: 'domestic', fragile: false });
  assert.equal(neg.status, 400);
});
