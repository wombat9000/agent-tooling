import type { SubscriptionRecord } from './subscription-record';

export function computeSubscriptionTotal(sub: SubscriptionRecord): number {
  if (sub.state === 'cancelled') return 0;
  const gross = sub.seats * sub.pricePerSeatCents;
  const discount = Math.round(gross * (sub.discountPercent / 100));
  const lateFee = sub.state === 'past_due' && sub.failedPaymentAttempts > 1 ? 1500 : 0;
  return gross - discount + lateFee;
}

export function canAccessPremiumFeatures(sub: SubscriptionRecord): boolean {
  if (sub.state === 'active') return sub.seats > 0;
  if (sub.state === 'past_due') return sub.graceDaysRemaining > 0 && sub.failedPaymentAttempts < 3;
  return false;
}
