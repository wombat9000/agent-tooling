import { policyForTier, type MembershipTier } from './membership-tier';

export function canAddSeat(tier: MembershipTier, currentSeats: number): boolean {
  return currentSeats < policyForTier(tier).maxSeats;
}

export function responseDeadlineHours(tier: MembershipTier): number {
  return policyForTier(tier).supportSlaHours;
}
