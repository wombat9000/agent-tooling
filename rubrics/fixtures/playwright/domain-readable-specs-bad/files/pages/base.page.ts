import { expect, type Page } from '@playwright/test';

export abstract class BasePage {
  constructor(protected readonly page: Page) {}

  abstract readonly routePath: string;

  async open(): Promise<void> {
    await this.page.goto(this.routePath);
    await this.waitForPageChrome();
  }

  protected async waitForPageChrome(): Promise<void> {
    await expect(this.page.getByRole('banner')).toBeVisible();
  }

  protected async clickPrimaryButton(label: string): Promise<void> {
    await this.page.getByRole('button', { name: label }).click();
  }

  protected async fillInputByLabel(label: string, value: string): Promise<void> {
    await this.page.getByLabel(label).fill(value);
  }
}
