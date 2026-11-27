import { expect, test } from '@playwright/test';

test('shows retryable error banner when settlement endpoint returns 503', async ({ page, request }) => {
  const createRes = await request.post('/api/invoices', {
    data: { code: 'INV-2042', amountCents: 42000, vendor: 'Vendor Beta' },
  });
  expect(createRes.status()).toBe(201);
  const created = (await createRes.json()) as { id: string };

  await page.route('https://tiles.example-cdn.test/**', (route) => route.abort());
  await page.route(`**/api/invoices/${created.id}/settle`, (route) =>
    route.fulfill({ status: 503, json: { error: 'Settlement gateway unavailable' } }),
  );

  await page.goto(`/invoices/${created.id}`);
  await page.getByRole('button', { name: 'Settle payment' }).click();

  await expect(page.getByRole('alert')).toContainText('Settlement gateway unavailable');
  await expect(page.getByRole('button', { name: 'Retry settlement' })).toBeVisible();
});

test('starts draft composer with clean browser storage', async ({ page }) => {
  await page.addInitScript(() => window.localStorage.clear());
  await page.goto('/invoices/new');
  await expect(page.getByLabel('Vendor name')).toHaveValue('');
});
