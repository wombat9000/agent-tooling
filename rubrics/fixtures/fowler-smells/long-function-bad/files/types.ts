export interface InventoryRecord {
  sku: string;
  available: number;
  unitPriceCents: number;
}

export interface ProcessedOrderLine {
  readonly sku: string;
  readonly qty: number;
  readonly unitCents: number;
  readonly lineCents: number;
}
