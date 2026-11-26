import { DEMO_ORDERS, type DemoOrder } from './demo-world-seed';
const inMemoryOrders = [...DEMO_ORDERS];
export async function listOrdersFromStub(): Promise<DemoOrder[]> { return inMemoryOrders; }
export async function createOrderInStub(order: DemoOrder): Promise<DemoOrder> {
  inMemoryOrders.push(order);
  return order;
}
