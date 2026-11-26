import assert from 'node:assert/strict';
import test, { beforeEach } from 'node:test';
import { createAuthenticatedActor } from './helpers/test-actors';
import { resetDatabase, startTestServer } from './helpers/server';

beforeEach(async () => {
  await resetDatabase();
});

test('POST /projects/:id/tasks adds a task visible in project task listing', async () => {
  const server = await startTestServer();
  const actor = await createAuthenticatedActor(server, 'admin');
  const project = await actor.post<{ id: string }>('/projects', { name: 'Roadmap' });

  const created = await actor.post<{ id: string; title: string }>(`/projects/${project.body.id}/tasks`, {
    title: 'Draft specification',
  });
  assert.equal(created.status, 201);

  const list = await actor.get<{ items: Array<{ id: string; title: string }> }>(`/projects/${project.body.id}/tasks`);
  assert.equal(list.status, 200);
  assert.ok(list.body.items.some((t) => t.id === created.body.id && t.title === 'Draft specification'));
});
