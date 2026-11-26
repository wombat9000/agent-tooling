import assert from 'node:assert/strict';
import test from 'node:test';
import { StockLedger, formatStockSummary } from '../inventory';

test('handles stock reservation, release, restock, errors, and summary formatting', () => {
  let ledger = StockLedger.withUnits('SKU-10', 10);
  ledger = ledger.reserve('SKU-10', 3);
  assert.equal(ledger.available('SKU-10'), 7);
  assert.throws(() => ledger.reserve('SKU-10', 99));
  assert.throws(() => ledger.reserve('SKU-10', -1));
  ledger = ledger.release('SKU-10', 2);
  assert.equal(ledger.available('SKU-10'), 9);
  ledger = ledger.restock('SKU-10', 5);
  assert.equal(ledger.available('SKU-10'), 14);
  ledger = ledger.restock('SKU-20', 1);
  assert.equal(ledger.available('SKU-20'), 1);
  assert.throws(() => ledger.release('UNKNOWN', 1));
  assert.equal(formatStockSummary(ledger), 'SKU-10:14,SKU-20:1');
});
