import { expect, test } from '@playwright/test';

test('filters shipments via test IDs on standard buttons, inputs, links, and headings', async ({ page }) => {
  await page.goto('/shipments');

  await page.getByTestId('region-select').selectOption('North Hub');
  await page.getByTestId('shipment-search-input').fill('SHP-40');
  await page.getByTestId('apply-filters-button').click();

  await expect(page.getByTestId('results-heading')).toHaveText('Filtered shipments');
  await page.getByTestId('clear-filters-link').click();
});
