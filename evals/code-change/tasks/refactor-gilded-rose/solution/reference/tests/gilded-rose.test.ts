import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { GildedRose, Item } from '../src/gilded-rose.ts';

function advance(item: Item, days = 1): Item {
  const shop = new GildedRose([item]);
  let result = shop.items;
  for (let day = 0; day < days; day += 1) {
    result = shop.updateQuality();
  }
  return result[0];
}

describe('GildedRose', () => {
  describe('normal items', () => {
    it('decreases sellIn and quality by 1 before the sell date', () => {
      const updated = advance(new Item('Elixir of the Mongoose', 5, 7));
      assert.deepEqual({ sellIn: updated.sellIn, quality: updated.quality }, { sellIn: 4, quality: 6 });
    });

    it('decreases quality by 2 once the sell date has passed', () => {
      const onSellDate = advance(new Item('+5 Dexterity Vest', 0, 10));
      assert.deepEqual({ sellIn: onSellDate.sellIn, quality: onSellDate.quality }, { sellIn: -1, quality: 8 });

      const afterSellDate = advance(new Item('+5 Dexterity Vest', -2, 10));
      assert.deepEqual({ sellIn: afterSellDate.sellIn, quality: afterSellDate.quality }, { sellIn: -3, quality: 8 });
    });

    it('floors quality at 0', () => {
      assert.equal(advance(new Item('Elixir of the Mongoose', 5, 0)).quality, 0);
      assert.equal(advance(new Item('Elixir of the Mongoose', 0, 1)).quality, 0);
    });
  });

  describe('Aged Brie', () => {
    it('increases quality by 1 before sell date and by 2 once expired', () => {
      const before = advance(new Item('Aged Brie', 2, 10));
      assert.deepEqual({ sellIn: before.sellIn, quality: before.quality }, { sellIn: 1, quality: 11 });

      const expired = advance(new Item('Aged Brie', 0, 10));
      assert.deepEqual({ sellIn: expired.sellIn, quality: expired.quality }, { sellIn: -1, quality: 12 });
    });

    it('caps quality at 50', () => {
      assert.equal(advance(new Item('Aged Brie', 3, 50)).quality, 50);
      assert.equal(advance(new Item('Aged Brie', 0, 49)).quality, 50);
    });
  });

  describe('Backstage passes', () => {
    const concertPass = 'Backstage passes to a TAFKAL80ETC concert';

    it('increases quality by 1, 2, and 3 across the approaching concert tiers', () => {
      assert.equal(advance(new Item(concertPass, 11, 20)).quality, 21);
      assert.equal(advance(new Item(concertPass, 10, 20)).quality, 22);
      assert.equal(advance(new Item(concertPass, 6, 20)).quality, 22);
      assert.equal(advance(new Item(concertPass, 5, 20)).quality, 23);
      assert.equal(advance(new Item(concertPass, 1, 20)).quality, 23);
    });

    it('drops quality to 0 after the concert and never exceeds 50 before it', () => {
      assert.equal(advance(new Item(concertPass, 0, 35)).quality, 0);
      assert.equal(advance(new Item(concertPass, 10, 49)).quality, 50);
      assert.equal(advance(new Item(concertPass, 5, 48)).quality, 50);
    });
  });

  describe('Sulfuras', () => {
    it('never alters sellIn or quality regardless of sellIn sign', () => {
      for (const sellIn of [5, 0, -3]) {
        const updated = advance(new Item('Sulfuras, Hand of Ragnaros', sellIn, 80), 4);
        assert.deepEqual({ sellIn: updated.sellIn, quality: updated.quality }, { sellIn, quality: 80 });
      }
    });
  });

  describe('Conjured items', () => {
    it('degrades quality twice as fast as normal items before and after sell date', () => {
      const before = advance(new Item('Conjured Mana Cake', 3, 6));
      assert.deepEqual({ sellIn: before.sellIn, quality: before.quality }, { sellIn: 2, quality: 4 });

      const onExpiry = advance(new Item('Conjured Mana Cake', 0, 6));
      assert.deepEqual({ sellIn: onExpiry.sellIn, quality: onExpiry.quality }, { sellIn: -1, quality: 2 });
    });

    it('floors quality cleanly at 0 and handles multi-day progression', () => {
      assert.equal(advance(new Item('Conjured Mana Cake', 5, 1)).quality, 0);
      assert.equal(advance(new Item('Conjured Mana Cake', 0, 3)).quality, 0);

      const afterFiveDays = advance(new Item('Conjured Healing Potion', 2, 13), 5);
      assert.deepEqual({ sellIn: afterFiveDays.sellIn, quality: afterFiveDays.quality }, { sellIn: -3, quality: 0 });
    });
  });

  describe('boundary behavior', () => {
    it('handles empty inventory and preserves caller-owned input objects', () => {
      const empty = new GildedRose();
      assert.deepEqual(empty.updateQuality(), []);

      const callerItem = new Item('Conjured Mana Cake', 3, 6);
      const shop = new GildedRose([callerItem]);
      const [updated] = shop.updateQuality();

      assert.equal(updated.sellIn, 2);
      assert.equal(updated.quality, 4);
      assert.equal(callerItem.sellIn, 3);
      assert.equal(callerItem.quality, 6);
    });
  });
});
