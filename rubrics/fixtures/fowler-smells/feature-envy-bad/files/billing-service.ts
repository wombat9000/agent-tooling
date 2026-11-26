import type { SubscriptionRecord } from './subscription-record';

export function applyFailedPayment(sub: SubscriptionRecord): void {
  sub.failedPaymentAttempts += 1;
  sub.graceDaysRemaining = Math.max(0, sub.graceDaysRemaining - 3);
  if (sub.failedPaymentAttempts >= 3 || sub.graceDaysRemaining === 0) {
    sub.state = 'cancelled';
  } else {
    sub.state = 'past_due';
  }
}

export function upgradeSeats(sub: SubscriptionRecord, additionalSeats: number): void {
  if (sub.state !== 'active' || sub.failedPaymentAttempts > 0) {
    throw new Error('Cannot upgrade seats on delinquent subscription');
  }
  sub.seats += additionalSeats;
  if (sub.seats >= 25 && sub.discountPercent < 15) {
    sub.discountPercent = 15;
  }
}
