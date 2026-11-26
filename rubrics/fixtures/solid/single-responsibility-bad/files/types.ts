export interface UsageSample {
  readonly tenantId: string;
  readonly requestCount: number;
  readonly errorCount: number;
  readonly planLimit: number;
}
