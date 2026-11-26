import { expect, test } from '@playwright/test';

test('completes checkout via brittle CSS chains and nth-child DOM paths', async ({ page }) => {
  await page.goto('/checkout');
  await page.locator('div.layout-shell > main > div.card-v2:nth-child(2) > form > div:nth-child(1) > input.input-sm').fill('120 Market St');
  await page.locator('div.layout-shell > main > div.card-v2:nth-child(2) > form > div:nth-child(2) > input.input-sm').fill('94105');
  await page.locator('div.card-v2 > form > div.actions-row > button.btn-primary.mt-4').nth(0).click();

  await expect(page.locator('section.confirm-wrap > div.header-box > h2.title-lg')).toBeVisible();
  await expect(page.locator('table.summary-grid tbody tr').nth(2).locator('td').nth(1)).toHaveText('$48.00');
});
