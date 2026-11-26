export const AGED_BRIE_NAME = 'Aged Brie';
export const BACKSTAGE_PASS_NAME = 'Backstage passes to a TAFKAL80ETC concert';
export const SULFURAS_NAME = 'Sulfuras, Hand of Ragnaros';
export const CONJURED_NAME_PREFIX = 'Conjured';

export type ItemCategory =
  | 'normal'
  | 'aged_brie'
  | 'backstage_pass'
  | 'sulfuras'
  | 'conjured';

export function classifyItemCategory(name: string): ItemCategory {
  if (name === AGED_BRIE_NAME) return 'aged_brie';
  if (name === BACKSTAGE_PASS_NAME) return 'backstage_pass';
  if (name === SULFURAS_NAME) return 'sulfuras';
  if (name.startsWith(CONJURED_NAME_PREFIX)) return 'conjured';
  return 'normal';
}
