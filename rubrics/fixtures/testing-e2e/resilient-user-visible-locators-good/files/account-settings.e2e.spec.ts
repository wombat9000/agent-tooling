import { expect, test } from '@playwright/test';

test('updates notification preference via accessible checkbox and status banner', async ({ page }) => {
  await page.goto('/settings/notifications');
  await page.getByRole('checkbox', { name: 'Weekly digest emails' }).check();
  await page.getByRole('button', { name: 'Save preferences' }).click();

  await expect(page.getByRole('status')).toHaveText('Preferences saved');
});
