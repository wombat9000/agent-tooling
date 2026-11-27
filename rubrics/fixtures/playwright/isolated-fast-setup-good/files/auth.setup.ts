import { expect, test as setup } from '@playwright/test';

const AUTH_FILE = 'playwright/.auth/operator.json';

setup('authenticate operator session once', async ({ request }) => {
  const response = await request.post('/api/auth/session', {
    data: {
      email: process.env.E2E_OPERATOR_EMAIL ?? 'operator@warehouse.test',
      password: process.env.E2E_OPERATOR_PASSWORD ?? 'test-pass-123',
    },
  });
  expect(response.ok()).toBe(true);
  await request.storageState({ path: AUTH_FILE });
});
