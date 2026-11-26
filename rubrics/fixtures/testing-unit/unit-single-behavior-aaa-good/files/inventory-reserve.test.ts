import assert from 'node:assert/strict';
import test from 'node:test';
import { StockLedger } from '../inventory';

test('reserving available units decreases remaining quantity', () => {
  const ledger = StockLedger.withUnits('SKU-10', 10);

  const updated = ledger.reserve('SKU-10', 3);

  assert.equal(updated.available('SKU-10'), 7);
});

test('reserving more units than available throws InsufficientStockError', () => {
  const ledger = StockLedger.withUnits('SKU-10', 2);

  assert.throws(() => ledger.reserve('SKU-10', 5), { name: 'InsufficientStockError' });
});
