import { Item } from './item.ts';
import { classifyItemCategory, type ItemCategory } from './item-category.ts';

const MIN_QUALITY = 0;
const MAX_QUALITY = 50;
const SELL_DATE_EXPIRED_THRESHOLD = 0;
const BACKSTAGE_DOUBLE_RATE_DAYS = 10;
const BACKSTAGE_TRIPLE_RATE_DAYS = 5;
const NORMAL_BASE_DEGRADATION = 1;
const CONJURED_BASE_DEGRADATION = 2;
const AGED_BRIE_BASE_APPRECIATION = 1;
const EXPIRED_RATE_MULTIPLIER = 2;

function clampStandardQuality(value: number): number {
  return Math.max(MIN_QUALITY, Math.min(MAX_QUALITY, value));
}

function isPastSellDate(sellIn: number): boolean {
  return sellIn <= SELL_DATE_EXPIRED_THRESHOLD;
}

function degradingDelta(baseRate: number, sellIn: number): number {
  return isPastSellDate(sellIn) ? -baseRate * EXPIRED_RATE_MULTIPLIER : -baseRate;
}

function backstagePassQuality(sellIn: number, currentQuality: number): number {
  if (isPastSellDate(sellIn)) return MIN_QUALITY;
  const increase = sellIn <= BACKSTAGE_TRIPLE_RATE_DAYS
    ? 3
    : sellIn <= BACKSTAGE_DOUBLE_RATE_DAYS
      ? 2
      : 1;
  return clampStandardQuality(currentQuality + increase);
}

type CategoryTransition = (item: InventoryItem) => InventoryItem;

const CATEGORY_TRANSITIONS: Record<ItemCategory, CategoryTransition> = {
  normal: (item) => item.withUpdatedState(
    item.sellIn - 1,
    Math.max(MIN_QUALITY, item.quality + degradingDelta(NORMAL_BASE_DEGRADATION, item.sellIn)),
  ),
  conjured: (item) => item.withUpdatedState(
    item.sellIn - 1,
    Math.max(MIN_QUALITY, item.quality + degradingDelta(CONJURED_BASE_DEGRADATION, item.sellIn)),
  ),
  aged_brie: (item) => {
    const increase = isPastSellDate(item.sellIn)
      ? AGED_BRIE_BASE_APPRECIATION * EXPIRED_RATE_MULTIPLIER
      : AGED_BRIE_BASE_APPRECIATION;
    return item.withUpdatedState(
      item.sellIn - 1,
      clampStandardQuality(item.quality + increase),
    );
  },
  backstage_pass: (item) => item.withUpdatedState(
    item.sellIn - 1,
    backstagePassQuality(item.sellIn, item.quality),
  ),
  sulfuras: (item) => item,
};

export class InventoryItem {
  readonly name: string;
  readonly category: ItemCategory;
  readonly sellIn: number;
  readonly quality: number;

  private constructor(name: string, category: ItemCategory, sellIn: number, quality: number) {
    this.name = name;
    this.category = category;
    this.sellIn = sellIn;
    this.quality = quality;
  }

  static fromItem(item: Item): InventoryItem {
    return new InventoryItem(
      item.name,
      classifyItemCategory(item.name),
      item.sellIn,
      item.quality,
    );
  }

  withUpdatedState(sellIn: number, quality: number): InventoryItem {
    return new InventoryItem(this.name, this.category, sellIn, quality);
  }

  advanceDay(): InventoryItem {
    return CATEGORY_TRANSITIONS[this.category](this);
  }

  toItem(): Item {
    return new Item(this.name, this.sellIn, this.quality);
  }
}
