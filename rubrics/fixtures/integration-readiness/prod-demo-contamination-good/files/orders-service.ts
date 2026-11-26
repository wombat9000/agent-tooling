import type { OrdersApiConfig } from './config';
import { fetchOrders, type OrderSummary } from './orders-client';

export async function listHighValueOrders(
  config: OrdersApiConfig,
  authHeader: string,
  minCents: number,
): Promise<readonly OrderSummary[]> {
  const orders = await fetchOrders(config, authHeader);
  return orders.filter((order) => order.totalCents >= minCents);
}
