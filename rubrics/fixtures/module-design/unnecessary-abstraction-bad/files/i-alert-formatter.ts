export interface SystemAlert {
  readonly id: string;
  readonly severity: 'info' | 'warning' | 'critical';
  readonly summary: string;
}

export interface IAlertFormatterStrategy {
  format(alert: SystemAlert): string;
}
