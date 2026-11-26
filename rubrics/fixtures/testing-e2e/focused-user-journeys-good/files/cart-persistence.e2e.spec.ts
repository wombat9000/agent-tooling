import { expect, test } from '@playwright/test';

test('retains added cart items across a full page reload', async ({ page }) => {
  await page.goto('/products/ergonomic-chair');
  await page.getByRole('button', { name: 'Add to cart' }).click();
  await expect(page.getByRole('link', { name: 'Cart (1)' })).toBeVisible();

  await page.reload();

  await expect(page.getByRole('link', { name: 'Cart (1)' })).toBeVisible();
});
