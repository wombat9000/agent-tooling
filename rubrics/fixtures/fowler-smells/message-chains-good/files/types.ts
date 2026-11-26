export interface FulfillmentOrder {
  readonly id: string;
  shippingCountryCode(): string;
  isExpressEligible(): boolean;
  totalWeightGrams(): number;
}

export interface DispatchPlan {
  readonly orderId: string;
  readonly destinationCountry: string;
  readonly carrierLane: 'express' | 'standard';
}
