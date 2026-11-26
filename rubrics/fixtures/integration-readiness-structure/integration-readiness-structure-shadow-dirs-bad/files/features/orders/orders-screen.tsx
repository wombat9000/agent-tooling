import { ORDER_COLUMNS } from './orders-columns';
import { filterOrders } from './orders-filters';
import { useOrders } from './use-orders';

export function OrdersScreen() {
  const rows = filterOrders(useOrders());
  return { columns: ORDER_COLUMNS, rows };
}
