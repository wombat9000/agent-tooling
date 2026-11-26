import assert from 'node:assert/strict';
import test from 'node:test';
import { createApiClient } from './helpers/api-client';

test('cancelling a confirmed booking transitions status to cancelled and issues refund', async () => {
  const api = await createApiClient();
  const { body: booking } = await api.post('/bookings', { roomId: 'room-202', nights: 3 });

  const cancelled = await api.post(`/bookings/${booking.id}/cancel`, {});
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.body.status, 'cancelled');
  assert.equal(cancelled.body.refundIssued, true);
});
