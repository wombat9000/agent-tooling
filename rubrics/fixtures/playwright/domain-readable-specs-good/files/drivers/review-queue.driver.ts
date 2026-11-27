import type { Locator, Page } from '@playwright/test';

export class ReviewQueueDriver {
  constructor(private readonly page: Page) {}

  async openPendingCase(caseCode: string): Promise<void> {
    await this.page.goto('/review-queue');
    const row = this.page.getByRole('row').filter({ hasText: caseCode });
    await row.getByRole('link', { name: 'Inspect case' }).click();
  }

  async approveCase(note: string): Promise<void> {
    await this.page.getByLabel('Approval note').fill(note);
    await this.page.getByRole('button', { name: 'Approve claim' }).click();
    const dialog = this.page.getByRole('dialog', { name: 'Confirm approval' });
    await dialog.getByRole('button', { name: 'Confirm' }).click();
  }

  async requestRevision(reason: string): Promise<void> {
    await this.page.getByRole('button', { name: 'Request revision' }).click();
    const dialog = this.page.getByRole('dialog', { name: 'Revision details' });
    await dialog.getByLabel('Missing documentation').fill(reason);
    await dialog.getByRole('button', { name: 'Send back' }).click();
  }

  statusBadge(): Locator {
    return this.page.getByRole('status');
  }

  auditLog(): Locator {
    return this.page.getByRole('region', { name: 'Audit trail' });
  }
}
