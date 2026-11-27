export type EnrollmentState = 'pending' | 'active' | 'completed' | 'withdrawn';

export interface EnrollmentRecord {
  readonly id: string;
  readonly cohortId: string;
  readonly accountId: string;
  readonly state: EnrollmentState;
}
