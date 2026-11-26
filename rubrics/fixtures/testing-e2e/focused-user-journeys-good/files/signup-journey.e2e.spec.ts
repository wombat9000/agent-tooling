import { expect, test } from '@playwright/test';

test('shows validation feedback when required signup fields are blank', async ({ page }) => {
  await page.goto('/signup');
  await page.getByRole('button', { name: 'Create account' }).click();

  await expect(page.getByRole('alert')).toContainText('Work email is required');
});

test('completes account signup and redirects to workspace onboarding', async ({ page }) => {
  await page.goto('/signup');
  await page.getByLabel('Work email').fill('new-user@example.com');
  await page.getByLabel('Password').fill('Correct-Horse-Battery-99');
  await page.getByRole('button', { name: 'Create account' }).click();

  await expect(page).toHaveURL(/\/onboarding$/);
  await expect(page.getByRole('heading', { name: 'Set up your workspace' })).toBeVisible();
});
