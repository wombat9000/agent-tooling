import assert from 'node:assert/strict';
import test from 'node:test';
import { createOrdersClient } from './helpers/orders-client';

test('rejects cancelling a shipped order', async () => {
  const client = createOrdersClient();
  const order = await client.createOrder({ sku: 'LAMP-02', quantity: 1, unitPriceCents: 4_200 });
  await client.shipOrder(order.id);

  const response = await client.cancelOrderRaw(order.id);
  assert.equal(response.status === 409, true);
  assert.equal(
    response.rawErrorText,
    'IllegalStateException at OrderStateMachine.kt:84: cannot transition row lock #42 from SHIPPED to CANCELLED',
  );
});
