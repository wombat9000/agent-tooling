export type OrderStatus = 'delivered' | 'cancelled' | 'refunded';
export type RefundDecision = 'approved' | 'manual_review' | 'rejected';

export interface RefundRequest {
  readonly status: OrderStatus;
  readonly daysSinceDelivery: number;
  readonly amountCents: number;
  readonly customerIsMember: boolean;
  readonly openedPackaging: boolean;
}
