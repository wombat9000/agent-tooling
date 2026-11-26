import assert from 'node:assert/strict';
import test from 'node:test';
import { StockLedger } from '../inventory';

test('releasing a reservation restores available units', () => {
  const reserved = StockLedger.withUnits('SKU-10', 10).reserve('SKU-10', 4);

  const restored = reserved.release('SKU-10', 4);

  assert.equal(restored.available('SKU-10'), 10);
});

test('releasing zero or negative units throws RangeError', () => {
  const ledger = StockLedger.withUnits('SKU-10', 5);

  assert.throws(() => ledger.release('SKU-10', 0), RangeError);
  assert.throws(() => ledger.release('SKU-10', -2), RangeError);
});
