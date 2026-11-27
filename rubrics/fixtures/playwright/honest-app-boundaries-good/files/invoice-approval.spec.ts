import { expect, test } from '@playwright/test';

test('approves an invoice through the real backend and verifies persistence across reload', async ({ page, request }) => {
  const createRes = await request.post('/api/invoices', {
    data: { code: 'INV-2041', amountCents: 125000, vendor: 'Vendor Alpha' },
  });
  expect(createRes.status()).toBe(201);
  const created = (await createRes.json()) as { id: string };

  await page.goto(`/invoices/${created.id}`);
  await page.getByRole('button', { name: 'Approve invoice' }).click();
  await expect(page.getByRole('status')).toHaveText('Approved');

  await page.reload();
  await expect(page.getByRole('status')).toHaveText('Approved');

  const serverRes = await request.get(`/api/invoices/${created.id}`);
  expect(serverRes.status()).toBe(200);
  expect((await serverRes.json()) as { status: string }).toMatchObject({ status: 'approved' });
});
