import { fetchReports } from './report-query';
import { formatReports } from './report-formatter';
export function buildReport(): string { return formatReports(fetchReports()); }
