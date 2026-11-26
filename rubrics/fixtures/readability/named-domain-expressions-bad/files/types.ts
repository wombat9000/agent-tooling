export type RefundDecision = 'approved' | 'manual_review' | 'rejected';

export interface RefundRequest {
  readonly status: string;
  readonly daysSinceDelivery: number;
  readonly amountCents: number;
  readonly customerIsMember: boolean;
  readonly openedPackaging: boolean;
  readonly receiptCode: string;
  readonly priorRefundsLast90Days: number;
}
