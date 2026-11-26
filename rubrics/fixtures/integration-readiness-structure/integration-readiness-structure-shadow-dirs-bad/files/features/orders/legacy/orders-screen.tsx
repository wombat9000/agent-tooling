import { LEGACY_ORDER_COLUMNS } from './orders-columns';
import { filterLegacyOrders } from './orders-filters';
import { useLegacyOrders } from './use-orders';

export function LegacyOrdersScreen() {
  const rows = filterLegacyOrders(useLegacyOrders());
  return { columns: LEGACY_ORDER_COLUMNS, rows };
}
