export interface TableColumn {
  readonly key: string;
  readonly label: string;
}

export function buildOrderColumns(options: { readonly showFulfillmentStatus: boolean }): TableColumn[] {
  const columns: TableColumn[] = [
    { key: 'orderNumber', label: 'Order' },
    { key: 'customer', label: 'Customer' },
    { key: 'total', label: 'Total' },
  ];
  if (options.showFulfillmentStatus) {
    columns.push({ key: 'fulfillmentStatus', label: 'Fulfillment' });
  }
  return columns;
}
