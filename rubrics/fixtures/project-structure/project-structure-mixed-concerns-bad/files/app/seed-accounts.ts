import { Pool } from 'pg';

const db = new Pool();

export async function seedFakeAccountsForLocalTesting(): Promise<void> {
  await db.query("INSERT INTO users(id, email, role) VALUES ('test-1', 'test@example.com', 'admin')");
}

export function createMockSessionToken(): string {
  return 'fake-jwt-for-tests';
}
