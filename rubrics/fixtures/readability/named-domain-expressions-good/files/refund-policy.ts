import type { RefundDecision, RefundRequest } from './types';

const STANDARD_RETURN_WINDOW_DAYS = 14;
const MEMBER_RETURN_WINDOW_DAYS = 30;
const AUTO_APPROVE_LIMIT_CENTS = 5_000;

function isWithinReturnWindow(request: RefundRequest): boolean {
  const allowedDays = request.customerIsMember
    ? MEMBER_RETURN_WINDOW_DAYS
    : STANDARD_RETURN_WINDOW_DAYS;
  return request.daysSinceDelivery <= allowedDays;
}

function qualifiesForInstantApproval(request: RefundRequest): boolean {
  return !request.openedPackaging && request.amountCents <= AUTO_APPROVE_LIMIT_CENTS;
}

export function decideRefund(request: RefundRequest): RefundDecision {
  const isDeliveredOrder = request.status === 'delivered';
  if (!isDeliveredOrder || !isWithinReturnWindow(request)) {
    return 'rejected';
  }
  return qualifiesForInstantApproval(request) ? 'approved' : 'manual_review';
}
