export interface SessionSchedule {
  readonly id: string;
  readonly cohortId: string;
  readonly startsAtIso: string;
  readonly durationMinutes: number;
}
