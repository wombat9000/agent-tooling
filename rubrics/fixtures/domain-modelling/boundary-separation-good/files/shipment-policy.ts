export type DeliverySpeed = 'standard' | 'express';

export interface ShipmentRequest {
  readonly weightGrams: number;
  readonly speed: DeliverySpeed;
  readonly insuredValueCents: number;
}

export type QuoteOutcome =
  | { readonly kind: 'quoted'; readonly priceCents: number }
  | { readonly kind: 'overweight'; readonly maxGrams: number };

const MAX_WEIGHT_GRAMS = 25_000;

export function calculateShipmentQuote(request: ShipmentRequest): QuoteOutcome {
  if (request.weightGrams > MAX_WEIGHT_GRAMS) {
    return { kind: 'overweight', maxGrams: MAX_WEIGHT_GRAMS };
  }
  const base = request.speed === 'express' ? 1_800 : 750;
  const weightFee = Math.ceil(request.weightGrams / 1_000) * 120;
  const insuranceFee = Math.round(request.insuredValueCents * 0.01);
  return { kind: 'quoted', priceCents: base + weightFee + insuranceFee };
}
