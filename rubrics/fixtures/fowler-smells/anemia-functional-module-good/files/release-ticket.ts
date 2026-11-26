export type TicketState =
  | { readonly kind: 'draft' }
  | { readonly kind: 'in_review'; readonly submittedAtIso: string; readonly approverIds: readonly string[] }
  | { readonly kind: 'approved'; readonly approvedAtIso: string; readonly approverIds: readonly string[] }
  | { readonly kind: 'rejected'; readonly rejectedAtIso: string; readonly reason: string };

export interface ReleaseTicket {
  readonly id: string;
  readonly authorId: string;
  readonly requiredApprovals: number;
  readonly state: TicketState;
}

export function canApproveTicket(ticket: ReleaseTicket, reviewerId: string): boolean {
  if (ticket.state.kind !== 'in_review') return false;
  if (reviewerId === ticket.authorId) return false;
  return !ticket.state.approverIds.includes(reviewerId);
}

export function remainingApprovals(ticket: ReleaseTicket): number {
  if (ticket.state.kind === 'approved') return 0;
  if (ticket.state.kind !== 'in_review') return ticket.requiredApprovals;
  return Math.max(0, ticket.requiredApprovals - ticket.state.approverIds.length);
}

export function submitTicketForReview(ticket: ReleaseTicket, nowIso: string): ReleaseTicket {
  if (ticket.state.kind !== 'draft') {
    throw new Error(`Ticket ${ticket.id} cannot be submitted from ${ticket.state.kind}`);
  }
  return {
    ...ticket,
    state: { kind: 'in_review', submittedAtIso: nowIso, approverIds: [] },
  };
}

export function recordTicketApproval(ticket: ReleaseTicket, reviewerId: string, nowIso: string): ReleaseTicket {
  if (!canApproveTicket(ticket, reviewerId) || ticket.state.kind !== 'in_review') {
    throw new Error(`Reviewer ${reviewerId} cannot approve ticket ${ticket.id}`);
  }
  const approverIds = [...ticket.state.approverIds, reviewerId];
  const nextState: TicketState = approverIds.length >= ticket.requiredApprovals
    ? { kind: 'approved', approvedAtIso: nowIso, approverIds }
    : { kind: 'in_review', submittedAtIso: ticket.state.submittedAtIso, approverIds };
  return { ...ticket, state: nextState };
}

export function rejectTicket(ticket: ReleaseTicket, reason: string, nowIso: string): ReleaseTicket {
  if (ticket.state.kind !== 'in_review') {
    throw new Error(`Ticket ${ticket.id} cannot be rejected from ${ticket.state.kind}`);
  }
  const trimmedReason = reason.trim();
  if (!trimmedReason) throw new Error('Rejection reason is required');
  return {
    ...ticket,
    state: { kind: 'rejected', rejectedAtIso: nowIso, reason: trimmedReason },
  };
}
