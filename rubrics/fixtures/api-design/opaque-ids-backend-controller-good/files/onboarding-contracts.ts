export const WORKFLOW_STEP_CODES = ['profile', 'verification', 'confirmation'] as const;
export type WorkflowStepCode = (typeof WORKFLOW_STEP_CODES)[number];

export const DIGEST_PREFERENCES = ['immediate', 'daily', 'weekly'] as const;
export type DigestPreference = (typeof DIGEST_PREFERENCES)[number];

export interface OnboardingSubmissionRecord {
  readonly id: string;
  readonly stepCode: WorkflowStepCode;
  readonly digestPreference: DigestPreference;
  readonly displayName: string;
}
