import type { CaseSnapshot, WorkflowPhase } from './workflow-states';

export function nextPhaseFor(phase: WorkflowPhase): WorkflowPhase | null {
  if (phase === 'intake') return 'triage';
  if (phase === 'triage') return 'review';
  if (phase === 'review') return 'approved';
  if (phase === 'approved') return 'closed';
  return null;
}

export function canAdvanceCase(snapshot: CaseSnapshot): boolean {
  if (snapshot.phase === 'intake') return snapshot.summaryNotes.trim().length > 0;
  if (snapshot.phase === 'triage') return snapshot.assignedOwnerId !== null;
  if (snapshot.phase === 'review') return snapshot.approvalsReceived >= 2;
  if (snapshot.phase === 'approved') return true;
  return false;
}

export function slaHoursForPhase(phase: WorkflowPhase): number {
  if (phase === 'intake') return 4;
  if (phase === 'triage') return 12;
  if (phase === 'review') return 24;
  if (phase === 'approved') return 48;
  return 0;
}

export function bannerForCase(snapshot: CaseSnapshot): string {
  if (snapshot.phase === 'intake') return `Case ${snapshot.id} awaiting initial intake details`;
  if (snapshot.phase === 'triage') return `Case ${snapshot.id} in triage`;
  if (snapshot.phase === 'review') return `Case ${snapshot.id} awaiting review approvals`;
  if (snapshot.phase === 'approved') return `Case ${snapshot.id} approved and ready to close`;
  return `Case ${snapshot.id} closed`;
}

export function advanceCase(snapshot: CaseSnapshot): CaseSnapshot {
  const next = nextPhaseFor(snapshot.phase);
  if (!next || !canAdvanceCase(snapshot)) {
    throw new Error(`Case ${snapshot.id} cannot advance from ${snapshot.phase}`);
  }
  return { ...snapshot, phase: next };
}
