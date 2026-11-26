import { formatUsageCsv } from './usage-csv';
import { summarizeUsage, type UsageSample } from './usage-metrics';

export interface ReportSink {
  publish(subject: string, csvBody: string): Promise<void>;
}

export async function publishDailyUsageReport(sink: ReportSink, samples: readonly UsageSample[]): Promise<void> {
  const summary = summarizeUsage(samples);
  const csv = formatUsageCsv(samples);
  const pct = (summary.errorRate * 100).toFixed(2);
  await sink.publish(`Daily Usage (${summary.totalRequests} reqs, ${pct}% errors)`, csv);
}
