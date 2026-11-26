import assert from 'node:assert/strict';
import test from 'node:test';
import { createOrdersClient } from './helpers/orders-client';

test('rejects cancelling an already shipped order and preserves its shipped state', async () => {
  const client = createOrdersClient();
  const order = await client.createOrder({ sku: 'LAMP-02', quantity: 1, unitPriceCents: 4_200 });
  await client.shipOrder(order.id);

  const response = await client.cancelOrderRaw(order.id);
  assert.equal(response.status, 409);
  assert.deepEqual(response.body, { errorCode: 'ORDER_ALREADY_SHIPPED', orderId: order.id });

  const persisted = await client.getOrder(order.id);
  assert.equal(persisted.status, 'shipped');
  assert.equal(persisted.totalCents, 4_200);
});
