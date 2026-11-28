import { expect, test } from '@playwright/test';
import { createCaseThroughUiWizard } from './wizard-helpers';

test('uploads a supporting document onto an existing case', async ({ page }) => {
  await createCaseThroughUiWizard(page, 'Attachment check');

  await page.getByLabel('Supporting document').setInputFiles('fixtures/invoice.pdf');
  await page.getByRole('button', { name: 'Upload document' }).click();

  await expect(page.getByRole('listitem', { name: /invoice\.pdf/i })).toBeVisible();
});

test('saves reviewer notes on an existing case', async ({ page }) => {
  await createCaseThroughUiWizard(page, 'Reviewer notes check');

  await page.getByLabel('Reviewer notes').fill('Verified serial numbers against packing slip');
  await page.getByRole('button', { name: 'Save notes' }).click();

  await expect(page.getByRole('status')).toHaveText('Notes saved');
});
