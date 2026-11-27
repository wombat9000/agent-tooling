export interface MemberSummary {
  readonly id: string;
  readonly fullName: string;
  readonly email: string;
  readonly status: 'active' | 'paused' | 'archived';
  readonly tier: 'starter' | 'growth' | 'enterprise';
}

export interface MemberDetail extends MemberSummary {
  readonly openTicketCount: number;
  readonly lastActiveAtIso: string;
}

export interface OrderRecord {
  readonly id: string;
  readonly memberId: string;
  readonly totalCents: number;
}

export interface PagedResponse<T> {
  readonly items: readonly T[];
  readonly nextCursor: string | null;
  readonly hasMore: boolean;
}

export interface DashboardSnapshot {
  readonly matchingMembers: readonly MemberDetail[];
  readonly countsByTier: Readonly<Record<MemberSummary['tier'], number>>;
  readonly recentOrders: readonly OrderRecord[];
}
