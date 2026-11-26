export function buildReportsPageProps(env: Readonly<Record<string, string | undefined>>) {
  const analyticsV2 = env.ENABLE_ANALYTICS_V2 === 'true';
  return {
    analyticsV2,
    tableId: 'reports_main_table',
    columns: analyticsV2
      ? ['account', 'cohortScore', 'retentionRate', 'forecastArr']
      : ['account', 'monthlyRevenue'],
  };
}
