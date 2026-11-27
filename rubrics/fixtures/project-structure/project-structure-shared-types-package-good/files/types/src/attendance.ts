export type AttendanceStatus = 'present' | 'late' | 'absent' | 'excused';

export interface AttendanceRecord {
  readonly sessionId: string;
  readonly learnerId: string;
  readonly status: AttendanceStatus;
}
