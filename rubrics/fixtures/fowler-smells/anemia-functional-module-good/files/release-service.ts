import { recordTicketApproval, type ReleaseTicket } from './release-ticket';

export interface TicketRepository {
  findById(ticketId: string): Promise<ReleaseTicket | null>;
  save(ticket: ReleaseTicket): Promise<void>;
}

export async function approveReleaseTicket(
  repo: TicketRepository,
  ticketId: string,
  reviewerId: string,
  nowIso: string,
): Promise<ReleaseTicket> {
  const current = await repo.findById(ticketId);
  if (!current) throw new Error(`Ticket not found: ${ticketId}`);
  const updated = recordTicketApproval(current, reviewerId, nowIso);
  await repo.save(updated);
  return updated;
}
