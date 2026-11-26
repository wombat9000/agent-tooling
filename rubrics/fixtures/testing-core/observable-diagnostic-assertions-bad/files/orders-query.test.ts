import assert from 'node:assert/strict';
import test from 'node:test';
import { createOrdersClient } from './helpers/orders-client';

test('lists created orders via raw JSON tree indexing', async () => {
  const client = createOrdersClient();
  const created = await client.createOrder({ sku: 'BOOK-01', quantity: 2, unitPriceCents: 1_500 });
  const raw = JSON.parse(await client.listOrdersRawText()) as Record<string, unknown>;
  const data = raw['data'] as Record<string, unknown>;
  const items = data['items'] as Array<Record<string, unknown>>;

  assert.equal(items.length > 0, true);
  assert.equal((items[0]['id'] as string) === created.id, true);
  assert.equal((items[0]['meta'] as Record<string, unknown>)['status'] === 'pending', true);
});
