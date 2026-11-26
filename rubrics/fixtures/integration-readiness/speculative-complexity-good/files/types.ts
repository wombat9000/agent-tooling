export type TicketStatus = 'open' | 'pending' | 'closed';

export interface SupportTicket {
  readonly id: string;
  readonly title: string;
  readonly status: TicketStatus;
  readonly assigneeId: string | null;
}

export interface TicketFilter {
  readonly status?: TicketStatus;
  readonly unassignedOnly?: boolean;
}
