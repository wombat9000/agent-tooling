import { expect } from '@playwright/test';
import { BasePage } from './base.page';

export class CaseDetailPage extends BasePage {
  readonly routePath = '/review-queue';

  async openAndVerifyApprovalFlow(caseCode: string, note: string): Promise<void> {
    await this.open();
    await this.page.getByRole('row').filter({ hasText: caseCode }).getByRole('link', { name: 'Inspect case' }).click();
    await this.fillInputByLabel('Approval note', note);
    await this.clickPrimaryButton('Approve claim');
    await this.page.getByRole('dialog', { name: 'Confirm approval' }).getByRole('button', { name: 'Confirm' }).click();
    await expect(this.page.getByRole('status')).toHaveText('Approved');
    await expect(this.page.getByRole('region', { name: 'Audit trail' })).toContainText(note);
  }

  async verifyEverythingLoaded(): Promise<void> {
    await expect(this.page.getByRole('heading')).toBeVisible();
    await expect(this.page.getByRole('navigation')).toBeVisible();
    await expect(this.page.getByRole('main')).toBeVisible();
  }
}
