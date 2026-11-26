import { isAnalyticsV2Enabled, reportsTableStorageKey } from './feature-flags';

export function buildReportsPageProps(env: Readonly<Record<string, string | undefined>>) {
  const analyticsV2 = isAnalyticsV2Enabled(env);
  return {
    analyticsV2,
    tableStorageKey: reportsTableStorageKey(analyticsV2),
  };
}
