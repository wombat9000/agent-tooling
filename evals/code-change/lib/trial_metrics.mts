/** Extract, aggregate, and format Harbor trial token usage, cost, and duration metrics. */
import { readFileSync, statSync } from 'node:fs';

export interface TrialUsageMetrics {
  n_input_tokens: number | null;
  n_cache_tokens: number | null;
  n_output_tokens: number | null;
  cost_usd: number | null;
  duration_sec: number | null;
  agent_duration_sec: number | null;
}

export interface AggregateMetricStats {
  total: number;
  mean: number;
  count: number;
}

export interface AggregateUsageMetrics {
  n_input_tokens: AggregateMetricStats | null;
  n_cache_tokens: AggregateMetricStats | null;
  n_output_tokens: AggregateMetricStats | null;
  cost_usd: AggregateMetricStats | null;
  duration_sec: AggregateMetricStats | null;
  agent_duration_sec: AggregateMetricStats | null;
}

export const EMPTY_TRIAL_METRICS: TrialUsageMetrics = {
  n_input_tokens: null,
  n_cache_tokens: null,
  n_output_tokens: null,
  cost_usd: null,
  duration_sec: null,
  agent_duration_sec: null,
};

function nonNegativeNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function roundDecimals(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  const rounded = Math.round(value * factor) / factor;
  return Object.is(rounded, -0) ? 0 : rounded;
}

function parseDurationSeconds(startedAt: unknown, finishedAt: unknown): number | null {
  if (typeof startedAt !== 'string' || typeof finishedAt !== 'string') return null;
  const startMs = Date.parse(startedAt);
  const endMs = Date.parse(finishedAt);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) return null;
  return roundDecimals((endMs - startMs) / 1000, 3);
}

function sumNullable(current: number | null, next: number | null): number | null {
  if (next === null) return current;
  return (current ?? 0) + next;
}

/** Parse usage and timing fields from a Harbor TrialResult JSON object (never throws on missing/partial data). */
export function extractTrialMetricsFromResult(raw: unknown): TrialUsageMetrics {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ...EMPTY_TRIAL_METRICS };
  }
  const record = raw as Record<string, unknown>;

  const contexts: Array<Record<string, unknown>> = [];
  if (record.agent_result && typeof record.agent_result === 'object' && !Array.isArray(record.agent_result)) {
    contexts.push(record.agent_result as Record<string, unknown>);
  } else if (Array.isArray(record.step_results)) {
    for (const step of record.step_results) {
      if (step && typeof step === 'object' && !Array.isArray(step)) {
        const stepAgent = (step as Record<string, unknown>).agent_result;
        if (stepAgent && typeof stepAgent === 'object' && !Array.isArray(stepAgent)) {
          contexts.push(stepAgent as Record<string, unknown>);
        }
      }
    }
  }

  let nInput: number | null = null;
  let nCache: number | null = null;
  let nOutput: number | null = null;
  let costUsd: number | null = null;

  for (const ctx of contexts) {
    nInput = sumNullable(nInput, nonNegativeNumber(ctx.n_input_tokens));
    nCache = sumNullable(nCache, nonNegativeNumber(ctx.n_cache_tokens));
    nOutput = sumNullable(nOutput, nonNegativeNumber(ctx.n_output_tokens));
    costUsd = sumNullable(costUsd, nonNegativeNumber(ctx.cost_usd));
  }

  const durationSec = parseDurationSeconds(record.started_at, record.finished_at);
  let agentDurationSec: number | null = null;
  if (record.agent_execution && typeof record.agent_execution === 'object' && !Array.isArray(record.agent_execution)) {
    const exec = record.agent_execution as Record<string, unknown>;
    agentDurationSec = parseDurationSeconds(exec.started_at, exec.finished_at);
  }

  return {
    n_input_tokens: nInput === null ? null : Math.round(nInput),
    n_cache_tokens: nCache === null ? null : Math.round(nCache),
    n_output_tokens: nOutput === null ? null : Math.round(nOutput),
    cost_usd: costUsd === null ? null : roundDecimals(costUsd, 6),
    duration_sec: durationSec,
    agent_duration_sec: agentDurationSec,
  };
}

/** Read a Harbor trial's result.json safely, returning all-null metrics if absent or invalid. */
export function readTrialMetrics(trialResultPath?: string): TrialUsageMetrics {
  if (!trialResultPath || !statSync(trialResultPath, { throwIfNoEntry: false })?.isFile()) {
    return { ...EMPTY_TRIAL_METRICS };
  }
  try {
    return extractTrialMetricsFromResult(JSON.parse(readFileSync(trialResultPath, 'utf8')));
  } catch {
    return { ...EMPTY_TRIAL_METRICS };
  }
}

/** Normalize a potentially partial or legacy usage object from summary.json into TrialUsageMetrics. */
export function normalizeTrialMetrics(raw: unknown): TrialUsageMetrics | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  const metrics: TrialUsageMetrics = {
    n_input_tokens: nonNegativeNumber(obj.n_input_tokens),
    n_cache_tokens: nonNegativeNumber(obj.n_cache_tokens),
    n_output_tokens: nonNegativeNumber(obj.n_output_tokens),
    cost_usd: nonNegativeNumber(obj.cost_usd),
    duration_sec: nonNegativeNumber(obj.duration_sec),
    agent_duration_sec: nonNegativeNumber(obj.agent_duration_sec),
  };
  return hasAnyTrialMetrics(metrics) ? metrics : null;
}

export function hasAnyTrialMetrics(metrics: TrialUsageMetrics | null | undefined): boolean {
  if (!metrics) return false;
  return metrics.n_input_tokens !== null
    || metrics.n_cache_tokens !== null
    || metrics.n_output_tokens !== null
    || metrics.cost_usd !== null
    || metrics.duration_sec !== null
    || metrics.agent_duration_sec !== null;
}

function summarizeField(
  values: ReadonlyArray<number | null | undefined>,
  decimals: number,
): AggregateMetricStats | null {
  const present = values.filter((v): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0);
  if (present.length === 0) return null;
  const total = present.reduce((sum, v) => sum + v, 0);
  return {
    total: roundDecimals(total, decimals),
    mean: roundDecimals(total / present.length, decimals),
    count: present.length,
  };
}

/** Aggregate per-trial usage & duration metrics into totals and means. Returns null if no data exists. */
export function aggregateTrialMetrics(
  items: ReadonlyArray<TrialUsageMetrics | null | undefined>,
): AggregateUsageMetrics | null {
  const aggregated: AggregateUsageMetrics = {
    n_input_tokens: summarizeField(items.map((item) => item?.n_input_tokens), 1),
    n_cache_tokens: summarizeField(items.map((item) => item?.n_cache_tokens), 1),
    n_output_tokens: summarizeField(items.map((item) => item?.n_output_tokens), 1),
    cost_usd: summarizeField(items.map((item) => item?.cost_usd), 6),
    duration_sec: summarizeField(items.map((item) => item?.duration_sec), 3),
    agent_duration_sec: summarizeField(items.map((item) => item?.agent_duration_sec), 3),
  };
  const hasAny = Object.values(aggregated).some((entry) => entry !== null);
  return hasAny ? aggregated : null;
}

export function formatTokenCount(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return '—';
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 10_000) return `${(value / 1_000).toFixed(1)}k`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(2)}k`;
  return String(Math.round(value));
}

export function formatExactInt(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return '—';
  return Math.round(value).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

export function formatCostUsd(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return '—';
  if (value === 0) return '$0.00';
  if (value < 0.01) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(2)}`;
}

export function formatDurationSec(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return '—';
  if (value < 60) return `${value.toFixed(1)}s`;
  const totalSec = Math.round(value);
  const hours = Math.floor(totalSec / 3600);
  const minutes = Math.floor((totalSec % 3600) / 60);
  const seconds = totalSec % 60;
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, '0')}m`;
  return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
}

/** Build a concise one-line CLI summary of aggregate usage and duration metrics (null if none present). */
export function formatAggregateUsageLine(usage: AggregateUsageMetrics | null | undefined): string | null {
  if (!usage) return null;
  const parts: string[] = [];
  if (usage.n_input_tokens || usage.n_output_tokens) {
    const inPart = usage.n_input_tokens ? `${formatTokenCount(usage.n_input_tokens.total)} in` : null;
    const cachePart = usage.n_cache_tokens ? ` (${formatTokenCount(usage.n_cache_tokens.total)} cache)` : '';
    const outPart = usage.n_output_tokens ? `${formatTokenCount(usage.n_output_tokens.total)} out` : null;
    const meanIn = usage.n_input_tokens ? `${formatTokenCount(usage.n_input_tokens.mean)} in` : null;
    const meanOut = usage.n_output_tokens ? `${formatTokenCount(usage.n_output_tokens.mean)} out` : null;
    const totals = [inPart ? `${inPart}${cachePart}` : null, outPart].filter(Boolean).join(' / ');
    const means = [meanIn, meanOut].filter(Boolean).join(' / ');
    parts.push(`tokens ${totals}${means ? ` (mean ${means})` : ''}`);
  }
  if (usage.cost_usd) {
    parts.push(`cost ${formatCostUsd(usage.cost_usd.total)} (mean ${formatCostUsd(usage.cost_usd.mean)})`);
  }
  const dur = usage.duration_sec ?? usage.agent_duration_sec;
  if (dur) {
    parts.push(`duration ${formatDurationSec(dur.total)} total (mean ${formatDurationSec(dur.mean)})`);
  }
  return parts.length ? parts.join(' · ') : null;
}
