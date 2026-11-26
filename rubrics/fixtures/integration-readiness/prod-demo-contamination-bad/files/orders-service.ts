import type { OrderSummary } from './orders-client';

export function sumOrderTotals(orders: readonly OrderSummary[]): number {
  return orders.reduce((sum, order) => sum + order.totalCents, 0);
}
