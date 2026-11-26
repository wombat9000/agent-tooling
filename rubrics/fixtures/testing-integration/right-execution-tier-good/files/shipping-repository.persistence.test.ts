import assert from 'node:assert/strict';
import test from 'node:test';
import { startPostgresTestRepo } from './helpers/postgres-test-repo';

test('enforces unique quote ID constraint at the database layer', async () => {
  const repo = await startPostgresTestRepo();
  await repo.saveQuote('q-1', 650);
  await assert.rejects(() => repo.saveQuote('q-1', 900), /unique constraint/i);
});
