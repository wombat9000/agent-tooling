import { test as base, expect } from '@playwright/test';

export interface SeededWorkOrder {
  id: string;
  code: string;
}

export const test = base.extend<{ workOrder: SeededWorkOrder }>({
  workOrder: async ({ request }, use, testInfo) => {
    const suffix = `${testInfo.parallelIndex}-${testInfo.retry}-${Date.now()}`;
    const createRes = await request.post('/api/work-orders', {
      data: { code: `WO-${suffix}`, site: 'North Hub', priority: 'standard' },
    });
    expect(createRes.status()).toBe(201);
    const created = (await createRes.json()) as SeededWorkOrder;

    try {
      await use(created);
    } finally {
      await request.delete(`/api/work-orders/${created.id}`);
    }
  },
});
