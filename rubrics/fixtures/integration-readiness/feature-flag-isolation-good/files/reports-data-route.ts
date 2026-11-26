import { isAnalyticsV2Enabled } from './feature-flags';

export function handleAnalyticsV2Data(env: Readonly<Record<string, string | undefined>>) {
  if (!isAnalyticsV2Enabled(env)) {
    return { status: 404, body: { error: 'Not found' } };
  }
  return { status: 200, body: { cohortMetrics: [] } };
}
