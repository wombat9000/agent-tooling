import { expect, test } from '@playwright/test';

test.only('loads executive dashboard via hardcoded localhost URL', async ({ page }) => {
  await page.goto('http://localhost:5173/dashboard');
  await expect(page.getByRole('heading', { name: 'Operations overview' })).toBeVisible();
});

test.skip('filters quarterly revenue', async ({ page }) => {
  await page.goto('http://localhost:5173/dashboard/revenue');
  await page.getByRole('button', { name: 'Q4' }).click();
  await expect(page.getByRole('table')).toBeVisible();
});
