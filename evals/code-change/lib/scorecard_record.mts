/** Record saved judge batch directories into checked-in per-task scorecard JSON files. */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { inspectHarborJobName, inspectHarborRunCondition } from './run_condition.mts';
import {
  USAGE_METRIC_KEYS,
  type ScorecardUsage,
} from './scorecard_schema.mts';
import {
  aggregateTrialMetrics,
  normalizeTrialMetrics,
  readTrialMetrics,
  type TrialUsageMetrics,
} from './trial_metrics.mts';
import {
  computeSkillHash,
  computeTaskHash,
  resolveGitRef,
  resolveRubricForTarget,
} from './scorecard_hashes.mts';
import {
  SCORECARD_SCHEMA_VERSION,
  compareCodepoint,
  formatTaskScorecardJson,
  normalizeTaskScorecard,
  round4,
  validateTaskScorecard,
  type ScorecardCheckStats,
  type ScorecardCondition,
  type ScorecardDeterministic,
  type ScorecardEntry,
  type ScorecardMetricSummary,
  type ScorecardScope,
  type ScorecardTarget,
  type TaskScorecard,
} from './scorecard_schema.mts';

interface SavedCheck {
  choice: 'pass' | 'fail';
  pass_probability: number;
  confidence: number;
}

interface SavedTrialResult {
  status: string;
  target?: ScorecardTarget;
  scope?: ScorecardScope;
  requested_model?: string;
  returned_model?: string | null;
  rubric: string;
  rubric_groups?: Record<string, string[]>;
  deterministic?: Record<string, number>;
  quality: {
    pass_rate: number;
    all_files_pass_rate?: number;
    checks: Record<string, SavedCheck>;
  } | null;
}

interface BatchReportItem {
  trial: string;
  task: string;
  target?: ScorecardTarget;
  status: string;
  result_dir: string;
  rewardPath?: string;
  trialResultPath?: string;
  usage?: unknown;
}

interface BatchSummaryJson {
  source_run?: string;
  model: string;
  scope?: ScorecardScope;
  target?: ScorecardTarget;
  condition?: string;
  with_judge_code?: boolean;
  reports: BatchReportItem[];
}

export interface RecordJudgeBatchOptions {
  repoRoot: string;
  judgeDirs: string[];
  skill?: string;
  condition?: ScorecardCondition;
  gitRef?: string;
  agentModel?: string;
  taskFilter?: string;
  recordedAt?: string;
  dryRun?: boolean;
}

export interface RecordedEntrySummary {
  skill: string;
  task: string;
  condition: ScorecardCondition;
  target: ScorecardTarget;
  path: string;
  entry: ScorecardEntry;
}

function readJson(filePath: string): unknown {
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

function toIsoDate(value: string | number | Date): string | null {
  const ms = value instanceof Date ? value.getTime() : typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Locate the Harbor run directory associated with a judge batch, supporting both
 * in-place runs and archived/relocated eval-results directories.
 */
function findHarborRunDir(judgeDir: string, sourceRun?: string): string | null {
  if (sourceRun && statSync(sourceRun, { throwIfNoEntry: false })?.isDirectory()) {
    return sourceRun;
  }
  const runName = sourceRun ? basename(sourceRun) : basename(dirname(judgeDir));
  if (!runName) return null;

  // Walk upward from judgeDir looking for a sibling `harbor/<runName>` directory.
  let cur = resolve(judgeDir);
  for (let depth = 0; depth < 4; depth += 1) {
    const parent = dirname(cur);
    if (parent === cur) break;
    const candidate = join(parent, 'harbor', runName);
    if (statSync(candidate, { throwIfNoEntry: false })?.isDirectory()) {
      return candidate;
    }
    cur = parent;
  }
  return null;
}

interface HarborRunMeta {
  condition: ScorecardCondition | null;
  withJudgeCode: boolean;
  isOracleOrNop: boolean;
  agentModel: string | null;
  finishedDate: string | null;
}

function inspectHarborRun(
  judgeDir: string,
  sourceRun?: string,
  summary?: { condition?: string; with_judge_code?: boolean },
): HarborRunMeta {
  const harborDir = findHarborRunDir(judgeDir, sourceRun);
  let condition: ScorecardCondition | null = null;
  let withJudgeCode = summary?.with_judge_code === true;
  let isOracleOrNop = false;
  let agentModel: string | null = null;
  let finishedDate: string | null = null;

  if (harborDir) {
    const inspected = inspectHarborRunCondition(harborDir);
    if (inspected.baseCondition === 'oracle' || inspected.baseCondition === 'nop') {
      isOracleOrNop = true;
    } else if (inspected.baseCondition === 'skill' || inspected.baseCondition === 'baseline') {
      condition = inspected.baseCondition;
    }
    if (inspected.withJudgeCode) withJudgeCode = true;
    if (inspected.agentModel) agentModel = inspected.agentModel;

    const resultPath = join(harborDir, 'result.json');
    if (existsSync(resultPath)) {
      try {
        const res = readJson(resultPath) as { finished_at?: string };
        if (typeof res.finished_at === 'string') {
          finishedDate = toIsoDate(res.finished_at);
        }
      } catch {
        // Optional date metadata.
      }
    }
  }

  const runName = sourceRun ? basename(sourceRun) : basename(dirname(judgeDir));
  if (runName) {
    const nameHint = inspectHarborJobName(runName);
    if (nameHint.withJudgeCode) withJudgeCode = true;
    if (!condition && !isOracleOrNop) {
      if (nameHint.baseCondition === 'oracle' || nameHint.baseCondition === 'nop') {
        isOracleOrNop = true;
      } else if (nameHint.baseCondition === 'skill' || nameHint.baseCondition === 'baseline') {
        condition = nameHint.baseCondition;
      }
    }
  }

  if (!condition && !isOracleOrNop && (summary?.condition === 'skill' || summary?.condition === 'baseline')) {
    condition = summary.condition;
  }

  return { condition, withJudgeCode, isOracleOrNop, agentModel, finishedDate };
}

function resolveTrialResultDir(judgeDir: string, report: BatchReportItem): string {
  const localDir = join(judgeDir, report.trial);
  if (existsSync(join(localDir, 'result.json'))) return localDir;
  if (report.result_dir && existsSync(join(report.result_dir, 'result.json'))) {
    return resolve(report.result_dir);
  }
  return localDir;
}

function readFallbackDeterministic(
  harborDir: string | null,
  trial: string,
): Record<string, number> | null {
  if (!harborDir) return null;
  const rewardPath = join(harborDir, trial, 'verifier/reward.json');
  if (!existsSync(rewardPath)) return null;
  try {
    const parsed = readJson(rewardPath);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, number>;
    }
  } catch {
    return null;
  }
  return null;
}

function aggregateDeterministic(
  records: Array<Record<string, number>>,
): ScorecardDeterministic | null {
  const withReward = records.filter((rec) => typeof rec.reward === 'number' && Number.isFinite(rec.reward));
  if (withReward.length === 0) return null;

  const rewardPassed = withReward.filter((rec) => rec.reward === 1).length;
  const subMetricKeys = new Set<string>();
  for (const rec of records) {
    for (const key of Object.keys(rec)) {
      if (key !== 'reward' && typeof rec[key] === 'number' && Number.isFinite(rec[key])) {
        subMetricKeys.add(key);
      }
    }
  }

  const metrics: Record<string, ScorecardMetricSummary> = {};
  for (const key of [...subMetricKeys].sort(compareCodepoint)) {
    const present = records.filter((rec) => typeof rec[key] === 'number' && Number.isFinite(rec[key]));
    if (present.length === 0) continue;
    const passed = present.filter((rec) => rec[key] === 1).length;
    metrics[key] = {
      passed,
      total: present.length,
      pass_rate: round4(passed / present.length),
    };
  }

  return {
    passed: rewardPassed,
    total: withReward.length,
    pass_rate: round4(rewardPassed / withReward.length),
    ...(Object.keys(metrics).length > 0 ? { metrics } : {}),
  };
}

function inferTarget(
  report: BatchReportItem,
  summary: BatchSummaryJson,
  result: SavedTrialResult,
): ScorecardTarget {
  const candidate = result.target ?? report.target ?? summary.target;
  if (candidate === 'review' || candidate === 'production_code' || candidate === 'test_code') {
    return candidate;
  }
  return 'review';
}

function buildEntryFromTrials(params: {
  repoRoot: string;
  skill: string;
  task: string;
  target: ScorecardTarget;
  condition: ScorecardCondition;
  gitRef?: string;
  resolvedShortSha?: string;
  agentModel: string;
  judgeModel: string;
  scope: ScorecardScope;
  withJudgeCode?: boolean;
  recordedAt: string;
  trials: Array<{
    status: string;
    result: SavedTrialResult | null;
    deterministic: Record<string, number>;
    usage: TrialUsageMetrics | null;
  }>;
}): ScorecardEntry {
  const {
    repoRoot,
    skill,
    task,
    target,
    condition,
    gitRef,
    resolvedShortSha,
    agentModel,
    judgeModel,
    scope,
    withJudgeCode,
    recordedAt,
    trials,
  } = params;

  const pendingOrDry = trials.filter((t) => t.status === 'pending' || t.status === 'dry_run');
  if (pendingOrDry.length > 0) {
    throw new Error(`Cannot record incomplete batch for ${task} (${target}): ${pendingOrDry.length} trial(s) are pending or dry_run.`);
  }

  const scored = trials.filter((t) => t.status === 'scored' && t.result?.quality);
  const errored = trials.filter((t) => t.status === 'error' || t.status === 'missing_report');
  if (scored.length === 0) {
    throw new Error(`Cannot record ${task} (${target}): 0 scored trials.`);
  }

  const rubrics = [...new Set(scored.map((t) => t.result!.rubric))];
  if (rubrics.length !== 1) {
    throw new Error(`Inconsistent rubrics in batch for ${task} (${target}): ${rubrics.join(', ')}`);
  }
  const rubric = rubrics[0];
  const rubricGroups = scored.find((t) => t.result?.rubric_groups)?.result?.rubric_groups;

  const resolvedRubric = resolveRubricForTarget(repoRoot, skill, task, target, gitRef);
  if (!resolvedRubric) {
    throw new Error(`Could not resolve rubric for ${skill}/${task} (${target})${gitRef ? ` at ${gitRef}` : ''}.`);
  }
  if (resolvedRubric.rubric !== rubric) {
    throw new Error(
      `Provenance mismatch for ${skill}/${task} (${target}): judge batch used rubric "${rubric}", `
      + `but ${gitRef ? `git ref ${gitRef}` : 'working tree'} resolves to "${resolvedRubric.rubric}". `
      + 'Pass the exact --git-ref that produced this run.',
    );
  }

  const taskHash = computeTaskHash(repoRoot, skill, task, gitRef);
  if (!taskHash) {
    throw new Error(`Task evals/${skill}/tasks/${task} not found${gitRef ? ` at git ref ${gitRef}` : ''}.`);
  }
  const skillHash = condition === 'skill' ? computeSkillHash(repoRoot, skill, gitRef) : null;
  if (condition === 'skill' && !skillHash) {
    throw new Error(`Skill skills/${skill} not found${gitRef ? ` at git ref ${gitRef}` : ''}.`);
  }

  const checkIds = new Set<string>();
  for (const t of scored) {
    for (const id of Object.keys(t.result!.quality!.checks)) {
      checkIds.add(id);
    }
  }

  const checks: Record<string, ScorecardCheckStats> = {};
  let allProbSum = 0;
  let allProbCount = 0;

  for (const id of [...checkIds].sort(compareCodepoint)) {
    const present = scored
      .map((t) => t.result!.quality!.checks[id])
      .filter((c): c is SavedCheck => c !== undefined);
    const passed = present.filter((c) => c.choice === 'pass').length;
    const probSum = present.reduce((sum, c) => sum + c.pass_probability, 0);
    allProbSum += probSum;
    allProbCount += present.length;
    checks[id] = {
      passed,
      total: present.length,
      pass_rate: round4(passed / present.length),
      mean_pass_probability: round4(probSum / present.length),
    };
  }

  const meanTrialPassRate = scored.reduce((sum, t) => sum + t.result!.quality!.pass_rate, 0) / scored.length;
  const meanPassProb = allProbCount > 0 ? allProbSum / allProbCount : 0;

  const allFilesRates = scored
    .map((t) => t.result!.quality!.all_files_pass_rate)
    .filter((n): n is number => typeof n === 'number' && Number.isFinite(n));
  const meanAllFilesPassRate = allFilesRates.length === scored.length && allFilesRates.length > 0
    ? round4(allFilesRates.reduce((sum, n) => sum + n, 0) / allFilesRates.length)
    : undefined;

  const deterministic = aggregateDeterministic(trials.map((t) => t.deterministic));
  const aggUsage = aggregateTrialMetrics(trials.map((t) => t.usage));
  let usage: ScorecardUsage | undefined;
  if (aggUsage) {
    const built: ScorecardUsage = {};
    for (const key of USAGE_METRIC_KEYS) {
      const m = aggUsage[key];
      if (m) {
        built[key] = { total: round4(m.total), mean: round4(m.mean), count: m.count };
      }
    }
    if (Object.keys(built).length > 0) usage = built;
  }

  return {
    recorded_at: recordedAt,
    agent_model: agentModel,
    judge_model: judgeModel,
    scope,
    ...(withJudgeCode ? { with_judge_code: true } : {}),
    rubric,
    ...(rubricGroups ? { rubric_groups: rubricGroups } : {}),
    trials: {
      total: trials.length,
      scored: scored.length,
      errored: errored.length,
    },
    deterministic,
    ...(usage ? { usage } : {}),
    quality: {
      pass_rate: round4(meanTrialPassRate),
      mean_pass_probability: round4(meanPassProb),
      ...(meanAllFilesPassRate !== undefined ? { all_files_pass_rate: meanAllFilesPassRate } : {}),
      checks,
    },
    hashes: {
      skill_hash: skillHash,
      task_hash: taskHash,
      rubric_hash: resolvedRubric.hash,
    },
    ...(resolvedShortSha ? { source: { git_ref: resolvedShortSha } } : {}),
  };
}

/** Record one or more saved judge batch directories into evals/scorecards/<skill>/<task>.json. */
export function recordJudgeBatches(options: RecordJudgeBatchOptions): RecordedEntrySummary[] {
  const repoRoot = resolve(options.repoRoot);
  const skill = options.skill ?? 'code-change';
  if (!options.judgeDirs.length) {
    throw new Error('Provide at least one saved judge batch directory to record.');
  }

  let resolvedGit: { full: string; short: string } | null = null;
  if (options.gitRef) {
    resolvedGit = resolveGitRef(repoRoot, options.gitRef);
  } else {
    try {
      // Only attach HEAD short SHA when recording from a clean git checkout if available; omit if not a git repo.
      resolvedGit = null;
    } catch {
      resolvedGit = null;
    }
  }

  const results: RecordedEntrySummary[] = [];

  for (const rawDir of options.judgeDirs) {
    const judgeDir = resolve(rawDir);
    const summaryPath = join(judgeDir, 'summary.json');
    if (!statSync(judgeDir, { throwIfNoEntry: false })?.isDirectory() || !existsSync(summaryPath)) {
      throw new Error(`No saved batch summary.json in ${judgeDir}. Pass a judge batch directory.`);
    }
    const summary = readJson(summaryPath) as BatchSummaryJson;
    if (!Array.isArray(summary.reports) || summary.reports.length === 0) {
      throw new Error(`Invalid summary.json in ${judgeDir}: reports must be a nonempty array.`);
    }

    const harborDir = findHarborRunDir(judgeDir, summary.source_run);
    const harborMeta = inspectHarborRun(judgeDir, summary.source_run, summary);

    if (harborMeta.isOracleOrNop && !options.condition) {
      throw new Error(`Refusing to record oracle/nop smoke run from ${judgeDir}. Scorecards track skill and baseline agent runs.`);
    }
    const condition = options.condition ?? harborMeta.condition;
    if (!condition) {
      throw new Error(`Could not determine condition (skill or baseline) for ${judgeDir}. Pass --condition skill|baseline.`);
    }

    const agentModel = options.agentModel ?? harborMeta.agentModel;
    if (!agentModel) {
      throw new Error(`Could not determine agent model for ${judgeDir}. Pass --agent-model <model-id>.`);
    }

    const recordedAt = options.recordedAt
      ?? harborMeta.finishedDate
      ?? toIsoDate(statSync(summaryPath).mtimeMs)
      ?? new Date().toISOString().slice(0, 10);

    const judgeModel = summary.model;
    const defaultScope: ScorecardScope = summary.scope === 'per-file' ? 'per-file' : 'whole';

    // Group reports by (task, target).
    const groups = new Map<string, {
      task: string;
      target: ScorecardTarget;
      scope: ScorecardScope;
      trials: Array<{
        status: string;
        result: SavedTrialResult | null;
        deterministic: Record<string, number>;
        usage: TrialUsageMetrics | null;
      }>;
    }>();

    for (const report of summary.reports) {
      if (options.taskFilter && report.task !== options.taskFilter) continue;
      const trialDir = resolveTrialResultDir(judgeDir, report);
      const resultPath = join(trialDir, 'result.json');
      const result: SavedTrialResult | null = existsSync(resultPath) ? (readJson(resultPath) as SavedTrialResult) : null;
      const status = result?.status ?? report.status;
      const target = result ? inferTarget(report, summary, result) : (report.target ?? summary.target ?? 'review');
      const scope: ScorecardScope = result?.scope ?? defaultScope;
      const det = result?.deterministic && Object.keys(result.deterministic).length > 0
        ? result.deterministic
        : (readFallbackDeterministic(harborDir, report.trial) ?? {});
      const savedUsage = normalizeTrialMetrics(report.usage);
      const fallbackTrialResult = harborDir ? join(harborDir, report.trial, 'result.json') : report.trialResultPath;
      const usage = savedUsage ?? (fallbackTrialResult ? readTrialMetrics(fallbackTrialResult) : null);

      const key = `${report.task}::${target}`;
      const bucket = groups.get(key) ?? { task: report.task, target, scope, trials: [] };
      bucket.trials.push({ status, result, deterministic: det, usage });
      groups.set(key, bucket);
    }

    if (groups.size === 0) {
      throw new Error(`No matching trials found in ${judgeDir}${options.taskFilter ? ` for task ${options.taskFilter}` : ''}.`);
    }

    for (const bucket of [...groups.values()].sort((a, b) => compareCodepoint(a.task, b.task) || compareCodepoint(a.target, b.target))) {
      const entry = buildEntryFromTrials({
        repoRoot,
        skill,
        task: bucket.task,
        target: bucket.target,
        condition,
        gitRef: resolvedGit?.full,
        resolvedShortSha: resolvedGit?.short,
        agentModel,
        judgeModel,
        scope: bucket.scope,
        withJudgeCode: harborMeta.withJudgeCode,
        recordedAt,
        trials: bucket.trials,
      });

      const outPath = join(repoRoot, 'evals/scorecards', skill, `${bucket.task}.json`);
      let existing: TaskScorecard | null = null;
      if (existsSync(outPath)) {
        existing = validateTaskScorecard(readJson(outPath), outPath);
      }

      const merged: TaskScorecard = normalizeTaskScorecard({
        schema_version: SCORECARD_SCHEMA_VERSION,
        skill,
        task: bucket.task,
        entries: {
          ...(existing?.entries ?? {}),
          [condition]: {
            ...(existing?.entries[condition] ?? {}),
            [bucket.target]: entry,
          },
        },
      });

      // Validate before writing so corrupt state is never persisted.
      const validated = validateTaskScorecard(merged, outPath);
      if (!options.dryRun) {
        mkdirSync(dirname(outPath), { recursive: true });
        writeFileSync(outPath, formatTaskScorecardJson(validated));
      }

      results.push({
        skill,
        task: bucket.task,
        condition,
        target: bucket.target,
        path: outPath,
        entry: validated.entries[condition]![bucket.target]!,
      });
    }
  }

  return results;
}
