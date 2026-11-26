export type Currency = 'USD' | 'EUR';

export interface Money {
  readonly amountCents: number;
  readonly currency: Currency;
}

export interface CartItem {
  readonly sku: string;
  readonly quantity: number;
  readonly unitPriceCents: number;
}

export interface CheckoutReceipt {
  readonly subtotalCents: number;
  readonly taxCents: number;
  readonly totalCents: number;
}
