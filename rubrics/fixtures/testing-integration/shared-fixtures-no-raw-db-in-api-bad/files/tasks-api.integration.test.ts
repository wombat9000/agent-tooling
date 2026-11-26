import assert from 'node:assert/strict';
import test from 'node:test';
import { db, startTestServer } from './helpers/server';

const MAGIC_ADMIN_ID = '00000000-0000-0000-0000-000000000001';
const MAGIC_PROJECT_ID = '00000000-0000-0000-0000-000000000099';

async function copyPastedSetupAdminToken(): Promise<string> {
  await db.query(
    "INSERT INTO users(id, email, role) VALUES ($1, 'admin@example.com', 'admin') ON CONFLICT DO NOTHING",
    [MAGIC_ADMIN_ID],
  );
  return 'static-test-token-1';
}

test('POST /projects/:id/tasks seeds project with raw SQL and verifies task row via SQL', async () => {
  const server = await startTestServer();
  const token = await copyPastedSetupAdminToken();
  await db.query("INSERT INTO projects(id, name, owner_id) VALUES ($1, 'Roadmap', $2)", [MAGIC_PROJECT_ID, MAGIC_ADMIN_ID]);

  const res = await server.post<{ id: string }>(
    `/projects/${MAGIC_PROJECT_ID}/tasks`,
    { title: 'Draft specification' },
    { authorization: `Bearer ${token}` },
  );
  assert.equal(res.status, 201);

  const row = await db.query('SELECT title FROM tasks WHERE id = $1', [res.body.id]);
  assert.equal(row.rows[0].title, 'Draft specification');
});
