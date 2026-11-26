import type { RefundDecision, RefundRequest } from './types';

export function decideRefund(r: RefundRequest): RefundDecision {
  if (
    r.status !== 'delivered' ||
    (r.customerIsMember ? r.daysSinceDelivery > 30 : r.daysSinceDelivery > 14) ||
    !/^[A-Z]{2}-\d{6}-[1-9]$/.test(r.receiptCode) ||
    (r.priorRefundsLast90Days >= 3 && r.amountCents > 2500)
  ) {
    return 'rejected';
  }
  return !r.openedPackaging && r.amountCents <= 5000 && (r.customerIsMember || r.priorRefundsLast90Days === 0)
    ? 'approved'
    : r.amountCents > 25000 && !r.customerIsMember && r.daysSinceDelivery > 7
      ? 'rejected'
      : 'manual_review';
}
