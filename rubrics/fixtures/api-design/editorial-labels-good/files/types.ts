export type RoutingQueue = 'urgent-escalation' | 'billing-review' | 'standard-inbox';
export type MatchOperator = 'exact' | 'contains' | 'starts-with';

export const SUGGESTED_FOLDER_LABELS = ['Onboarding', 'Follow-up', 'Archive'] as const;

export interface TicketRuleRequest {
  readonly queue: RoutingQueue;
  readonly matchOperator: MatchOperator;
  readonly matchValue: string;
  readonly folderLabel: string | null;
}

export interface QueuePolicy {
  readonly slaMinutes: number;
  readonly requiresSeniorReviewer: boolean;
  readonly pagerChannel: string | null;
}
