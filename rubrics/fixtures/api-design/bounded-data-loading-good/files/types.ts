export type MemberStatus = 'active' | 'paused' | 'archived';
export type MemberTier = 'starter' | 'growth' | 'enterprise';

export interface MemberListItem {
  readonly id: string;
  readonly fullName: string;
  readonly email: string;
  readonly status: MemberStatus;
  readonly tier: MemberTier;
  readonly openTicketCount: number;
  readonly lastActiveAtIso: string;
}

export interface MemberSummaryResponse {
  readonly totalMembers: number;
  readonly countsByTier: Readonly<Record<MemberTier, number>>;
}

export interface PagedResponse<T> {
  readonly items: readonly T[];
  readonly nextCursor: string | null;
  readonly hasMore: boolean;
}

export interface MemberQueryParams {
  readonly query?: string;
  readonly status?: MemberStatus;
  readonly cursor?: string | null;
  readonly limit?: number;
}

export interface UserNotificationPreference {
  readonly channel: 'email' | 'sms' | 'in_app';
  readonly enabled: boolean;
}
