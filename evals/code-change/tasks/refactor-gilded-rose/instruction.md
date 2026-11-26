# Gilded Rose Refactoring

Refactor the legacy inventory update code in `src/gilded-rose.ts` so it is clean, readable, well-structured, and easy to extend, and add support for **Conjured** items.

## Public API

Keep `src/gilded-rose.ts` exporting the existing public `Item` class shape and `GildedRose` API so external callers remain backwards-compatible:

```ts
export class Item {
  name: string;
  sellIn: number;
  quality: number;

  constructor(name: string, sellIn: number, quality: number);
}

export class GildedRose {
  items: Array<Item>;

  constructor(items?: Array<Item>);
  updateQuality(): Array<Item>;
}
```

- `new GildedRose()` with no arguments initializes an empty item list and returns `[]` from `updateQuality()`.
- `updateQuality()` advances inventory by one day, preserves the order of items, updates `this.items`, and returns the updated `Array<Item>`.
- Internal decomposition and pure/immutable domain logic behind this public boundary are encouraged.

## Item Rules

Each call to `updateQuality()` updates every item according to its category:

1. **Normal items** (any item not matched by a special category below):
   - `sellIn` decreases by `1`.
   - `quality` decreases by `1` when `sellIn > 0` before the update, and by `2` once the sell date has passed (`sellIn <= 0` before the update).
   - `quality` never drops below `0`.

2. **`Aged Brie`**:
   - `sellIn` decreases by `1`.
   - `quality` increases by `1` when `sellIn > 0` before the update, and by `2` once `sellIn <= 0` before the update.
   - `quality` never increases above `50`.

3. **`Backstage passes to a TAFKAL80ETC concert`**:
   - `sellIn` decreases by `1`.
   - When `sellIn > 10` before the update, `quality` increases by `1`.
   - When `6 <= sellIn <= 10` before the update, `quality` increases by `2`.
   - When `1 <= sellIn <= 5` before the update, `quality` increases by `3`.
   - `quality` never increases above `50`.
   - Once the concert has passed (`sellIn <= 0` before the update), `quality` drops to `0`.

4. **`Sulfuras, Hand of Ragnaros`**:
   - Legendary item: `sellIn` and `quality` never change, even when `quality` is `80` or `sellIn` is negative.

5. **`Conjured` items** (new requirement):
   - Any item whose `name` starts with `"Conjured"` (for example, `"Conjured Mana Cake"`).
   - `sellIn` decreases by `1` each day.
   - `quality` degrades twice as fast as normal items: `-2` per day when `sellIn > 0` before the update, and `-4` per day once `sellIn <= 0` before the update.
   - `quality` never drops below `0` (for example, a Conjured item with `quality` `1` floors cleanly to `0`).

## Tests and Verification

- Keep production code under `src/` and add thorough, maintainable unit tests under `tests/` using Node's built-in test runner (`node:test` and `node:assert/strict`) covering all item categories, boundaries, and multi-day behavior.
- Verify with `pnpm typecheck` and `pnpm test`.
