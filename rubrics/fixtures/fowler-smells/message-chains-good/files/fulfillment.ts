import type { DispatchPlan, FulfillmentOrder } from './types';

const MAX_EXPRESS_WEIGHT_GRAMS = 10_000;

export function planDispatches(orders: readonly FulfillmentOrder[]): DispatchPlan[] {
  return orders
    .filter((order) => order.totalWeightGrams() > 0)
    .map((order) => ({
      orderId: order.id,
      destinationCountry: order.shippingCountryCode(),
      carrierLane:
        order.isExpressEligible() && order.totalWeightGrams() <= MAX_EXPRESS_WEIGHT_GRAMS
          ? 'express'
          : 'standard',
    }));
}
