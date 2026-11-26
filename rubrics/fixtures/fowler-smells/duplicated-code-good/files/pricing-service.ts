import { computePricingBreakdown } from './discount-rules';
import type { PricingBreakdown, PricingInput } from './types';

export interface OrderStore {
  saveOrder(id: string, breakdown: PricingBreakdown): Promise<void>;
}

export function previewQuote(input: PricingInput): PricingBreakdown {
  return computePricingBreakdown(input);
}

export async function finalizeOrder(store: OrderStore, orderId: string, input: PricingInput): Promise<PricingBreakdown> {
  const breakdown = computePricingBreakdown(input);
  await store.saveOrder(orderId, breakdown);
  return breakdown;
}
