import { calculateShippingCents, type ShipmentQuoteRequest } from './shipping-policy';

export interface ShipmentRepository {
  saveQuote(id: string, cents: number): Promise<void>;
}

export class ShippingController {
  constructor(private readonly repo: ShipmentRepository) {}

  async createQuote(id: string, body: ShipmentQuoteRequest): Promise<{ id: string; shippingCents: number }> {
    const shippingCents = calculateShippingCents(body);
    await this.repo.saveQuote(id, shippingCents);
    return { id, shippingCents };
  }
}
