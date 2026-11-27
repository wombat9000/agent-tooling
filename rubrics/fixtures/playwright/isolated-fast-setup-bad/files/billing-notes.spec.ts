import { expect, test } from '@playwright/test';

test('adds a billing note to the shared staging order in an unclosed context', async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();

  await page.goto('/sign-in');
  await page.getByLabel('Email').fill('operator@warehouse.test');
  await page.getByLabel('Password').fill('test-pass-123');
  await page.getByRole('button', { name: 'Sign in' }).click();

  await page.goto('/work-orders/WO-SHARED-001');
  await page.getByLabel('Billing note').fill('Verified manifest');
  await page.getByRole('button', { name: 'Save note' }).click();
  await expect(page.getByText('Verified manifest')).toBeVisible();
});
