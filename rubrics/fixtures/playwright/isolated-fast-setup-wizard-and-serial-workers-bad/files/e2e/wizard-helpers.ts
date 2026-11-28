import { expect, type Page } from '@playwright/test';

export async function createCaseThroughUiWizard(page: Page, title: string): Promise<void> {
  await page.goto('/cases/new');
  await page.getByLabel('Case title').fill(title);
  await page.getByRole('button', { name: 'Continue' }).click();

  await page.getByLabel('Department').selectOption('Operations');
  await page.getByLabel('Priority').selectOption('Standard');
  await page.getByRole('button', { name: 'Continue' }).click();

  await page.getByLabel('Summary').fill('Initial intake summary');
  await page.getByRole('button', { name: 'Continue' }).click();

  await page.getByRole('button', { name: 'Create case' }).click();
  await expect(page.getByRole('heading', { name: title })).toBeVisible();
}
