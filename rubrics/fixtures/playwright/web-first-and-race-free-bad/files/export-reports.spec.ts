import { expect, test } from '@playwright/test';

test('exports ledger CSV using fixed sleeps, one-shot snapshots, and racy download wait', async ({ page }) => {
  await page.goto('/reports/ledger');
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(2500);

  const visible = await page.getByRole('table', { name: 'Ledger entries' }).isVisible();
  expect(visible).toBe(true);
  expect(await page.locator('tbody tr').count()).toBe(3);

  await page.getByRole('button', { name: 'Export CSV' }).click();
  const download = await page.waitForEvent('download');
  expect(download.suggestedFilename()).toContain('.csv');
});
