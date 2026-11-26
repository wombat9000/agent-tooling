export interface OrderRow {
  readonly id: string;
  readonly status: 'open' | 'shipped';
  readonly totalCents: number;
}

export const ORDER_COLUMNS = ['id', 'status', 'totalCents'] as const;
