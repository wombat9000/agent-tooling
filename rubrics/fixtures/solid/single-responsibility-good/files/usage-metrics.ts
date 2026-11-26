export interface UsageSample {
  readonly tenantId: string;
  readonly requestCount: number;
  readonly errorCount: number;
}

export interface UsageSummary {
  readonly totalRequests: number;
  readonly totalErrors: number;
  readonly errorRate: number;
}

export function summarizeUsage(samples: readonly UsageSample[]): UsageSummary {
  const totalRequests = samples.reduce((sum, s) => sum + s.requestCount, 0);
  const totalErrors = samples.reduce((sum, s) => sum + s.errorCount, 0);
  const errorRate = totalRequests > 0 ? totalErrors / totalRequests : 0;
  return { totalRequests, totalErrors, errorRate };
}
