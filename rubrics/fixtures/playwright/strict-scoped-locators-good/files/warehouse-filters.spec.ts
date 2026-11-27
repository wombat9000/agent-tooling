import { expect, test } from '@playwright/test';

test('filters warehouse shipments via accessible labels, placeholders, and regions', async ({ page }) => {
  await page.goto('/shipments');

  await page.getByLabel('Region').selectOption('North Hub');
  await page.getByPlaceholder('Search shipment code').fill('SHP-40');
  await page.getByRole('button', { name: 'Apply filters' }).click();

  const activeFilters = page.getByRole('region', { name: 'Active filters' });
  await expect(activeFilters.getByText('North Hub')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Filtered shipments' })).toBeVisible();
});
