export interface OrderRow {
  readonly orderNumber: string;
  readonly customer: string;
  readonly totalCents: number;
  readonly fulfillmentStatus?: 'queued' | 'shipped';
}

export function filterOrders(
  rows: readonly OrderRow[],
  query: string,
  fulfillmentStatus?: 'queued' | 'shipped',
): OrderRow[] {
  const term = query.trim().toLowerCase();
  return rows.filter((row) => {
    if (term && !row.customer.toLowerCase().includes(term) && !row.orderNumber.toLowerCase().includes(term)) {
      return false;
    }
    if (fulfillmentStatus && row.fulfillmentStatus !== fulfillmentStatus) return false;
    return true;
  });
}
