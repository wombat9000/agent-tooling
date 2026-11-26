import assert from 'node:assert/strict';
import test from 'node:test';
import { db, startTestServer } from './helpers/server';

const MAGIC_ADMIN_ID = '00000000-0000-0000-0000-000000000001';

async function copyPastedSetupAdminToken(): Promise<string> {
  await db.query(
    "INSERT INTO users(id, email, role) VALUES ($1, 'admin@example.com', 'admin') ON CONFLICT DO NOTHING",
    [MAGIC_ADMIN_ID],
  );
  return 'static-test-token-1';
}

test('POST /projects creates a project and verifies row directly with raw SQL', async () => {
  const server = await startTestServer();
  const token = await copyPastedSetupAdminToken();

  const res = await server.post<{ id: string }>('/projects', { name: 'Launch Plan' }, { authorization: `Bearer ${token}` });
  assert.equal(res.status, 201);

  const rows = await db.query('SELECT count(*)::int AS cnt FROM projects WHERE id = $1', [res.body.id]);
  assert.equal(rows.rows[0].cnt, 1);
  await db.query('UPDATE projects SET archived = true WHERE id = $1', [res.body.id]);
});
