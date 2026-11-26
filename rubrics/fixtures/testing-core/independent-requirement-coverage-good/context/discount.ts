export interface DiscountQuote {
  readonly subtotalCents: number;
  readonly discountCents: number;
  readonly totalCents: number;
}

export function quoteCartDiscount(subtotalCents: number): DiscountQuote {
  if (!Number.isInteger(subtotalCents) || subtotalCents < 0) {
    throw new RangeError('Subtotal must be a non-negative integer');
  }
  const rate = subtotalCents >= 10_000 ? 0.2 : subtotalCents >= 5_000 ? 0.1 : 0;
  const rawDiscount = Math.floor(subtotalCents * rate);
  const discountCents = Math.min(rawDiscount, 4_000);
  return { subtotalCents, discountCents, totalCents: subtotalCents - discountCents };
}
