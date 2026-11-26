import assert from 'node:assert/strict';
import test from 'node:test';
import { createOrdersClient, type OrderListResponse } from './helpers/orders-client';

test('lists created orders with complete contract fields looked up by stable ID', async () => {
  const client = createOrdersClient();
  const created = await client.createOrder({ sku: 'BOOK-01', quantity: 2, unitPriceCents: 1_500 });
  const list: OrderListResponse = await client.listOrders();

  const match = list.items.find((item) => item.id === created.id);
  assert.deepEqual(match, {
    id: created.id,
    sku: 'BOOK-01',
    quantity: 2,
    totalCents: 3_000,
    status: 'pending',
  });
});
