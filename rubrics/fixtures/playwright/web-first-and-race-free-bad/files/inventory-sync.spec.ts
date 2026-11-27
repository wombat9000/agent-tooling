import { expect, test } from '@playwright/test';

test('synchronizes inventory using legacy ElementHandles, force click, and unawaited expect', async ({ page }) => {
  await page.goto('/inventory');
  await page.waitForSelector('.sync-btn');
  await page.click('.sync-btn', { force: true });
  await page.waitForTimeout(1500);

  const badge = await page.$('.status-badge');
  expect(await badge?.textContent()).toContain('Inventory synced');
  expect(page.getByText('In stock')).toBeVisible();
});
