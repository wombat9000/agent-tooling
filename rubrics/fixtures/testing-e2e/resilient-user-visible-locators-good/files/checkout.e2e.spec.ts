import { expect, test } from '@playwright/test';

test('completes checkout using accessible roles, labels, and explicit total test ID', async ({ page }) => {
  await page.goto('/checkout');
  await page.getByLabel('Shipping street').fill('120 Market St');
  await page.getByLabel('Postal code').fill('94105');
  await page.getByRole('button', { name: 'Place order' }).click();

  await expect(page.getByRole('heading', { name: 'Order confirmed' })).toBeVisible();
  await expect(page.getByTestId('order-summary-total')).toHaveText('$48.00');
});
