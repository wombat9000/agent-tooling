import assert from 'node:assert/strict';
import test, { beforeEach } from 'node:test';
import { createAuthenticatedActor } from './helpers/test-actors';
import { resetDatabase, startTestServer } from './helpers/server';

beforeEach(async () => {
  await resetDatabase();
});

test('POST /projects creates a project retrievable via GET /projects/:id', async () => {
  const server = await startTestServer();
  const actor = await createAuthenticatedActor(server, 'admin');

  const created = await actor.post<{ id: string; name: string }>('/projects', { name: 'Launch Plan' });
  assert.equal(created.status, 201);

  const fetched = await actor.get<{ id: string; name: string }>(`/projects/${created.body.id}`);
  assert.equal(fetched.status, 200);
  assert.equal(fetched.body.name, 'Launch Plan');
});
