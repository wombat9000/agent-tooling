import type { InventoryRecord } from './types';

export function totalUnitsInStock(inventory: ReadonlyMap<string, InventoryRecord>): number {
  let total = 0;
  for (const record of inventory.values()) {
    total += record.available;
  }
  return total;
}
