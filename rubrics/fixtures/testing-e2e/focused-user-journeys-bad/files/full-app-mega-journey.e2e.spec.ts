import { expect, test } from '@playwright/test';

test('entire application journey: signup, profile, workspace, billing, invoices, search, theme, errors, and deletion', async ({ page }) => {
  await page.goto('/signup');
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  await page.getByLabel('Work email').fill('mega@example.com');
  await page.getByLabel('Password').fill('SuperSecret!123');
  await page.getByRole('button', { name: 'Create account' }).click();

  await page.goto('/profile');
  await page.getByLabel('Display name').fill('Workspace Owner');
  await page.getByRole('button', { name: 'Save profile' }).click();
  await expect(page.getByRole('status')).toHaveText('Saved');

  await page.goto('/workspaces/new');
  await page.getByLabel('Workspace name').fill('Operations');
  await page.getByRole('button', { name: 'Create workspace' }).click();

  await page.goto('/billing');
  await page.getByRole('button', { name: 'Upgrade to Pro' }).click();
  await expect(page.getByText('Pro Plan')).toBeVisible();

  await page.goto('/invoices');
  await page.getByRole('button', { name: 'Export CSV' }).click();

  await page.goto('/search');
  await page.getByRole('searchbox').fill('Operations');
  await expect(page.getByText('Operations')).toBeVisible();

  await page.getByRole('button', { name: 'Toggle dark mode' }).click();
  await page.goto('/settings/danger');
  await page.getByRole('button', { name: 'Delete account' }).click();
  await expect(page).toHaveURL('/goodbye');
});
