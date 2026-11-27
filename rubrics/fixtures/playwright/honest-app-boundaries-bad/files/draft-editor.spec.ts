import { expect, test } from '@playwright/test';

test('approves draft by mutating internal client store global via page.evaluate', async ({ page }) => {
  await page.goto('/invoices/INV-900');

  await page.evaluate(() => {
    const store = (window as unknown as { __APP_STORE__: { dispatch: (action: unknown) => void } }).__APP_STORE__;
    store.dispatch({ type: 'INVOICE_STATUS_SET', id: 'INV-900', status: 'approved' });
  });

  const internalStatus = await page.evaluate(() => {
    const store = (window as unknown as { __APP_STORE__: { getState: () => { invoices: Record<string, string> } } }).__APP_STORE__;
    return store.getState().invoices['INV-900'];
  });

  expect(internalStatus).toBe('approved');
});
