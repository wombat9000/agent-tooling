import type { SystemAlert } from './alert';

export function formatAlertLine(alert: SystemAlert): string {
  return `[${alert.severity.toUpperCase()}] ${alert.id}: ${alert.summary}`;
}
