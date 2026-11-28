import { expect, test } from '@playwright/test';

test('submits intake form and expands details using CSS attribute and ID selector crutches', async ({ page }) => {
  await page.goto('/intake/new');

  await page.locator('[id="applicant-email"]').fill('applicant@example.org');
  await page.locator('#case-summary-field').fill('Requesting quarterly equipment review');
  await page.locator('label input[type="file"]').setInputFiles('fixtures/receipt.pdf');
  await page.locator('#submit-application').click();

  await expect(page.locator('[aria-expanded="true"]')).toBeVisible();
  await expect(page.locator('[data-state="submitted"]')).toContainText('Submitted');
});
