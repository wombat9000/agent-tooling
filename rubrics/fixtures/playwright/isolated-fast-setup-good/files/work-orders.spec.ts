import { expect } from '@playwright/test';
import { test } from './fixtures';

test('dispatches an isolated work order', async ({ page, workOrder }) => {
  await page.goto(`/work-orders/${workOrder.id}`);
  await page.getByRole('button', { name: 'Dispatch order' }).click();

  await expect(page.getByRole('status')).toHaveText('Dispatched');
});

test('cancels an isolated work order with reason', async ({ page, workOrder }) => {
  await page.goto(`/work-orders/${workOrder.id}`);
  await page.getByRole('button', { name: 'Cancel order' }).click();
  await page.getByLabel('Cancellation reason').fill('Duplicate request');
  await page.getByRole('button', { name: 'Confirm cancellation' }).click();

  await expect(page.getByRole('status')).toHaveText('Cancelled');
});

test.describe('unauthenticated sign-in guard', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test('redirects anonymous visitor to sign in', async ({ page }) => {
    await page.goto('/work-orders');
    await expect(page).toHaveURL(/\/sign-in/);
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  });
});
