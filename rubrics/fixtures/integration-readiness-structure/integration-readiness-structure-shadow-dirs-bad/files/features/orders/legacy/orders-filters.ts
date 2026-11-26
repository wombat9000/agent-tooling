import type { LegacyOrderRow } from './orders-columns';

export function filterLegacyOrders(rows: LegacyOrderRow[], status?: LegacyOrderRow['status']): LegacyOrderRow[] {
  return status ? rows.filter((row) => row.status === status) : rows;
}
