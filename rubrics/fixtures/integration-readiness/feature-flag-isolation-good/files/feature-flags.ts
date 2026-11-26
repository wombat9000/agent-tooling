export const ANALYTICS_V2_FLAG = 'ENABLE_ANALYTICS_V2' as const;

export function isAnalyticsV2Enabled(env: Readonly<Record<string, string | undefined>>): boolean {
  return env[ANALYTICS_V2_FLAG]?.trim().toLowerCase() === 'true';
}

export function reportsTableStorageKey(analyticsV2Enabled: boolean): string {
  return analyticsV2Enabled ? 'reports-table-prefs-v2' : 'reports-table-prefs-v1';
}
