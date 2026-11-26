export type MembershipTier = 'starter' | 'growth' | 'enterprise';

export interface TierPolicy {
  readonly discountRate: number;
  readonly supportSlaHours: number;
  readonly maxSeats: number;
  readonly renewalGraceDays: number;
}

const TIER_POLICIES: Record<MembershipTier, TierPolicy> = {
  starter: { discountRate: 0, supportSlaHours: 48, maxSeats: 5, renewalGraceDays: 3 },
  growth: { discountRate: 0.1, supportSlaHours: 12, maxSeats: 25, renewalGraceDays: 7 },
  enterprise: { discountRate: 0.2, supportSlaHours: 2, maxSeats: 250, renewalGraceDays: 14 },
};

export function policyForTier(tier: MembershipTier): TierPolicy {
  return TIER_POLICIES[tier];
}
