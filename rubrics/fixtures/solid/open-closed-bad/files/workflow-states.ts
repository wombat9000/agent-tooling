export type WorkflowPhase = 'intake' | 'triage' | 'review' | 'approved' | 'closed';

export interface CaseSnapshot {
  readonly id: string;
  readonly phase: WorkflowPhase;
  readonly assignedOwnerId: string | null;
  readonly approvalsReceived: number;
  readonly summaryNotes: string;
}
