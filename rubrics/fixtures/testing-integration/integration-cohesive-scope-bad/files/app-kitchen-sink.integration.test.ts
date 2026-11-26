import assert from 'node:assert/strict';
import test from 'node:test';
import { createApiClient } from './helpers/api-client';

test('everything integration flow: signup, profile, rooms, coupons, webhooks, invoices, and admin purge', async () => {
  const api = await createApiClient();

  const badEmail = await api.post('/users', { email: 'not-an-email' });
  assert.equal(badEmail.status, 400);
  const user = await api.post('/users', { email: 'guest@example.com' });
  assert.equal(user.status, 201);

  const profile = await api.patch(`/users/${user.body.id}`, { locale: 'en-US' });
  assert.equal(profile.status, 200);

  const badCoupon = await api.post('/coupons/validate', { code: 'EXPIRED' });
  assert.equal(badCoupon.status, 422);

  const booking = await api.post('/bookings', { userId: user.body.id, roomId: 'room-101', nights: 2 });
  assert.equal(booking.status, 201);

  const webhook = await api.post('/webhooks/stripe', { type: 'payment.succeeded', bookingId: booking.body.id });
  assert.equal(webhook.status, 200);

  const invoice = await api.get(`/invoices/${booking.body.id}`);
  assert.equal(invoice.status, 200);

  const badExport = await api.get('/reports/export?format=unknown');
  assert.equal(badExport.status, 400);

  const cancelled = await api.post(`/bookings/${booking.body.id}/cancel`, {});
  assert.equal(cancelled.status, 200);

  const purge = await api.delete(`/admin/users/${user.body.id}`);
  assert.equal(purge.status, 204);
});
