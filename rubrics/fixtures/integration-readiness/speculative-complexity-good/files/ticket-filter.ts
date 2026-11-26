import type { SupportTicket, TicketFilter } from './types';

export function filterTickets(
  tickets: readonly SupportTicket[],
  filter: TicketFilter,
): SupportTicket[] {
  return tickets.filter((ticket) => {
    if (filter.status && ticket.status !== filter.status) return false;
    if (filter.unassignedOnly && ticket.assigneeId !== null) return false;
    return true;
  });
}
