import { Money, TaxPolicy } from './money';

export interface PaymentGateway {
  charge(accountId: string, amount: Money): Promise<{ receiptId: string }>;
}

export class BillingService {
  constructor(
    private readonly taxPolicy: TaxPolicy,
    private readonly gateway: PaymentGateway,
  ) {}

  async chargeOrder(accountId: string, subtotal: Money): Promise<{ receiptId: string; total: Money }> {
    const total = subtotal.add(this.taxPolicy.taxFor(subtotal));
    const { receiptId } = await this.gateway.charge(accountId, total);
    return { receiptId, total };
  }
}
