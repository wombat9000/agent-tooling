export interface LegacyTableColumn {
  readonly key: string;
  readonly label: string;
}

export const PHASE1_ORDER_COLUMNS: readonly LegacyTableColumn[] = [
  { key: 'orderNumber', label: 'Order' },
  { key: 'customer', label: 'Customer' },
  { key: 'total', label: 'Total' },
];
