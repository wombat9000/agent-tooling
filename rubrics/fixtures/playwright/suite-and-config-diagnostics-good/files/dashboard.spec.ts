import { expect, test } from '@playwright/test';

test('loads executive dashboard metrics via relative baseURL path', async ({ page }) => {
  await page.goto('/dashboard');
  await expect(page.getByRole('heading', { name: 'Operations overview' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'KPI summary' })).toBeVisible();
});

test('downloads scheduled compliance bundle when worker is enabled', async ({ page }) => {
  test.skip(process.env.ENABLE_COMPLIANCE_WORKER !== '1', 'Compliance export worker runs only in staging');

  await page.goto('/dashboard/compliance');
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download bundle' }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/\.zip$/);
});
