import { expect, test } from '@playwright/test';

test('dispatches shipment using CSS chains, XPath, and positional nth crutches', async ({ page }) => {
  await page.goto('/shipments');

  await page.locator('.shipment-table > tbody > tr:nth-child(3) .row-actions > div button.primary').click();
  await page.locator('//div[@class="modal-shell"]/div[2]/button[1]').click();

  const statusCell = page.locator('.shipment-table tbody tr').nth(2).locator('td').first();
  await expect(statusCell).toHaveText('Dispatched');
});
