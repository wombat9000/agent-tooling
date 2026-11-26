import type { SystemAlert } from './alert';
import { formatAlertLine } from './alert-formatter';

export function buildAlertDigest(alerts: readonly SystemAlert[]): string {
  return alerts.map(formatAlertLine).join('\n');
}
