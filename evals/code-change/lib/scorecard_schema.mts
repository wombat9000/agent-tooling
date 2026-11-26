/** Schema definitions, canonical JSON formatting, and strict validation for eval scorecards. */

export type ScorecardCondition = 'baseline' | 'skill';
export type ScorecardTarget = 'review' | 'production_code' | 'test_code';
export type ScorecardScope = 'whole' | 'per-file';

export const SCORECARD_SCHEMA_VERSION = 1 as const;
export const CONDITION_ORDER: readonly ScorecardCondition[] = ['baseline', 'skill'];
export const TARGET_ORDER: readonly ScorecardTarget[] = ['review', 'production_code', 'test_code'];

const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const HEX_HASH_PATTERN = /^[0-9a-f]{12,64}$/;
const SHORT_SHA_PATTERN = /^[0-9a-f]{7,40}$/;
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const CHECK_ID_PATTERN = /^[a-z][a-z0-9_]*$/;

export interface ScorecardMetricSummary {
  passed: number;
  total: number;
  pass_rate: number;
}

export interface ScorecardDeterministic extends ScorecardMetricSummary {
  metrics?: Record<string, ScorecardMetricSummary>;
}

export interface ScorecardCheckStats {
  passed: number;
  total: number;
  pass_rate: number;
  mean_pass_probability: number;
}

export interface ScorecardHashes {
  skill_hash: string | null;
  task_hash: string;
  rubric_hash: string;
}

export interface ScorecardSource {
  git_ref?: string;
}

export interface ScorecardUsageMetric {
  total: number;
  mean: number;
  count: number;
}

export interface ScorecardUsage {
  n_input_tokens?: ScorecardUsageMetric;
  n_cache_tokens?: ScorecardUsageMetric;
  n_output_tokens?: ScorecardUsageMetric;
  cost_usd?: ScorecardUsageMetric;
  duration_sec?: ScorecardUsageMetric;
  agent_duration_sec?: ScorecardUsageMetric;
}

export const USAGE_METRIC_KEYS = [
  'n_input_tokens',
  'n_cache_tokens',
  'n_output_tokens',
  'cost_usd',
  'duration_sec',
  'agent_duration_sec',
] as const;

export interface ScorecardEntry {
  recorded_at: string;
  agent_model: string;
  judge_model: string;
  scope: ScorecardScope;
  with_judge_code?: boolean;
  rubric: string;
  rubric_groups?: Record<string, string[]>;
  trials: {
    total: number;
    scored: number;
    errored: number;
  };
  deterministic: ScorecardDeterministic | null;
  usage?: ScorecardUsage;
  quality: {
    pass_rate: number;
    mean_pass_probability: number;
    all_files_pass_rate?: number;
    checks: Record<string, ScorecardCheckStats>;
  };
  hashes: ScorecardHashes;
  source?: ScorecardSource;
}

export interface TaskScorecard {
  schema_version: typeof SCORECARD_SCHEMA_VERSION;
  skill: string;
  task: string;
  entries: Partial<Record<ScorecardCondition, Partial<Record<ScorecardTarget, ScorecardEntry>>>>;
}

export function compareCodepoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Round a finite number to 4 decimal places for clean, deterministic JSON diffs. */
export function round4(value: number): number {
  if (!Number.isFinite(value)) throw new Error(`Expected finite number, got ${String(value)}`);
  const rounded = Math.round(value * 10_000) / 10_000;
  return Object.is(rounded, -0) ? 0 : rounded;
}

/** Recursively sort object keys (codepoint order) for canonical hashing and serialization. */
export function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort(compareCodepoint)) {
      if (record[key] !== undefined) {
        sorted[key] = sortKeysDeep(record[key]);
      }
    }
    return sorted;
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value));
}

function normalizeUsage(usage: ScorecardUsage | undefined): ScorecardUsage | undefined {
  if (!usage) return undefined;
  const normalized: ScorecardUsage = {};
  let hasAny = false;
  for (const key of USAGE_METRIC_KEYS) {
    const metric = usage[key];
    if (!metric) continue;
    normalized[key] = {
      total: round4(metric.total),
      mean: round4(metric.mean),
      count: metric.count,
    };
    hasAny = true;
  }
  return hasAny ? normalized : undefined;
}

function normalizeEntry(entry: ScorecardEntry): ScorecardEntry {
  const sortedChecks: Record<string, ScorecardCheckStats> = {};
  for (const key of Object.keys(entry.quality.checks).sort(compareCodepoint)) {
    const check = entry.quality.checks[key];
    sortedChecks[key] = {
      passed: check.passed,
      total: check.total,
      pass_rate: round4(check.pass_rate),
      mean_pass_probability: round4(check.mean_pass_probability),
    };
  }

  let deterministic: ScorecardDeterministic | null = null;
  if (entry.deterministic !== null) {
    const det: ScorecardDeterministic = {
      passed: entry.deterministic.passed,
      total: entry.deterministic.total,
      pass_rate: round4(entry.deterministic.pass_rate),
    };
    if (entry.deterministic.metrics && Object.keys(entry.deterministic.metrics).length > 0) {
      const sortedMetrics: Record<string, ScorecardMetricSummary> = {};
      for (const key of Object.keys(entry.deterministic.metrics).sort(compareCodepoint)) {
        const m = entry.deterministic.metrics[key];
        sortedMetrics[key] = {
          passed: m.passed,
          total: m.total,
          pass_rate: round4(m.pass_rate),
        };
      }
      det.metrics = sortedMetrics;
    }
    deterministic = det;
  }

  const normalized: ScorecardEntry = {
    recorded_at: entry.recorded_at,
    agent_model: entry.agent_model,
    judge_model: entry.judge_model,
    scope: entry.scope,
    ...(entry.with_judge_code === true ? { with_judge_code: true } : {}),
    rubric: entry.rubric,
    ...(entry.rubric_groups && Object.keys(entry.rubric_groups).length > 0
      ? {
        rubric_groups: Object.fromEntries(
          Object.keys(entry.rubric_groups)
            .sort(compareCodepoint)
            .map((group) => [group, [...entry.rubric_groups![group]]]),
        ),
      }
      : {}),
    trials: {
      total: entry.trials.total,
      scored: entry.trials.scored,
      errored: entry.trials.errored,
    },
    deterministic,
    ...(normalizeUsage(entry.usage) ? { usage: normalizeUsage(entry.usage) } : {}),
    quality: {
      pass_rate: round4(entry.quality.pass_rate),
      mean_pass_probability: round4(entry.quality.mean_pass_probability),
      ...(entry.quality.all_files_pass_rate !== undefined
        ? { all_files_pass_rate: round4(entry.quality.all_files_pass_rate) }
        : {}),
      checks: sortedChecks,
    },
    hashes: {
      skill_hash: entry.hashes.skill_hash,
      task_hash: entry.hashes.task_hash,
      rubric_hash: entry.hashes.rubric_hash,
    },
    ...(entry.source && entry.source.git_ref ? { source: { git_ref: entry.source.git_ref } } : {}),
  };

  return normalized;
}

/** Produce a deterministically ordered TaskScorecard ready for pretty-printed JSON output. */
export function normalizeTaskScorecard(scorecard: TaskScorecard): TaskScorecard {
  const entries: TaskScorecard['entries'] = {};
  for (const condition of CONDITION_ORDER) {
    const condEntries = scorecard.entries[condition];
    if (!condEntries) continue;
    const orderedTargets: Partial<Record<ScorecardTarget, ScorecardEntry>> = {};
    let hasAny = false;
    for (const target of TARGET_ORDER) {
      const entry = condEntries[target];
      if (!entry) continue;
      orderedTargets[target] = normalizeEntry(entry);
      hasAny = true;
    }
    if (hasAny) {
      entries[condition] = orderedTargets;
    }
  }
  return {
    schema_version: SCORECARD_SCHEMA_VERSION,
    skill: scorecard.skill,
    task: scorecard.task,
    entries,
  };
}

export function formatTaskScorecardJson(scorecard: TaskScorecard): string {
  return `${JSON.stringify(normalizeTaskScorecard(scorecard), null, 2)}\n`;
}

function asObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function asNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${label} must be a nonempty string`);
  }
  return value;
}

function asNonNegativeInt(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return value;
}

function asUnitInterval(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${label} must be a number between 0 and 1`);
  }
  return value;
}

function rejectUnsafePathsOrUuids(value: string, label: string): void {
  if (/(?:^|[\s"'=])(?:\/Users\/|\/home\/|[A-Za-z]:\\|\/tmp\/)/.test(value)) {
    throw new Error(`${label} must not contain local absolute file paths`);
  }
  if (/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(value)) {
    throw new Error(`${label} must not contain random UUIDs`);
  }
}

function asNonNegativeNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`${label} must be a non-negative finite number`);
  }
  return value;
}

function validateUsage(raw: unknown, label: string): ScorecardUsage | undefined {
  if (raw === undefined) return undefined;
  const obj = asObject(raw, label);
  const allowed = new Set<string>(USAGE_METRIC_KEYS);
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) {
      throw new Error(`${label} contains unsupported field: ${key}`);
    }
  }
  const usage: ScorecardUsage = {};
  let hasAny = false;
  for (const key of USAGE_METRIC_KEYS) {
    if (obj[key] === undefined) continue;
    const mObj = asObject(obj[key], `${label}.${key}`);
    const total = asNonNegativeNumber(mObj.total, `${label}.${key}.total`);
    const mean = asNonNegativeNumber(mObj.mean, `${label}.${key}.mean`);
    const count = asNonNegativeInt(mObj.count, `${label}.${key}.count`);
    if (count < 1) {
      throw new Error(`${label}.${key}.count must be >= 1`);
    }
    usage[key] = { total, mean, count };
    hasAny = true;
  }
  return hasAny ? usage : undefined;
}

function validateMetricSummary(raw: unknown, label: string): ScorecardMetricSummary {
  const obj = asObject(raw, label);
  const passed = asNonNegativeInt(obj.passed, `${label}.passed`);
  const total = asNonNegativeInt(obj.total, `${label}.total`);
  if (passed > total) {
    throw new Error(`${label}.passed (${passed}) cannot exceed total (${total})`);
  }
  const pass_rate = asUnitInterval(obj.pass_rate, `${label}.pass_rate`);
  return { passed, total, pass_rate };
}

function validateEntry(raw: unknown, condition: ScorecardCondition, label: string): ScorecardEntry {
  const obj = asObject(raw, label);

  const recorded_at = asNonEmptyString(obj.recorded_at, `${label}.recorded_at`);
  if (!ISO_DATE_PATTERN.test(recorded_at)) {
    throw new Error(`${label}.recorded_at must be an ISO date YYYY-MM-DD (got ${recorded_at})`);
  }

  const agent_model = asNonEmptyString(obj.agent_model, `${label}.agent_model`);
  const judge_model = asNonEmptyString(obj.judge_model, `${label}.judge_model`);
  rejectUnsafePathsOrUuids(agent_model, `${label}.agent_model`);
  rejectUnsafePathsOrUuids(judge_model, `${label}.judge_model`);

  if (obj.scope !== 'whole' && obj.scope !== 'per-file') {
    throw new Error(`${label}.scope must be "whole" or "per-file"`);
  }
  const scope: ScorecardScope = obj.scope;

  let with_judge_code: boolean | undefined;
  if (obj.with_judge_code !== undefined) {
    if (typeof obj.with_judge_code !== 'boolean') {
      throw new Error(`${label}.with_judge_code must be a boolean`);
    }
    if (obj.with_judge_code) with_judge_code = true;
  }

  const rubric = asNonEmptyString(obj.rubric, `${label}.rubric`);
  rejectUnsafePathsOrUuids(rubric, `${label}.rubric`);

  let rubric_groups: Record<string, string[]> | undefined;
  if (obj.rubric_groups !== undefined) {
    const groupsObj = asObject(obj.rubric_groups, `${label}.rubric_groups`);
    rubric_groups = {};
    for (const [slug, ids] of Object.entries(groupsObj)) {
      if (!SLUG_PATTERN.test(slug)) {
        throw new Error(`${label}.rubric_groups key must be a valid slug: ${slug}`);
      }
      if (!Array.isArray(ids) || ids.length === 0) {
        throw new Error(`${label}.rubric_groups.${slug} must be a nonempty array`);
      }
      rubric_groups[slug] = ids.map((id, idx) => {
        const s = asNonEmptyString(id, `${label}.rubric_groups.${slug}[${idx}]`);
        if (!CHECK_ID_PATTERN.test(s)) {
          throw new Error(`${label}.rubric_groups.${slug}[${idx}] invalid check ID: ${s}`);
        }
        return s;
      });
    }
  }

  const trialsObj = asObject(obj.trials, `${label}.trials`);
  const total = asNonNegativeInt(trialsObj.total, `${label}.trials.total`);
  const scored = asNonNegativeInt(trialsObj.scored, `${label}.trials.scored`);
  const errored = asNonNegativeInt(trialsObj.errored, `${label}.trials.errored`);
  if (total === 0) throw new Error(`${label}.trials.total must be >= 1`);
  if (scored + errored > total) {
    throw new Error(`${label}.trials scored (${scored}) + errored (${errored}) exceeds total (${total})`);
  }

  let deterministic: ScorecardDeterministic | null = null;
  if (obj.deterministic !== null && obj.deterministic !== undefined) {
    const base = validateMetricSummary(obj.deterministic, `${label}.deterministic`);
    const detObj = asObject(obj.deterministic, `${label}.deterministic`);
    let metrics: Record<string, ScorecardMetricSummary> | undefined;
    if (detObj.metrics !== undefined) {
      const metricsObj = asObject(detObj.metrics, `${label}.deterministic.metrics`);
      metrics = {};
      for (const [key, val] of Object.entries(metricsObj)) {
        if (!CHECK_ID_PATTERN.test(key)) {
          throw new Error(`${label}.deterministic.metrics key invalid: ${key}`);
        }
        metrics[key] = validateMetricSummary(val, `${label}.deterministic.metrics.${key}`);
      }
    }
    deterministic = metrics ? { ...base, metrics } : base;
  }

  const usage = validateUsage(obj.usage, `${label}.usage`);

  const qualityObj = asObject(obj.quality, `${label}.quality`);
  const pass_rate = asUnitInterval(qualityObj.pass_rate, `${label}.quality.pass_rate`);
  const mean_pass_probability = asUnitInterval(qualityObj.mean_pass_probability, `${label}.quality.mean_pass_probability`);
  const all_files_pass_rate = qualityObj.all_files_pass_rate !== undefined
    ? asUnitInterval(qualityObj.all_files_pass_rate, `${label}.quality.all_files_pass_rate`)
    : undefined;

  const checksObj = asObject(qualityObj.checks, `${label}.quality.checks`);
  const checkKeys = Object.keys(checksObj);
  if (checkKeys.length === 0) {
    throw new Error(`${label}.quality.checks must be nonempty`);
  }
  const checks: Record<string, ScorecardCheckStats> = {};
  for (const key of checkKeys) {
    if (!CHECK_ID_PATTERN.test(key)) {
      throw new Error(`${label}.quality.checks invalid check ID: ${key}`);
    }
    const cObj = asObject(checksObj[key], `${label}.quality.checks.${key}`);
    const cPassed = asNonNegativeInt(cObj.passed, `${label}.quality.checks.${key}.passed`);
    const cTotal = asNonNegativeInt(cObj.total, `${label}.quality.checks.${key}.total`);
    if (cTotal === 0 || cPassed > cTotal) {
      throw new Error(`${label}.quality.checks.${key} has invalid passed/total (${cPassed}/${cTotal})`);
    }
    checks[key] = {
      passed: cPassed,
      total: cTotal,
      pass_rate: asUnitInterval(cObj.pass_rate, `${label}.quality.checks.${key}.pass_rate`),
      mean_pass_probability: asUnitInterval(
        cObj.mean_pass_probability,
        `${label}.quality.checks.${key}.mean_pass_probability`,
      ),
    };
  }

  const hashesObj = asObject(obj.hashes, `${label}.hashes`);
  let skill_hash: string | null;
  if (condition === 'baseline') {
    if (hashesObj.skill_hash !== null && hashesObj.skill_hash !== undefined) {
      throw new Error(`${label}.hashes.skill_hash must be null for baseline entries`);
    }
    skill_hash = null;
  } else {
    const sh = asNonEmptyString(hashesObj.skill_hash, `${label}.hashes.skill_hash`);
    if (!HEX_HASH_PATTERN.test(sh)) {
      throw new Error(`${label}.hashes.skill_hash must be 12-64 lowercase hex chars`);
    }
    skill_hash = sh;
  }
  const task_hash = asNonEmptyString(hashesObj.task_hash, `${label}.hashes.task_hash`);
  if (!HEX_HASH_PATTERN.test(task_hash)) {
    throw new Error(`${label}.hashes.task_hash must be 12-64 lowercase hex chars`);
  }
  const rubric_hash = asNonEmptyString(hashesObj.rubric_hash, `${label}.hashes.rubric_hash`);
  if (!HEX_HASH_PATTERN.test(rubric_hash)) {
    throw new Error(`${label}.hashes.rubric_hash must be 12-64 lowercase hex chars`);
  }

  let source: ScorecardSource | undefined;
  if (obj.source !== undefined) {
    const srcObj = asObject(obj.source, `${label}.source`);
    for (const key of Object.keys(srcObj)) {
      if (key !== 'git_ref') {
        throw new Error(`${label}.source contains unsupported field: ${key}`);
      }
    }
    if (srcObj.git_ref !== undefined) {
      const ref = asNonEmptyString(srcObj.git_ref, `${label}.source.git_ref`);
      if (!SHORT_SHA_PATTERN.test(ref)) {
        throw new Error(`${label}.source.git_ref must be a 7-40 char lowercase hex SHA`);
      }
      source = { git_ref: ref };
    }
  }

  return {
    recorded_at,
    agent_model,
    judge_model,
    scope,
    ...(with_judge_code ? { with_judge_code } : {}),
    rubric,
    ...(rubric_groups ? { rubric_groups } : {}),
    trials: { total, scored, errored },
    deterministic,
    ...(usage ? { usage } : {}),
    quality: {
      pass_rate,
      mean_pass_probability,
      ...(all_files_pass_rate !== undefined ? { all_files_pass_rate } : {}),
      checks,
    },
    hashes: { skill_hash, task_hash, rubric_hash },
    ...(source ? { source } : {}),
  };
}

/** Parse and strictly validate a TaskScorecard JSON object. */
export function validateTaskScorecard(raw: unknown, label = 'Scorecard'): TaskScorecard {
  const obj = asObject(raw, label);
  if (obj.schema_version !== SCORECARD_SCHEMA_VERSION) {
    throw new Error(`${label}.schema_version must be ${SCORECARD_SCHEMA_VERSION}`);
  }
  const skill = asNonEmptyString(obj.skill, `${label}.skill`);
  const task = asNonEmptyString(obj.task, `${label}.task`);
  if (!SLUG_PATTERN.test(skill)) throw new Error(`${label}.skill must be a valid slug: ${skill}`);
  if (!SLUG_PATTERN.test(task)) throw new Error(`${label}.task must be a valid slug: ${task}`);

  const entriesObj = asObject(obj.entries, `${label}.entries`);
  const entries: TaskScorecard['entries'] = {};
  let totalEntries = 0;

  for (const [condKey, condVal] of Object.entries(entriesObj)) {
    if (condKey !== 'baseline' && condKey !== 'skill') {
      throw new Error(`${label}.entries has invalid condition: ${condKey}`);
    }
    const targetMap = asObject(condVal, `${label}.entries.${condKey}`);
    const validatedTargets: Partial<Record<ScorecardTarget, ScorecardEntry>> = {};
    for (const [targetKey, entryVal] of Object.entries(targetMap)) {
      if (targetKey !== 'review' && targetKey !== 'production_code' && targetKey !== 'test_code') {
        throw new Error(`${label}.entries.${condKey} has invalid target: ${targetKey}`);
      }
      validatedTargets[targetKey] = validateEntry(
        entryVal,
        condKey,
        `${label}.entries.${condKey}.${targetKey}`,
      );
      totalEntries += 1;
    }
    if (Object.keys(validatedTargets).length > 0) {
      entries[condKey] = validatedTargets;
    }
  }

  if (totalEntries === 0) {
    throw new Error(`${label}.entries must contain at least one condition/target entry`);
  }

  return normalizeTaskScorecard({
    schema_version: SCORECARD_SCHEMA_VERSION,
    skill,
    task,
    entries,
  });
}
