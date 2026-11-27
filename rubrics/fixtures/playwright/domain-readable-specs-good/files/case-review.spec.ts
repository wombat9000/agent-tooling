import { expect } from '@playwright/test';
import { test } from './fixtures';

test('approves a pending claim and records the audit entry', async ({ coordinator }) => {
  await coordinator.openPendingCase('CLM-4821');
  await coordinator.approveCase('Verified receipt and policy coverage');

  await expect(coordinator.statusBadge()).toHaveText('Approved');
  await expect(coordinator.auditLog()).toContainText('Verified receipt and policy coverage');
});

test('returns an incomplete claim for revision with the stated reason', async ({ coordinator }) => {
  await coordinator.openPendingCase('CLM-4822');
  await coordinator.requestRevision('Itemized invoice missing tax breakdown');

  await expect(coordinator.statusBadge()).toHaveText('Revision requested');
  await expect(coordinator.auditLog()).toContainText('Itemized invoice missing tax breakdown');
});

test('renders review queue heading directly on the landing route', async ({ page }) => {
  await page.goto('/review-queue');
  await expect(page.getByRole('heading', { name: 'Pending review queue' })).toBeVisible();
});
