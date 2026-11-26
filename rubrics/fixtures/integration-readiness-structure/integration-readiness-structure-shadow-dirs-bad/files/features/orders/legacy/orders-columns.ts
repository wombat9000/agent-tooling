export interface LegacyOrderRow {
  readonly id: string;
  readonly status: 'open' | 'shipped';
  readonly totalCents: number;
}

export const LEGACY_ORDER_COLUMNS = ['id', 'status', 'totalCents'] as const;
