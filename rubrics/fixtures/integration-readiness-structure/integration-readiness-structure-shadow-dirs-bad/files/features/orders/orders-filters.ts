import type { OrderRow } from './orders-columns';

export function filterOrders(rows: OrderRow[], status?: OrderRow['status']): OrderRow[] {
  return status ? rows.filter((row) => row.status === status) : rows;
}
