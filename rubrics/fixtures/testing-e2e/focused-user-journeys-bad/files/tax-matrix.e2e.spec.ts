import { expect, test } from '@playwright/test';

const TAX_MATRIX = [
  ['US-CA', '100', '108.25'], ['US-CA', '101', '109.33'], ['US-CA', '999', '1081.42'],
  ['US-NY', '100', '108.88'], ['US-NY', '101', '109.96'], ['US-NY', '999', '1087.66'],
  ['US-TX', '100', '106.25'], ['US-TX', '101', '107.31'], ['US-TX', '999', '1061.44'],
  ['US-OR', '100', '100.00'], ['US-OR', '101', '101.00'], ['US-OR', '999', '999.00'],
  ['DE', '100', '119.00'], ['DE', '101', '120.19'], ['DE', '999', '1188.81'],
  ['FR', '100', '120.00'], ['FR', '101', '121.20'], ['FR', '999', '1198.80'],
] as const;

for (const [region, subtotal, expectedTotal] of TAX_MATRIX) {
  test(`browser tax calculator computes ${region} for $${subtotal}`, async ({ page }) => {
    await page.goto('/calculator');
    await page.getByLabel('Region').selectOption(region);
    await page.getByLabel('Subtotal').fill(subtotal);
    await page.getByRole('button', { name: 'Calculate' }).click();
    await expect(page.getByTestId('total-output')).toHaveText(`$${expectedTotal}`);
  });
}
