import assert from 'node:assert/strict';
import test from 'node:test';
import { calculateShippingCents } from '../context/shipping-policy';
import { bootFullStackAppWithPostgres } from './helpers/full-stack';

test('boots full HTTP server + Postgres just to test every pure shipping math tier and mixes raw DB checks', async () => {
  const { api, db } = await bootFullStackAppWithPostgres();

  const d = await api.post('/shipping/quotes', { id: 'q-1', weightGrams: 400, zone: 'domestic', fragile: false });
  assert.equal(d.body.shippingCents, 650);

  const r = await api.post('/shipping/quotes', { id: 'q-2', weightGrams: 1_200, zone: 'regional', fragile: true });
  assert.equal(r.body.shippingCents, 2_000);

  // Direct pure-domain call mixed inside API integration test
  assert.equal(calculateShippingCents({ weightGrams: 500, zone: 'domestic', fragile: false }), 650);

  // Raw SQL primary-key constraint test mixed into API integration test
  await assert.rejects(() => db.query("INSERT INTO shipping_quotes(id, cents) VALUES ('q-1', 100)"));
});
