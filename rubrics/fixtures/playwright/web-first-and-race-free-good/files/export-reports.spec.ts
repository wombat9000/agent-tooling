import { expect, test } from '@playwright/test';

test('exports ledger CSV after arming download listener before click', async ({ page, request }) => {
  await page.goto('/reports/ledger');
  await expect(page).toHaveURL(/\/reports\/ledger/);
  await expect(page.getByRole('table', { name: 'Ledger entries' }).getByRole('row')).toHaveCount(4);

  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export CSV' }).click();
  const download = await downloadPromise;

  expect(download.suggestedFilename()).toMatch(/^ledger-\d{4}-\d{2}\.csv$/);

  await expect.poll(async () => {
    const res = await request.get('/api/reports/export-status');
    const body = (await res.json()) as { status: string };
    return body.status;
  }).toBe('completed');
});
