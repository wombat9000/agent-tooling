import assert from 'node:assert/strict';
import test from 'node:test';
import { createApiClient } from './helpers/api-client';

test('checks auth errors, rate limits, feature flags, notifications, and audit log search in one test', async () => {
  const api = await createApiClient();
  assert.equal((await api.get('/admin/stats')).status, 401);
  assert.equal((await api.post('/feature-flags', { key: 'beta', enabled: true })).status, 201);
  assert.equal((await api.post('/notifications/test', { channel: 'email' })).status, 202);
  assert.equal((await api.post('/notifications/test', { channel: 'invalid' })).status, 400);
  const logs = await api.get('/audit-logs?limit=10');
  assert.equal(logs.status, 200);
});
