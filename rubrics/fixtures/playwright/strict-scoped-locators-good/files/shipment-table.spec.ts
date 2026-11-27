import { expect, test } from '@playwright/test';

test('dispatches a specific shipment using scoped row and dialog locators', async ({ page }) => {
  await page.goto('/shipments');

  const targetRow = page.getByRole('row').filter({ hasText: 'SHP-4012' });
  await targetRow.getByRole('button', { name: 'Dispatch' }).click();

  const dialog = page.getByRole('dialog', { name: 'Confirm dispatch' });
  await dialog.getByRole('button', { name: 'Confirm' }).click();

  await expect(targetRow.getByRole('cell', { name: 'Dispatched' })).toBeVisible();
});

test('verifies priority sort order and non-semantic throughput canvas', async ({ page }) => {
  await page.goto('/shipments?sort=priority-desc');

  const dataRows = page.getByRole('table', { name: 'Shipments' }).locator('tbody').getByRole('row');
  await expect(dataRows.first()).toContainText('Priority 1');
  await expect(dataRows.last()).toContainText('Priority 5');
  await expect(page.getByTestId('throughput-chart-canvas')).toBeVisible();
});
