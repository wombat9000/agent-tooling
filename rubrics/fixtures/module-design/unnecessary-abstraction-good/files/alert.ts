export type AlertSeverity = 'info' | 'warning' | 'critical';

export interface SystemAlert {
  readonly id: string;
  readonly severity: AlertSeverity;
  readonly summary: string;
}
