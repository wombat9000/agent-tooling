export interface ModernTableColumn {
  readonly key: string;
  readonly label: string;
}

export const V2_ORDER_COLUMNS: readonly ModernTableColumn[] = [
  { key: 'orderNumber', label: 'Order' },
  { key: 'customer', label: 'Customer' },
  { key: 'total', label: 'Total' },
  { key: 'fulfillmentStatus', label: 'Fulfillment' },
];
