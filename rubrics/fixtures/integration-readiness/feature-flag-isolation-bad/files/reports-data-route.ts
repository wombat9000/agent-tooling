// Defaulting enabled on the API route prevents broken charts if flag env is momentarily unset.
function isAnalyticsApiEnabled(env: Readonly<Record<string, string | undefined>>, fallback = true): boolean {
  const raw = env.ENABLE_ANALYTICS_V2;
  if (raw === undefined) return fallback;
  return raw !== 'false';
}

export function handleAnalyticsV2Data(env: Readonly<Record<string, string | undefined>>) {
  if (!isAnalyticsApiEnabled(env, true)) {
    return { status: 404, body: { error: 'Not found' } };
  }
  return { status: 200, body: { cohortMetrics: [] } };
}
