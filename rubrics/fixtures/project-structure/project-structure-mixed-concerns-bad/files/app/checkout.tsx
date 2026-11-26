import { createElement } from 'react';
import { Pool } from 'pg';

const db = new Pool();

export async function renderCheckoutAndSaveOrder(orderId: string, subtotalCents: number) {
  const taxCents = Math.round(subtotalCents * 0.08);
  await db.query('INSERT INTO orders(id, total_cents) VALUES ($1, $2)', [orderId, subtotalCents + taxCents]);
  return createElement('section', null, `Order ${orderId}: ${subtotalCents + taxCents}`);
}
