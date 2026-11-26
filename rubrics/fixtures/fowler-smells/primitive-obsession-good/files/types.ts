export type PlanTier = 'free' | 'pro' | 'enterprise';
export type BillingCycle = 'monthly' | 'annual';
export type SubscriptionStatus = 'trialing' | 'active' | 'past_due' | 'canceled';
export type Currency = 'USD' | 'EUR';

export interface Money {
  readonly amountCents: number;
  readonly currency: Currency;
}

export interface DateRange {
  readonly startIso: string;
  readonly endIso: string;
}

export interface Subscription {
  readonly id: string;
  readonly accountId: string;
  readonly tier: PlanTier;
  readonly billingCycle: BillingCycle;
  readonly status: SubscriptionStatus;
  readonly period: DateRange;
}
