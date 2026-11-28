import { expect, test } from '@playwright/test';

test('renders active orders queue via relative baseURL path', async ({ page }) => {
  await page.goto('/orders');
  await expect(page.getByRole('heading', { name: 'Active orders' })).toBeVisible();
  await expect(page.getByRole('table', { name: 'Order queue' })).toBeVisible();
});
