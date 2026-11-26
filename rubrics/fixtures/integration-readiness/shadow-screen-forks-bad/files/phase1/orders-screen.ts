import { PHASE1_ORDER_COLUMNS } from './orders-columns';

export interface Phase1OrderRow {
  readonly orderNumber: string;
  readonly customer: string;
  readonly totalCents: number;
}

export function buildPhase1OrdersViewModel(rows: readonly Phase1OrderRow[], query: string) {
  const term = query.trim().toLowerCase();
  return {
    columns: PHASE1_ORDER_COLUMNS,
    rows: rows.filter((row) => !term || row.customer.toLowerCase().includes(term) || row.orderNumber.toLowerCase().includes(term)),
  };
}
