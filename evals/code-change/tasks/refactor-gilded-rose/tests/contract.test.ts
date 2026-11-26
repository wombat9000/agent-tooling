import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { GildedRose, Item } from '../src/gilded-rose.ts';

function runDays(item: Item, days: number): Item {
  const shop = new GildedRose([item]);
  let result = shop.items;
  for (let day = 0; day < days; day += 1) {
    result = shop.updateQuality();
  }
  assert.equal(result.length, 1);
  assert.equal(shop.items.length, 1);
  assert.equal(shop.items[0].name, result[0].name);
  assert.equal(shop.items[0].sellIn, result[0].sellIn);
  assert.equal(shop.items[0].quality, result[0].quality);
  return result[0];
}

describe('GildedRose hidden contract tests', () => {
  describe('Normal items', () => {
    it('degrades quality by 1 and sellIn by 1 before the sell date', () => {
      const updated = runDays(new Item('+5 Dexterity Vest', 10, 20), 1);
      assert.equal(updated.sellIn, 9);
      assert.equal(updated.quality, 19);
    });

    it('degrades quality by 1 on the last day before expiry (sellIn = 1)', () => {
      const updated = runDays(new Item('Elixir of the Mongoose', 1, 7), 1);
      assert.equal(updated.sellIn, 0);
      assert.equal(updated.quality, 6);
    });

    it('degrades quality by 2 on and after the sell date', () => {
      const onSellDate = runDays(new Item('Elixir of the Mongoose', 0, 7), 1);
      assert.equal(onSellDate.sellIn, -1);
      assert.equal(onSellDate.quality, 5);

      const pastSellDate = runDays(new Item('Elixir of the Mongoose', -3, 7), 1);
      assert.equal(pastSellDate.sellIn, -4);
      assert.equal(pastSellDate.quality, 5);
    });

    it('never drops quality below 0', () => {
      const alreadyZero = runDays(new Item('Elixir of the Mongoose', 5, 0), 1);
      assert.equal(alreadyZero.sellIn, 4);
      assert.equal(alreadyZero.quality, 0);

      const oddPastExpiry = runDays(new Item('Elixir of the Mongoose', 0, 1), 1);
      assert.equal(oddPastExpiry.sellIn, -1);
      assert.equal(oddPastExpiry.quality, 0);
    });
  });

  describe('Aged Brie', () => {
    it('increases quality by 1 before the sell date', () => {
      const updated = runDays(new Item('Aged Brie', 2, 0), 1);
      assert.equal(updated.sellIn, 1);
      assert.equal(updated.quality, 1);
    });

    it('increases quality by 2 on and after the sell date', () => {
      const onSellDate = runDays(new Item('Aged Brie', 0, 10), 1);
      assert.equal(onSellDate.sellIn, -1);
      assert.equal(onSellDate.quality, 12);

      const pastSellDate = runDays(new Item('Aged Brie', -2, 10), 1);
      assert.equal(pastSellDate.sellIn, -3);
      assert.equal(pastSellDate.quality, 12);
    });

    it('caps quality at 50', () => {
      const atCapBefore = runDays(new Item('Aged Brie', 5, 50), 1);
      assert.equal(atCapBefore.sellIn, 4);
      assert.equal(atCapBefore.quality, 50);

      const nearCapPast = runDays(new Item('Aged Brie', 0, 49), 1);
      assert.equal(nearCapPast.sellIn, -1);
      assert.equal(nearCapPast.quality, 50);

      const atCapPast = runDays(new Item('Aged Brie', -1, 50), 1);
      assert.equal(atCapPast.sellIn, -2);
      assert.equal(atCapPast.quality, 50);
    });
  });

  describe('Backstage passes', () => {
    const passName = 'Backstage passes to a TAFKAL80ETC concert';

    it('increases quality by 1 when more than 10 days remain', () => {
      const farOut = runDays(new Item(passName, 15, 20), 1);
      assert.equal(farOut.sellIn, 14);
      assert.equal(farOut.quality, 21);

      const boundary11 = runDays(new Item(passName, 11, 20), 1);
      assert.equal(boundary11.sellIn, 10);
      assert.equal(boundary11.quality, 21);
    });

    it('increases quality by 2 when 6 to 10 days remain', () => {
      const tenDays = runDays(new Item(passName, 10, 20), 1);
      assert.equal(tenDays.sellIn, 9);
      assert.equal(tenDays.quality, 22);

      const sixDays = runDays(new Item(passName, 6, 20), 1);
      assert.equal(sixDays.sellIn, 5);
      assert.equal(sixDays.quality, 22);
    });

    it('increases quality by 3 when 1 to 5 days remain', () => {
      const fiveDays = runDays(new Item(passName, 5, 20), 1);
      assert.equal(fiveDays.sellIn, 4);
      assert.equal(fiveDays.quality, 23);

      const oneDay = runDays(new Item(passName, 1, 20), 1);
      assert.equal(oneDay.sellIn, 0);
      assert.equal(oneDay.quality, 23);
    });

    it('drops quality to 0 after the concert', () => {
      const onConcertDay = runDays(new Item(passName, 0, 20), 1);
      assert.equal(onConcertDay.sellIn, -1);
      assert.equal(onConcertDay.quality, 0);

      const afterConcert = runDays(new Item(passName, -1, 20), 1);
      assert.equal(afterConcert.sellIn, -2);
      assert.equal(afterConcert.quality, 0);
    });

    it('caps quality at 50 across every tier', () => {
      assert.equal(runDays(new Item(passName, 15, 50), 1).quality, 50);
      assert.equal(runDays(new Item(passName, 10, 49), 1).quality, 50);
      assert.equal(runDays(new Item(passName, 5, 48), 1).quality, 50);
      assert.equal(runDays(new Item(passName, 5, 49), 1).quality, 50);
    });
  });

  describe('Sulfuras', () => {
    const sulfurasName = 'Sulfuras, Hand of Ragnaros';

    it('never changes sellIn or quality for positive, zero, or negative sellIn', () => {
      for (const sellIn of [10, 0, -1]) {
        const updated = runDays(new Item(sulfurasName, sellIn, 80), 3);
        assert.equal(updated.sellIn, sellIn);
        assert.equal(updated.quality, 80);
      }
    });
  });

  describe('Conjured items', () => {
    it('degrades quality by 2 before the sell date', () => {
      const before = runDays(new Item('Conjured Mana Cake', 3, 6), 1);
      assert.equal(before.sellIn, 2);
      assert.equal(before.quality, 4);

      const lastDay = runDays(new Item('Conjured Mana Cake', 1, 6), 1);
      assert.equal(lastDay.sellIn, 0);
      assert.equal(lastDay.quality, 4);
    });

    it('degrades quality by 4 on and after the sell date', () => {
      const onSellDate = runDays(new Item('Conjured Mana Cake', 0, 6), 1);
      assert.equal(onSellDate.sellIn, -1);
      assert.equal(onSellDate.quality, 2);

      const pastSellDate = runDays(new Item('Conjured Mana Cake', -2, 6), 1);
      assert.equal(pastSellDate.sellIn, -3);
      assert.equal(pastSellDate.quality, 2);
    });

    it('floors quality cleanly at 0 for odd and low starting values', () => {
      assert.equal(runDays(new Item('Conjured Mana Cake', 5, 0), 1).quality, 0);
      assert.equal(runDays(new Item('Conjured Mana Cake', 5, 1), 1).quality, 0);
      assert.equal(runDays(new Item('Conjured Mana Cake', 0, 1), 1).quality, 0);
      assert.equal(runDays(new Item('Conjured Mana Cake', 0, 3), 1).quality, 0);
    });

    it('matches any item whose name starts with Conjured and handles multi-day runs', () => {
      const shop = new GildedRose([new Item('Conjured Healing Potion', 2, 13)]);
      const expected = [
        { sellIn: 1, quality: 11 },
        { sellIn: 0, quality: 9 },
        { sellIn: -1, quality: 5 },
        { sellIn: -2, quality: 1 },
        { sellIn: -3, quality: 0 },
      ];
      for (const step of expected) {
        const [item] = shop.updateQuality();
        assert.equal(item.name, 'Conjured Healing Potion');
        assert.equal(item.sellIn, step.sellIn);
        assert.equal(item.quality, step.quality);
      }
    });
  });

  describe('Batch compatibility and ordering', () => {
    it('supports default empty constructor', () => {
      const shop = new GildedRose();
      assert.deepEqual(shop.updateQuality(), []);
      assert.deepEqual(shop.items, []);
    });

    it('preserves item order across all categories over multiple days', () => {
      const shop = new GildedRose([
        new Item('+5 Dexterity Vest', 2, 5),
        new Item('Aged Brie', 1, 48),
        new Item('Sulfuras, Hand of Ragnaros', 0, 80),
        new Item('Backstage passes to a TAFKAL80ETC concert', 6, 45),
        new Item('Conjured Mana Cake', 1, 10),
      ]);

      shop.updateQuality();
      const afterDay2 = shop.updateQuality();

      assert.deepEqual(
        afterDay2.map((item) => ({ name: item.name, sellIn: item.sellIn, quality: item.quality })),
        [
          { name: '+5 Dexterity Vest', sellIn: 0, quality: 3 },
          { name: 'Aged Brie', sellIn: -1, quality: 50 },
          { name: 'Sulfuras, Hand of Ragnaros', sellIn: 0, quality: 80 },
          { name: 'Backstage passes to a TAFKAL80ETC concert', sellIn: 4, quality: 50 },
          { name: 'Conjured Mana Cake', sellIn: -1, quality: 4 },
        ],
      );
      assert.deepEqual(
        shop.items.map((item) => ({ name: item.name, sellIn: item.sellIn, quality: item.quality })),
        afterDay2.map((item) => ({ name: item.name, sellIn: item.sellIn, quality: item.quality })),
      );
    });
  });
});
