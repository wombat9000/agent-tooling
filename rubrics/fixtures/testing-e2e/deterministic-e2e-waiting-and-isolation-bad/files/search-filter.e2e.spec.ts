import { expect, test } from '@playwright/test';

test('filters catalog using fixed sleep instead of auto-waiting assertions', async ({ page }) => {
  await page.goto('/catalog');
  await page.getByRole('searchbox', { name: 'Search catalog' }).fill('Desk');
  await page.waitForTimeout(2_500);

  const count = await page.getByRole('article').count();
  expect(count).toBe(2);
});
