import { expect, test } from '@playwright/test';
import { resetBoardFixture } from './helpers/seed';

test.beforeEach(async ({ request }) => {
  await resetBoardFixture(request);
});

test('creates a task and shows it after async persistence completes', async ({ page }) => {
  await page.goto('/board');
  await page.getByLabel('New task title').fill('Publish release notes');
  await page.getByRole('button', { name: 'Add task' }).click();

  await expect(page.getByRole('status')).toHaveText('Task saved');
  await expect(page.getByRole('listitem').filter({ hasText: 'Publish release notes' })).toBeVisible();
});

test('marks a seeded task complete independently of earlier tests', async ({ page }) => {
  await page.goto('/board');
  const seededRow = page.getByRole('listitem').filter({ hasText: 'Audit dependencies' });
  await seededRow.getByRole('checkbox', { name: 'Complete' }).check();

  await expect(seededRow).toHaveAttribute('data-completed', 'true');
});
