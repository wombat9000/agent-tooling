import type { MembershipTier } from './types';

export function discountRateFor(tier: MembershipTier): number {
  switch (tier) {
    case 'starter': return 0;
    case 'growth': return 0.1;
    case 'enterprise': return 0.2;
  }
}

export function supportSlaHoursFor(tier: MembershipTier): number {
  switch (tier) {
    case 'starter': return 48;
    case 'growth': return 12;
    case 'enterprise': return 2;
  }
}

export function maxSeatsFor(tier: MembershipTier): number {
  switch (tier) {
    case 'starter': return 5;
    case 'growth': return 25;
    case 'enterprise': return 250;
  }
}

export function renewalGraceDaysFor(tier: MembershipTier): number {
  switch (tier) {
    case 'starter': return 3;
    case 'growth': return 7;
    case 'enterprise': return 14;
  }
}

export function badgeLabelFor(tier: MembershipTier): string {
  switch (tier) {
    case 'starter': return 'Starter';
    case 'growth': return 'Growth';
    case 'enterprise': return 'Enterprise';
  }
}
