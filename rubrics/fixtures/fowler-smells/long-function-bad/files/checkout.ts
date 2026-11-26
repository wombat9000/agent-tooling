import type { InventoryRecord, ProcessedOrderLine } from './types';

export function processRawCheckoutOrder(
  rawPayload: string,
  inventory: Map<string, InventoryRecord>,
  couponCode: string | null,
  shippingRegion: string,
  loyaltyPoints: number,
) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawPayload);
  } catch {
    throw new Error('Malformed JSON payload');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Payload must be an object');
  }
  const record = parsed as Record<string, unknown>;
  if (typeof record.customerEmail !== 'string' || !record.customerEmail.includes('@')) {
    throw new Error('Valid customer email is required');
  }
  if (!Array.isArray(record.lines) || record.lines.length === 0) {
    throw new Error('At least one line item is required');
  }

  const normalizedLines: ProcessedOrderLine[] = [];
  let subtotalCents = 0;
  for (const rawLine of record.lines) {
    if (!rawLine || typeof rawLine !== 'object') {
      throw new Error('Invalid line entry');
    }
    const line = rawLine as Record<string, unknown>;
    const sku = typeof line.sku === 'string' ? line.sku.trim().toUpperCase() : '';
    const qty = typeof line.qty === 'number' ? Math.floor(line.qty) : 0;
    if (!sku || qty <= 0) {
      throw new Error(`Invalid sku or quantity: ${sku}`);
    }
    const stock = inventory.get(sku);
    if (!stock) {
      throw new Error(`Unknown sku: ${sku}`);
    }
    if (stock.available < qty) {
      throw new Error(`Insufficient inventory for ${sku}`);
    }
    const lineCents = stock.unitPriceCents * qty;
    subtotalCents += lineCents;
    normalizedLines.push({ sku, qty, unitCents: stock.unitPriceCents, lineCents });
  }

  let discountCents = 0;
  if (couponCode === 'SAVE10') {
    discountCents = Math.round(subtotalCents * 0.1);
  } else if (couponCode === 'SAVE25' && subtotalCents >= 10000) {
    discountCents = Math.round(subtotalCents * 0.25);
  } else if (couponCode === 'FLAT500' && subtotalCents >= 2000) {
    discountCents = 500;
  }
  if (loyaltyPoints >= 1000) {
    const loyaltyCredit = Math.min(2500, Math.floor(loyaltyPoints / 100) * 100);
    discountCents = Math.min(subtotalCents, discountCents + loyaltyCredit);
  }
  const discountedSubtotal = Math.max(0, subtotalCents - discountCents);

  let shippingCents = 799;
  if (discountedSubtotal >= 7500) {
    shippingCents = 0;
  } else if (shippingRegion === 'EU') {
    shippingCents = 1499;
  } else if (shippingRegion === 'APAC') {
    shippingCents = 1999;
  }

  let taxRate = 0.08;
  if (shippingRegion === 'EU') taxRate = 0.2;
  else if (shippingRegion === 'UK') taxRate = 0.2;
  else if (shippingRegion === 'OR') taxRate = 0;
  const taxCents = Math.round((discountedSubtotal + shippingCents) * taxRate);
  const grandTotalCents = discountedSubtotal + shippingCents + taxCents;

  for (const line of normalizedLines) {
    const stock = inventory.get(line.sku)!;
    stock.available -= line.qty;
  }

  const summaryLines = [
    `Customer: ${record.customerEmail}`,
    ...normalizedLines.map((l) => `  - ${l.sku} x${l.qty} = $${(l.lineCents / 100).toFixed(2)}`),
    `Subtotal: $${(subtotalCents / 100).toFixed(2)}`,
    `Discount: -$${(discountCents / 100).toFixed(2)}`,
    `Shipping: $${(shippingCents / 100).toFixed(2)}`,
    `Tax: $${(taxCents / 100).toFixed(2)}`,
    `Total: $${(grandTotalCents / 100).toFixed(2)}`,
  ];

  return {
    customerEmail: record.customerEmail,
    lines: normalizedLines,
    subtotalCents,
    discountCents,
    shippingCents,
    taxCents,
    grandTotalCents,
    formattedReceipt: summaryLines.join('\n'),
  };
}
