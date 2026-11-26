import type { IAlertFormatterStrategy, SystemAlert } from './i-alert-formatter';

export class DefaultAlertFormatterStrategy implements IAlertFormatterStrategy {
  format(alert: SystemAlert): string {
    return `[${alert.severity.toUpperCase()}] ${alert.id}: ${alert.summary}`;
  }
}
