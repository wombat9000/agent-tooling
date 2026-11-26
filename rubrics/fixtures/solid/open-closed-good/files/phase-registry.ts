import type { PhaseDefinition, WorkflowPhase } from './workflow-states';

export const PHASE_DEFINITIONS: Record<WorkflowPhase, PhaseDefinition> = {
  intake: {
    nextPhase: 'triage',
    slaHours: 4,
    canAdvance: (c) => c.summaryNotes.trim().length > 0,
    statusBanner: (c) => `Case ${c.id} awaiting initial intake details`,
  },
  triage: {
    nextPhase: 'review',
    slaHours: 12,
    canAdvance: (c) => c.assignedOwnerId !== null,
    statusBanner: (c) => `Case ${c.id} in triage`,
  },
  review: {
    nextPhase: 'approved',
    slaHours: 24,
    canAdvance: (c) => c.approvalsReceived >= 2,
    statusBanner: (c) => `Case ${c.id} needs ${Math.max(0, 2 - c.approvalsReceived)} more approval(s)`,
  },
  approved: {
    nextPhase: 'closed',
    slaHours: 48,
    canAdvance: () => true,
    statusBanner: (c) => `Case ${c.id} approved and ready to close`,
  },
  closed: {
    nextPhase: null,
    slaHours: 0,
    canAdvance: () => false,
    statusBanner: (c) => `Case ${c.id} closed`,
  },
};
