import { expect, test } from '@playwright/test';

test('updates notification preference via XPath and positional indexes', async ({ page }) => {
  await page.goto('/settings/notifications');
  await page.locator('xpath=//div[@class="settings-grid"]/div[3]/label/input[1]').check();
  await page.locator('.panel-footer > div > button').nth(1).click();

  await expect(page.locator('.toast-container > div:first-child > span.msg-text')).toHaveText('Preferences saved');
});
