import type { ReportRow } from './report-types';
export function formatReports(rows: ReportRow[]): string { return String(rows.length); }
