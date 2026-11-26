import { InventoryItem } from './inventory-item.ts';
import { Item } from './item.ts';

export { Item } from './item.ts';

export class GildedRose {
  items: Array<Item>;

  constructor(items: ReadonlyArray<Item> = []) {
    this.items = items.map((item) => new Item(item.name, item.sellIn, item.quality));
  }

  updateQuality(): Array<Item> {
    this.items = this.items.map((item) => InventoryItem.fromItem(item).advanceDay().toItem());
    return this.items;
  }
}
