import { expect, test } from '@playwright/test';
import { seedCatalogFixture } from './helpers/seed';

test.beforeEach(async ({ request }) => {
  await seedCatalogFixture(request, ['Desk Lamp', 'Standing Desk', 'Notebook']);
});

test('filters catalog results deterministically using auto-waiting count assertion', async ({ page }) => {
  await page.goto('/catalog');
  await page.getByRole('searchbox', { name: 'Search catalog' }).fill('Desk');

  await expect(page.getByRole('article')).toHaveCount(2);
  await expect(page.getByRole('heading', { name: 'Desk Lamp' })).toBeVisible();
});
