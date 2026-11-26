import type { Money, PlanTier, Subscription } from './types';

const MONTHLY_PRICE: Record<PlanTier, Money> = {
  free: { amountCents: 0, currency: 'USD' },
  pro: { amountCents: 2900, currency: 'USD' },
  enterprise: { amountCents: 14900, currency: 'USD' },
};

const ANNUAL_BILLING_MONTHS = 10;

export function calculatePeriodPrice(subscription: Subscription): Money {
  const monthly = MONTHLY_PRICE[subscription.tier];
  if (subscription.billingCycle === 'monthly') {
    return monthly;
  }
  return {
    amountCents: monthly.amountCents * ANNUAL_BILLING_MONTHS,
    currency: monthly.currency,
  };
}
