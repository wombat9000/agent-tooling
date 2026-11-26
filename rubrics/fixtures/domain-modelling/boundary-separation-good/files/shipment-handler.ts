import { calculateShipmentQuote, type DeliverySpeed } from './shipment-policy';
import type { ShipmentQuoteRepository } from './shipment-repository';

export interface HttpQuoteRequest {
  readonly quoteId: string;
  readonly queryWeight: string;
  readonly querySpeed: string;
  readonly queryInsuredCents: string;
}

export async function handleQuoteHttp(repo: ShipmentQuoteRepository, req: HttpQuoteRequest) {
  const weightGrams = Number(req.queryWeight);
  const insuredValueCents = Number(req.queryInsuredCents);
  const speed: DeliverySpeed | null = req.querySpeed === 'express' || req.querySpeed === 'standard' ? req.querySpeed : null;
  if (!Number.isFinite(weightGrams) || weightGrams <= 0 || !Number.isFinite(insuredValueCents) || !speed) {
    return { status: 400, body: { error: 'Invalid shipment parameters' } };
  }
  const outcome = calculateShipmentQuote({ weightGrams, speed, insuredValueCents });
  if (outcome.kind === 'overweight') {
    return { status: 422, body: { error: `Exceeds max weight of ${outcome.maxGrams}g` } };
  }
  await repo.save({ id: req.quoteId, priceCents: outcome.priceCents });
  return { status: 201, body: { id: req.quoteId, priceCents: outcome.priceCents } };
}
