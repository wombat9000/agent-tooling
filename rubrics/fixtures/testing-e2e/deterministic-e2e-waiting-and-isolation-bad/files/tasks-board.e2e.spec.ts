import { expect, test } from '@playwright/test';

let sharedCreatedTitle = '';

test.describe.serial('order-dependent board tests with fixed sleeps', () => {
  test('1. creates a task and waits blindly with waitForTimeout', async ({ page }) => {
    sharedCreatedTitle = 'Shared Task From Test 1';
    await page.goto('/board');
    await page.getByLabel('New task title').fill(sharedCreatedTitle);
    await page.getByRole('button', { name: 'Add task' }).click();
    await page.waitForTimeout(3_000);

    const visible = await page.getByText(sharedCreatedTitle).isVisible();
    expect(visible).toBe(true);
  });

  test('2. depends on task left behind by test 1', async ({ page }) => {
    await page.goto('/board');
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    await page.getByText(sharedCreatedTitle).click();
    await page.getByRole('button', { name: 'Archive' }).click();
    await page.waitForTimeout(1_500);

    expect(await page.getByText(sharedCreatedTitle).count()).toBe(0);
  });
});
