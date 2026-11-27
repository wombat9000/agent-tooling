import { expect, test } from '@playwright/test';

test('approves an invoice against mocked first-party APIs so backend never runs', async ({ page }) => {
  await page.route('**/api/invoices/INV-900', (route) =>
    route.fulfill({
      status: 200,
      json: { id: 'INV-900', code: 'INV-900', status: 'pending', amountCents: 99000 },
    }),
  );
  await page.route('**/api/invoices/INV-900/approve', (route) =>
    route.fulfill({
      status: 200,
      json: { id: 'INV-900', code: 'INV-900', status: 'approved', amountCents: 99000 },
    }),
  );

  await page.goto('/invoices/INV-900');
  await page.getByRole('button', { name: 'Approve invoice' }).click();
  await expect(page.getByRole('status')).toHaveText('Approved');
});
