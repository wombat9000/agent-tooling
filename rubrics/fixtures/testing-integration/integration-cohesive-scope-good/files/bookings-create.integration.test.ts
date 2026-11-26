import assert from 'node:assert/strict';
import test from 'node:test';
import { createApiClient } from './helpers/api-client';

test('creating a booking reserves the slot and returns confirmed details', async () => {
  const api = await createApiClient();
  const created = await api.post('/bookings', { roomId: 'room-101', nights: 2 });

  assert.equal(created.status, 201);
  assert.equal(created.body.status, 'confirmed');
  assert.equal(created.body.roomId, 'room-101');
});

test('overlapping booking on the same room returns 409 conflict', async () => {
  const api = await createApiClient();
  await api.post('/bookings', { roomId: 'room-101', nights: 2 });

  const duplicate = await api.post('/bookings', { roomId: 'room-101', nights: 2 });
  assert.equal(duplicate.status, 409);
  assert.equal(duplicate.body.errorCode, 'ROOM_UNAVAILABLE');
});
