export type SubmissionStatus = 'draft' | 'submitted' | 'graded';

export interface SubmissionRecord {
  readonly id: string;
  readonly assignmentId: string;
  readonly learnerId: string;
  readonly status: SubmissionStatus;
}
