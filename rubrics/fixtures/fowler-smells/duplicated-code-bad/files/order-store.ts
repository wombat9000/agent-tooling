import type { PricingBreakdown } from './types';

export interface OrderStore {
  saveOrder(id: string, breakdown: PricingBreakdown): Promise<void>;
}
