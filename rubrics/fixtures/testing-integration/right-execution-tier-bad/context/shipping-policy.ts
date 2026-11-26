export type ShippingZone = 'domestic' | 'regional' | 'international';

export interface ShipmentQuoteRequest {
  readonly weightGrams: number;
  readonly zone: ShippingZone;
  readonly fragile: boolean;
}

export function calculateShippingCents(req: ShipmentQuoteRequest): number {
  if (req.weightGrams <= 0) throw new RangeError('Weight must be positive');
  const base = req.zone === 'domestic' ? 500 : req.zone === 'regional' ? 1_200 : 2_500;
  const weightFee = Math.ceil(req.weightGrams / 500) * (req.zone === 'international' ? 400 : 150);
  const fragileFee = req.fragile ? 350 : 0;
  return base + weightFee + fragileFee;
}
