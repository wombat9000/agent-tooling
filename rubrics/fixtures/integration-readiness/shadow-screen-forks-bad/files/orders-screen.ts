import { V2_ORDER_COLUMNS } from './orders-columns';
import { buildPhase1OrdersViewModel } from './phase1/orders-screen';

export interface OrderRow {
  readonly orderNumber: string;
  readonly customer: string;
  readonly totalCents: number;
  readonly fulfillmentStatus?: 'queued' | 'shipped';
}

// ADR-14: Keep Phase 1 screen frozen in phase1/ while V2 rolls out.
export function buildOrdersViewModel(rows: readonly OrderRow[], query: string, v2Enabled: boolean) {
  if (!v2Enabled) {
    return buildPhase1OrdersViewModel(rows, query);
  }
  const term = query.trim().toLowerCase();
  return {
    columns: V2_ORDER_COLUMNS,
    rows: rows.filter((row) => !term || row.customer.toLowerCase().includes(term) || row.orderNumber.toLowerCase().includes(term)),
  };
}
