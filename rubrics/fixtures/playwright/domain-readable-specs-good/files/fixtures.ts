import { test as base } from '@playwright/test';
import { ReviewQueueDriver } from './drivers/review-queue.driver';

export const test = base.extend<{ coordinator: ReviewQueueDriver }>({
  coordinator: async ({ page }, use) => {
    await use(new ReviewQueueDriver(page));
  },
});
