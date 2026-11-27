import { expect, test } from '@playwright/test';
import { CaseDetailPage } from './pages/case-detail.page';

test('approves claim via opaque page object with zero assertions in spec', async ({ page }) => {
  const casePage = new CaseDetailPage(page);
  await casePage.openAndVerifyApprovalFlow('CLM-4821', 'Verified receipt');
  await casePage.verifyEverythingLoaded();
});

test('escalates and reassigns claims with raw DOM plumbing throughout', async ({ page }) => {
  await page.goto('/review-queue');
  await page.getByRole('combobox', { name: 'Status filter' }).click();
  await page.getByRole('option', { name: 'Pending' }).click();
  await page.getByLabel('Search code').fill('CLM-4822');
  await page.getByRole('button', { name: 'Filter' }).click();
  await page.getByRole('row').filter({ hasText: 'CLM-4822' }).getByRole('link', { name: 'Inspect case' }).click();
  await page.getByRole('tab', { name: 'Documents' }).click();
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('row').filter({ hasText: 'invoice.pdf' }).getByRole('button', { name: 'Download' }).click();
  await downloadPromise;
  await page.getByRole('tab', { name: 'Decision' }).click();
  await page.getByRole('button', { name: 'Escalate' }).click();
  await page.getByRole('dialog', { name: 'Escalation' }).getByRole('combobox', { name: 'Queue' }).click();
  await page.getByRole('option', { name: 'Tier 2 Audit' }).click();
  await page.getByRole('dialog', { name: 'Escalation' }).getByLabel('Escalation note').fill('High value claim');
  await page.getByRole('dialog', { name: 'Escalation' }).getByRole('button', { name: 'Submit escalation' }).click();
  await page.goto('/review-queue');
  await page.getByRole('combobox', { name: 'Status filter' }).click();
  await page.getByRole('option', { name: 'Escalated' }).click();
  await page.getByLabel('Search code').fill('CLM-4822');
  await page.getByRole('button', { name: 'Filter' }).click();
  await page.getByRole('row').filter({ hasText: 'CLM-4822' }).getByRole('link', { name: 'Inspect case' }).click();
  await page.getByRole('button', { name: 'Reassign reviewer' }).click();
  await page.getByRole('dialog', { name: 'Reassign' }).getByRole('combobox', { name: 'Desk' }).click();
  await page.getByRole('option', { name: 'Desk 4B' }).click();
  await page.getByRole('dialog', { name: 'Reassign' }).getByRole('button', { name: 'Save assignment' }).click();
  await expect(page.getByRole('status')).toHaveText('Assigned to Desk 4B');
});
