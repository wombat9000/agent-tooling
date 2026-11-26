import type { UsageSample } from './usage-metrics';

export function formatUsageCsv(samples: readonly UsageSample[]): string {
  return [
    'tenant_id,requests,errors',
    ...samples.map((s) => `${s.tenantId},${s.requestCount},${s.errorCount}`),
  ].join('\n');
}
