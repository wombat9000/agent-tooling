import { expect, test } from '@playwright/test';

test.describe.serial('work order lifecycle', () => {
  let createdOrderId = '';

  test.beforeEach(async ({ page }) => {
    await page.goto('/sign-in');
    await page.getByLabel('Email').fill('operator@warehouse.test');
    await page.getByLabel('Password').fill('test-pass-123');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
  });

  test('creates a work order through the multi-screen UI wizard', async ({ page }) => {
    await page.goto('/work-orders/new');
    await page.getByLabel('Site').fill('North Hub');
    await page.getByRole('button', { name: 'Next' }).click();
    await page.getByLabel('Item SKU').fill('SKU-900');
    await page.getByRole('button', { name: 'Next' }).click();
    await page.getByRole('button', { name: 'Create work order' }).click();

    await expect(page).toHaveURL(/\/work-orders\/[a-z0-9-]+$/);
    createdOrderId = page.url().split('/').pop() ?? '';
  });

  test('dispatches the work order created by the previous test', async ({ page }) => {
    await page.goto(`/work-orders/${createdOrderId}`);
    await page.getByRole('button', { name: 'Dispatch order' }).click();
    await expect(page.getByRole('status')).toHaveText('Dispatched');
  });

  test('archives the dispatched work order', async ({ page }) => {
    await page.goto(`/work-orders/${createdOrderId}`);
    await page.getByRole('button', { name: 'Archive order' }).click();
    await expect(page.getByRole('status')).toHaveText('Archived');
  });
});
