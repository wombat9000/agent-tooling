import { createOrderInStub, listOrdersFromStub } from '../../lib/fake-orders-backend-stub';
export function getOrders() { return listOrdersFromStub(); }
export function submitOrder(id: string, totalCents: number) {
  return createOrderInStub({ id, totalCents, status: 'paid' });
}
