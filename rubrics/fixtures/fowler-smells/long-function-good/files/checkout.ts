import type { CartItem, CheckoutReceipt } from './types';

const STANDARD_TAX_RATE = 0.08;

function validateCartItems(items: readonly CartItem[]): void {
  if (items.length === 0) {
    throw new Error('Cart must contain at least one item');
  }
  for (const item of items) {
    if (item.quantity <= 0 || item.unitPriceCents < 0) {
      throw new Error(`Invalid cart item: ${item.sku}`);
    }
  }
}

function calculateSubtotalCents(items: readonly CartItem[]): number {
  return items.reduce((sum, item) => sum + item.quantity * item.unitPriceCents, 0);
}

function calculateTaxCents(subtotalCents: number): number {
  return Math.round(subtotalCents * STANDARD_TAX_RATE);
}

export function buildCheckoutReceipt(items: readonly CartItem[]): CheckoutReceipt {
  validateCartItems(items);
  const subtotalCents = calculateSubtotalCents(items);
  const taxCents = calculateTaxCents(subtotalCents);
  return {
    subtotalCents,
    taxCents,
    totalCents: subtotalCents + taxCents,
  };
}
