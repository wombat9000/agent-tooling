import type { PricingBreakdown, PricingInput } from './types';

const TAX_RATE = 0.085;

export function computePricingBreakdown(input: PricingInput): PricingBreakdown {
  const subtotalCents = input.lines.reduce((sum, line) => sum + line.unitPriceCents * line.quantity, 0);
  let discountCents = 0;
  if (input.couponCode === 'SAVE15' && subtotalCents >= 5_000) {
    discountCents = Math.round(subtotalCents * 0.15);
  } else if (input.couponCode === 'FLAT1000' && subtotalCents >= 8_000) {
    discountCents = 1_000;
  }
  const discounted = Math.max(0, subtotalCents - discountCents);
  const taxCents = input.taxExempt ? 0 : Math.round(discounted * TAX_RATE);
  return { subtotalCents, discountCents, taxCents, totalCents: discounted + taxCents };
}
