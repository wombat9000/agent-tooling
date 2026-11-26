import type { MatchOperator, QueuePolicy, RoutingQueue } from './types';

export function policyForQueue(queue: RoutingQueue): QueuePolicy {
  switch (queue) {
    case 'urgent-escalation':
      return { slaMinutes: 15, requiresSeniorReviewer: true, pagerChannel: 'oncall-primary' };
    case 'billing-review':
      return { slaMinutes: 120, requiresSeniorReviewer: true, pagerChannel: null };
    case 'standard-inbox':
      return { slaMinutes: 480, requiresSeniorReviewer: false, pagerChannel: null };
  }
}

export function matchesText(candidate: string, operator: MatchOperator, target: string): boolean {
  const left = candidate.toLowerCase();
  const right = target.toLowerCase();
  switch (operator) {
    case 'exact':
      return left === right;
    case 'contains':
      return left.includes(right);
    case 'starts-with':
      return left.startsWith(right);
  }
}

export function normalizeFolderLabel(raw: string | null | undefined): string | null {
  const trimmed = raw?.trim();
  return trimmed ? trimmed : null;
}
