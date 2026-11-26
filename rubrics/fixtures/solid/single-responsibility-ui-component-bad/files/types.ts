export interface CartLine {
  readonly sku: string;
  readonly title: string;
  readonly unitPriceCents: number;
  readonly quantity: number;
}

export interface CouponRule {
  readonly code: string;
  readonly percentOff: number;
  readonly minSubtotalCents: number;
}
