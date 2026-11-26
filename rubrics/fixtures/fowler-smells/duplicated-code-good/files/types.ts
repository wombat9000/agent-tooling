export interface OrderLine {
  readonly sku: string;
  readonly unitPriceCents: number;
  readonly quantity: number;
}

export interface PricingInput {
  readonly lines: readonly OrderLine[];
  readonly couponCode: string | null;
  readonly taxExempt: boolean;
}

export interface PricingBreakdown {
  readonly subtotalCents: number;
  readonly discountCents: number;
  readonly taxCents: number;
  readonly totalCents: number;
}
