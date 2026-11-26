export type MembershipTier = 'starter' | 'growth' | 'enterprise';

export interface AccountSummary {
  readonly accountId: string;
  readonly tier: MembershipTier;
  readonly seatCount: number;
}
