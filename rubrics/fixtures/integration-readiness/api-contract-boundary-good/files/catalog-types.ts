export interface ProductSummary {
  readonly id: string;
  readonly sku: string;
  readonly title: string;
  readonly unitPriceCents: number;
  readonly discontinuedAtIso: string | null;
}

export interface ProductListResponse {
  readonly items: readonly ProductSummary[];
  readonly nextCursor: string | null;
}
