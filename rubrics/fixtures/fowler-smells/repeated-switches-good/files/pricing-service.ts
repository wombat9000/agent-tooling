import { policyForTier, type MembershipTier } from './membership-tier';

export function discountedPriceCents(tier: MembershipTier, baseCents: number): number {
  const { discountRate } = policyForTier(tier);
  return Math.round(baseCents * (1 - discountRate));
}
