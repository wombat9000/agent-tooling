import { expect, test } from '@playwright/test';

test('creates a todo, completes it, and restores it after reload', async ({ page }) => {
  await page.goto('/');
  const field = page.getByRole('textbox', { name: 'New todo' });
  await field.fill('Send the invoice');
  await field.press('Enter');
  await page.getByRole('checkbox', { name: 'Send the invoice' }).check();

  await page.getByRole('link', { name: 'Completed', exact: true }).click();
  await page.reload();
  await expect(page.getByRole('checkbox', { name: 'Send the invoice' })).toBeChecked();
});

test('rejects a title made of whitespace', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('textbox', { name: 'New todo' }).fill('  ');
  await page.getByRole('button', { name: 'Add todo' }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.getByRole('checkbox')).toHaveCount(0);
});
