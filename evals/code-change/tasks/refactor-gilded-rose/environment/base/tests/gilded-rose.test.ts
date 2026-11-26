import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { GildedRose, Item } from '../src/gilded-rose.ts';

describe('GildedRose', () => {
  it('decreases sellIn and quality for a normal item', () => {
    const gildedRose = new GildedRose([new Item('Elixir of the Mongoose', 5, 7)]);
    const items = gildedRose.updateQuality();
    assert.equal(items[0].name, 'Elixir of the Mongoose');
    assert.equal(items[0].sellIn, 4);
    assert.equal(items[0].quality, 6);
  });
});
