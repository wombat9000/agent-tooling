import { normalizeFolderLabel, policyForQueue } from './support-routing';
import type { QueuePolicy, TicketRuleRequest } from './types';

export interface StoredTicketRule {
  readonly queue: TicketRuleRequest['queue'];
  readonly folderLabel: string | null;
  readonly policy: QueuePolicy;
}

export function buildTicketRule(request: TicketRuleRequest): StoredTicketRule {
  return {
    queue: request.queue,
    folderLabel: normalizeFolderLabel(request.folderLabel),
    policy: policyForQueue(request.queue),
  };
}
