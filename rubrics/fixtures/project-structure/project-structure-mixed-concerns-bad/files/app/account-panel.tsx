import { createElement } from 'react';
import { Pool } from 'pg';

const db = new Pool();

export async function AccountSettingsPanel({ userId }: { userId: string }) {
  const result = await db.query('SELECT email, role FROM users WHERE id = $1', [userId]);
  return createElement('div', null, JSON.stringify(result.rows[0] ?? null));
}
