import { expect, test } from '@playwright/test';

test('synchronizes inventory and asserts response status and updated DOM row', async ({ page }) => {
  await page.goto('/inventory');

  const [syncResponse] = await Promise.all([
    page.waitForResponse((res) => res.url().includes('/api/inventory/sync') && res.request().method() === 'POST'),
    page.getByRole('button', { name: 'Sync stock' }).click(),
  ]);

  expect(syncResponse.status()).toBe(200);
  const skuRow = page.getByRole('row').filter({ hasText: 'SKU-401' });
  await expect(skuRow.getByRole('cell', { name: 'In stock' })).toBeVisible();
  await expect(page.getByRole('status')).toHaveText('Inventory synced');
});
