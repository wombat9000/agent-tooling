import type { CheckoutReceipt } from './types';

function formatDollars(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

export function formatReceiptSummary(receipt: CheckoutReceipt): string {
  return [
    `Subtotal: ${formatDollars(receipt.subtotalCents)}`,
    `Tax: ${formatDollars(receipt.taxCents)}`,
    `Total: ${formatDollars(receipt.totalCents)}`,
  ].join('\n');
}
