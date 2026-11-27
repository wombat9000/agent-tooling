import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import {
  classifyTestFile,
  previewTestBundleRubric,
  previewTestFileRubric,
  routeTestBundleRubrics,
  routeTestRubrics,
  type TestKindClassification,
} from './classifier.mts';
import { MAX_INPUT_BYTES } from './inputs.mts';
import {
  CONVENTIONS_CHECK_ID,
  PASS_THRESHOLD,
  filterRubricForFiles,
  mergeResolvedRubrics,
  narrowResolvedRubric,
  nonempty,
  object,
  type ChoiceQuestion,
  type JudgeMode,
  type ResolvedRubric,
} from './rubrics.mts';
import type { StructureManifest } from './structure.mts';

export { PASS_THRESHOLD };
export const ERROR_SCORE_THRESHOLD = 60;
export const DEFAULT_PASS_SCORE = probabilityToScore(PASS_THRESHOLD);
export const ENDPOINT = 'https://openrouter.ai/api/alpha/decisions';
export const DEFAULT_DECISION_MODEL = 'liquid/d1.2-ultra';
export const DEFAULT_FILE_MODE_DECISION_MODEL = 'typesafe/jev-1.14';
export const DEFAULT_OPENROUTER_CONCURRENCY = 16;
export const DEFAULT_CLI_CONCURRENCY = 4;
const REQUEST_TIMEOUT_MS = 60_000;

export const RETRYABLE_HTTP_STATUSES = new Set([429, 502, 503, 504]);
export const DEFAULT_MAX_RETRIES = 4;
export const DEFAULT_BASE_DELAY_MS = 4_000;
export const DEFAULT_MAX_DELAY_MS = 30_000;
export const DEFAULT_MAX_RETRY_AFTER_MS = 60_000;

export type JudgeBackend = 'openrouter' | 'codex' | 'claude';
export type FindingSeverity = 'error' | 'warning';

export interface RetryOptions {
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  maxRetryAfterMs?: number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  now?: () => number;
  onRetry?: (info: { status: number; attempt: number; maxAttempts: number; delayMs: number }) => void;
}

export interface Judgment {
  choice: 'pass' | 'fail';
  severity?: FindingSeverity;
  model_choice?: 'pass' | 'borderline' | 'fail';
  score: number | null;
  pass_threshold?: number;
  note?: string;
  files_passed?: number;
  files_total?: number;
  files_errors?: number;
  files_warnings?: number;
  min_score?: number | null;
}

export interface FileJudgment {
  file: string;
  file_role?: string;
  status: 'scored' | 'dry_run' | 'skipped' | 'error';
  skip_reason?: 'not_applicable';
  returned_model: string | null;
  elapsed_ms: number;
  pass_rate: number | null;
  checks: Record<string, Judgment> | null;
  applicable_checks?: string[];
  result_dir?: string;
  error?: string;
}

export interface ModuleInput {
  name: string;
  files: Record<string, string>;
  testFiles?: Record<string, string>;
  requirements?: string;
  conventions?: string;
}

export interface ModuleJudgment {
  module: string;
  status: 'scored' | 'dry_run' | 'skipped' | 'error';
  skip_reason?: 'not_applicable';
  file_count: number;
  returned_model: string | null;
  elapsed_ms: number;
  pass_rate: number | null;
  checks: Record<string, Judgment> | null;
  applicable_checks?: string[];
  result_dir?: string;
  error?: string;
}

export interface CodeRequest {
  model: string;
  state: {
    requirement?: string;
    conventions?: string;
    production_files?: Record<string, string>;
    test_files?: Record<string, string>;
    production_files_context?: Record<string, string>;
    project_structure?: StructureManifest;
  };
  questions: Record<string, ChoiceQuestion>;
}

export interface JudgeResult {
  status: 'scored' | 'dry_run' | 'error';
  backend: JudgeBackend;
  mode: JudgeMode;
  target?: string;
  file_count: number;
  elapsed_ms?: number;
  retries?: number;
  requested_model: string | null;
  returned_model: string | null;
  rubric: string;
  rubric_groups: Record<string, string[]>;
  excluded_checks?: string[];
  ignored_patterns?: string[];
  skipped_module_checks?: string[];
  skipped_not_applicable_checks?: string[];
  pass_threshold: number | null;
  check_thresholds?: Record<string, number>;
  quality: {
    pass_rate: number;
    all_files_pass_rate?: number;
    checks: Record<string, Judgment>;
  } | null;
  file_results?: FileJudgment[];
  module_results?: ModuleJudgment[];
  error?: string;
}

export interface JudgeRunOptions {
  mode?: JudgeMode;
  target?: string;
  files?: Record<string, string>;
  testFiles?: Record<string, string>;
  productionContext?: Record<string, string>;
  modules?: ModuleInput[];
  structure?: StructureManifest;
  ignore?: string[];
  requirements?: string;
  conventions?: string;
  rubric: ResolvedRubric;
  testRubric?: ResolvedRubric;
  explicitTestSelection?: boolean;
  model?: string;
  out?: string;
  concurrency?: number;
  dryRun?: boolean;
  allowEmpty?: boolean;
}

export type ScoreRequestFn = (
  request: CodeRequest,
  body: string,
  artifactDir?: string,
) => Promise<{ model: string; checks: Record<string, Judgment>; retries?: number }>;

export type TestClassifierFn = (
  filePath: string,
  content: string,
) => Promise<TestKindClassification>;

/**
 * Convert a raw model probability in [0, 1] to the 0-100 score scale (1 decimal precision).
 * When `guardThresholds` (on the 0-100 scale) are provided, a probability strictly below a
 * threshold never rounds up to equal or exceed that threshold.
 */
export function probabilityToScore(
  prob: number,
  guardThresholds: readonly number[] = [],
): number {
  const rounded = Number((prob * 100).toFixed(1));
  for (const thresholdScore of guardThresholds) {
    const thresholdProb = thresholdScore / 100;
    if (prob < thresholdProb && rounded >= thresholdScore) {
      const floored = Math.floor(prob * 1000) / 10;
      const maxBelow = Number((thresholdScore - 0.1).toFixed(1));
      return Number(Math.min(floored, maxBelow).toFixed(1));
    }
  }
  return rounded;
}

/** Convert a map of raw (0, 1] rubric thresholds to the 0-100 score scale. */
export function thresholdsToScores(thresholds: Record<string, number>): Record<string, number> {
  return Object.fromEntries(
    Object.entries(thresholds).map(([id, threshold]) => [id, probabilityToScore(threshold)]),
  );
}

/**
 * Map a scored check to ESLint-style severity on the 0-100 score scale:
 * - `error`: score < 60 (raw probability < 0.60, or CLI backend `'fail'`)
 * - `warning`: 60 <= score < pass_threshold (or CLI backend `'borderline'`)
 * - `null`: passing check
 */
export function findingSeverity(
  check: Pick<Judgment, 'choice' | 'severity' | 'model_choice' | 'score'>,
): FindingSeverity | null {
  if (check.choice !== 'fail') return null;
  if (check.severity === 'error' || check.severity === 'warning') return check.severity;
  if (typeof check.score === 'number' && Number.isFinite(check.score)) {
    return check.score < ERROR_SCORE_THRESHOLD ? 'error' : 'warning';
  }
  if (check.model_choice === 'fail') return 'error';
  if (check.model_choice === 'borderline') return 'warning';
  return 'error';
}

/** Count total error and warning findings across a JudgeResult. */
export function countResultFindings(result: JudgeResult): { errors: number; warnings: number } {
  let errors = 0;
  let warnings = 0;
  const tallyChecks = (checks: Record<string, Judgment> | null | undefined) => {
    if (!checks) return;
    for (const check of Object.values(checks)) {
      const sev = findingSeverity(check);
      if (sev === 'error') errors += 1;
      else if (sev === 'warning') warnings += 1;
    }
  };
  if (result.file_results) {
    for (const entry of result.file_results) {
      if (entry.status === 'scored') tallyChecks(entry.checks);
    }
    return { errors, warnings };
  }
  if (result.module_results) {
    for (const entry of result.module_results) {
      if (entry.status === 'scored') tallyChecks(entry.checks);
    }
    return { errors, warnings };
  }
  if (result.status === 'scored' && result.quality) {
    tallyChecks(result.quality.checks);
  }
  return { errors, warnings };
}

export function numbered(files: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(files).map(([path, text]) => [path,
    text.split(/\r?\n/).map((line, index) => `${index + 1}: ${line}`).join('\n')]));
}

export function saveJson(path: string, value: unknown): string {
  const body = `${JSON.stringify(value, null, 2)}\n`;
  writeFileSync(path, body, { mode: 0o600 });
  return body;
}

export function passRate(checks: Record<string, Judgment>): number {
  const values = Object.values(checks);
  return values.length > 0 ? values.filter((check) => check.choice === 'pass').length / values.length : 1;
}

export function safeFileSlug(index: number, totalFiles: number, filePath: string): string {
  const width = Math.max(2, String(totalFiles).length);
  const prefix = String(index + 1).padStart(width, '0');
  const sanitized = filePath.replace(/[^a-zA-Z0-9.-]/g, '_');
  const maxSlugLen = 180;
  const trimmed = sanitized.length > maxSlugLen ? sanitized.slice(-maxSlugLen) : sanitized;
  return `${prefix}-${trimmed}`;
}

export async function runWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const limit = Math.max(1, Math.min(concurrency, items.length || 1));
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  async function runWorker(): Promise<void> {
    while (true) {
      const index = nextIndex;
      if (index >= items.length) return;
      nextIndex += 1;
      results[index] = await worker(items[index], index);
    }
  }

  await Promise.all(Array.from({ length: limit }, () => runWorker()));
  return results;
}

function overriddenThresholds(
  thresholds: Record<string, number>,
  defaultThreshold: number | null,
): Record<string, number> | undefined {
  if (defaultThreshold === null) return undefined;
  const overrides = Object.entries(thresholds).filter(([, threshold]) => threshold !== defaultThreshold);
  return overrides.length > 0 ? Object.fromEntries(overrides) : undefined;
}

export function aggregatePerFile(
  fileResults: Array<{ status?: string; pass_rate: number | null; checks: Record<string, Judgment> | null }>,
  questionIds: string[],
  thresholds?: Record<string, number>,
): { pass_rate: number; all_files_pass_rate: number; checks: Record<string, Judgment> } {
  const scoredTargets = fileResults.filter(
    (entry) => (entry.status === undefined || entry.status === 'scored') && entry.checks !== null,
  );
  if (scoredTargets.length === 0) {
    return { pass_rate: 1, all_files_pass_rate: 1, checks: {} };
  }
  const checks: Record<string, Judgment> = {};

  for (const id of questionIds) {
    const perTarget = scoredTargets
      .map((entry) => entry.checks![id])
      .filter((c): c is Judgment => c !== undefined);
    if (perTarget.length === 0) continue;
    const targetCount = perTarget.length;
    const passed = perTarget.filter((c) => c.choice === 'pass').length;
    const errors = perTarget.filter((c) => findingSeverity(c) === 'error').length;
    const warnings = perTarget.filter((c) => findingSeverity(c) === 'warning').length;
    const hasScores = perTarget.every((c) => typeof c.score === 'number');
    const meanScore = hasScores
      ? Number((perTarget.reduce((sum, c) => sum + c.score!, 0) / targetCount).toFixed(1))
      : null;
    const minScore = hasScores
      ? Math.min(...perTarget.map((c) => c.score!))
      : null;
    const rawThreshold = thresholds?.[id];
    const scoreThreshold = rawThreshold !== undefined
      ? (rawThreshold > 0 && rawThreshold <= 1 ? probabilityToScore(rawThreshold) : rawThreshold)
      : undefined;
    const choice: 'pass' | 'fail' = passed === targetCount ? 'pass' : 'fail';
    const severity: FindingSeverity | undefined = choice === 'fail'
      ? (errors > 0 ? 'error' : 'warning')
      : undefined;
    checks[id] = {
      choice,
      ...(severity ? { severity } : {}),
      files_passed: passed,
      files_total: targetCount,
      ...(errors > 0 ? { files_errors: errors } : {}),
      ...(warnings > 0 ? { files_warnings: warnings } : {}),
      score: meanScore,
      min_score: minScore,
      ...(scoreThreshold !== undefined && scoreThreshold !== DEFAULT_PASS_SCORE ? { pass_threshold: scoreThreshold } : {}),
    };
  }

  const evaluatedCount = Object.keys(checks).length;
  const meanTargetPassRate = scoredTargets.reduce((sum, entry) => sum + (entry.pass_rate ?? 0), 0) / scoredTargets.length;
  const allTargetsPassRate = evaluatedCount > 0
    ? Object.values(checks).filter((c) => c.choice === 'pass').length / evaluatedCount
    : 1;
  return {
    pass_rate: meanTargetPassRate,
    all_files_pass_rate: allTargetsPassRate,
    checks,
  };
}

export function prepareJudgeRun(
  options: JudgeRunOptions,
  backend: JudgeBackend,
  passThreshold: number | null,
): { out?: string; request: CodeRequest; body: string; result: JudgeResult; rubric: ResolvedRubric } {
  const isStructure = options.rubric.target === 'project_structure';
  const isTestCode = options.rubric.target === 'test_code';
  const fileCount = isStructure
    ? (options.structure?.total_files ?? 0)
    : Object.keys(options.files ?? {}).length;
  if (fileCount === 0) throw new Error('No files to score');

  const effectiveRubric = isStructure
    ? options.rubric
    : filterRubricForFiles(options.rubric, options.files ?? {});
  const skippedNotApplicable = Object.keys(options.rubric.questions).filter(
    (id) => !(id in effectiveRubric.questions),
  );
  const hasApplicableChecks = Object.keys(effectiveRubric.questions).length > 0;

  let out: string | undefined;
  if (options.out !== undefined) {
    out = resolve(options.out);
    mkdirSync(dirname(out), { recursive: true, mode: 0o700 });
    mkdirSync(out, { mode: 0o700 });
  }

  const hasProductionContext = options.productionContext !== undefined
    && Object.keys(options.productionContext).length > 0;
  const state: CodeRequest['state'] = {
    ...(options.requirements !== undefined ? { requirement: options.requirements } : {}),
    ...(options.conventions !== undefined ? { conventions: options.conventions } : {}),
    ...(isStructure
      ? { project_structure: options.structure }
      : isTestCode
        ? {
          test_files: numbered(options.files!),
          ...(hasProductionContext ? { production_files_context: numbered(options.productionContext!) } : {}),
        }
        : { production_files: numbered(options.files!) }),
  };
  const request: CodeRequest = {
    model: options.model ?? `${backend}-default`,
    state,
    questions: effectiveRubric.questions,
  };
  const body = hasApplicableChecks
    ? (out !== undefined
      ? saveJson(join(out, 'request.json'), request)
      : `${JSON.stringify(request, null, 2)}\n`)
    : '';
  const checkThresholds = overriddenThresholds(thresholdsToScores(effectiveRubric.thresholds), passThreshold);
  const ignoredPatterns = [...new Set(options.ignore ?? [])];

  const result: JudgeResult = {
    status: options.dryRun ? 'dry_run' : 'scored',
    backend,
    mode: isStructure ? 'structure' : 'code',
    ...(options.target ? { target: options.target } : {}),
    file_count: fileCount,
    requested_model: options.model ?? null,
    returned_model: null,
    rubric: effectiveRubric.rubric,
    rubric_groups: effectiveRubric.groups,
    ...(effectiveRubric.excluded.length > 0 ? { excluded_checks: effectiveRubric.excluded } : {}),
    ...(ignoredPatterns.length > 0 ? { ignored_patterns: ignoredPatterns } : {}),
    ...(skippedNotApplicable.length > 0 ? { skipped_not_applicable_checks: skippedNotApplicable } : {}),
    pass_threshold: passThreshold,
    ...(checkThresholds ? { check_thresholds: checkThresholds } : {}),
    quality: !options.dryRun && !hasApplicableChecks ? { pass_rate: 1, checks: {} } : null,
  };

  return { out, request, body, result, rubric: effectiveRubric };
}

function resolvePartitionRubrics(options: JudgeRunOptions): {
  isUnified: boolean;
  prodRubric?: ResolvedRubric;
  testRubric?: ResolvedRubric;
  candidateRubric: ResolvedRubric;
} {
  const isUnified = options.testFiles !== undefined || options.testRubric !== undefined;
  const prodRubric = options.rubric.target === 'production_code' ? options.rubric : undefined;
  const testRubric = options.testRubric ?? (options.rubric.target === 'test_code' ? options.rubric : undefined);
  const parts = [prodRubric, testRubric].filter((r): r is ResolvedRubric => r !== undefined);
  const candidateRubric = parts.length > 0 ? mergeResolvedRubrics(parts) : options.rubric;
  return { isUnified, prodRubric, testRubric, candidateRubric };
}

function emptyResolvedRubric(base: ResolvedRubric): ResolvedRubric {
  return narrowResolvedRubric(base, new Set());
}

function withoutConventionsCheck(rubric: ResolvedRubric): ResolvedRubric {
  if (!(CONVENTIONS_CHECK_ID in rubric.questions)) return rubric;
  const keep = new Set(Object.keys(rubric.questions).filter((id) => id !== CONVENTIONS_CHECK_ID));
  return narrowResolvedRubric(rubric, keep);
}

function utf8BytesOfFiles(files: Record<string, string>): number {
  let bytes = 0;
  for (const content of Object.values(files)) {
    bytes += Buffer.byteLength(content, 'utf8');
  }
  return bytes;
}

function fitsProductionContext(
  testFiles: Record<string, string>,
  prodFiles: Record<string, string>,
  requirements?: string,
  conventions?: string,
): boolean {
  if (Object.keys(prodFiles).length === 0) return false;
  let total = utf8BytesOfFiles(testFiles) + utf8BytesOfFiles(prodFiles);
  if (requirements !== undefined) total += Buffer.byteLength(requirements, 'utf8');
  if (conventions !== undefined) total += Buffer.byteLength(conventions, 'utf8');
  return total <= MAX_INPUT_BYTES;
}

export async function runPerFileJudge(
  options: JudgeRunOptions,
  backend: JudgeBackend,
  passThreshold: number | null,
  defaultConcurrency: number,
  scoreFile: ScoreRequestFn,
  classifyTest?: TestClassifierFn,
): Promise<JudgeResult> {
  const { isUnified, prodRubric, testRubric, candidateRubric } = resolvePartitionRubrics(options);
  const prodFiles = options.files ?? {};
  const testFiles = isUnified ? (options.testFiles ?? {}) : {};
  const ignoredPatterns = [...new Set(options.ignore ?? [])];

  interface FileWorkItem {
    file: string;
    content: string;
    partition: 'production' | 'test';
  }
  const workItems: FileWorkItem[] = [
    ...Object.entries(prodFiles).map(([file, content]) => ({ file, content, partition: 'production' as const })),
    ...Object.entries(testFiles).map(([file, content]) => ({ file, content, partition: 'test' as const })),
  ].sort((a, b) => a.file.localeCompare(b.file));

  if (workItems.length === 0) {
    if (!options.allowEmpty) throw new Error('No files to score');
    const checkThresholds = overriddenThresholds(thresholdsToScores(candidateRubric.thresholds), passThreshold);
    const emptyResult: JudgeResult = {
      status: options.dryRun ? 'dry_run' : 'scored',
      backend,
      mode: 'file',
      file_count: 0,
      elapsed_ms: 0,
      requested_model: options.model ?? null,
      returned_model: null,
      rubric: candidateRubric.rubric,
      rubric_groups: candidateRubric.groups,
      ...(candidateRubric.excluded.length > 0 ? { excluded_checks: candidateRubric.excluded } : {}),
      ...(ignoredPatterns.length > 0 ? { ignored_patterns: ignoredPatterns } : {}),
      ...(candidateRubric.skippedModuleChecks.length > 0
        ? { skipped_module_checks: candidateRubric.skippedModuleChecks }
        : {}),
      pass_threshold: passThreshold,
      ...(checkThresholds ? { check_thresholds: checkThresholds } : {}),
      quality: options.dryRun ? null : { pass_rate: 1, all_files_pass_rate: 1, checks: {} },
      file_results: [],
    };
    if (options.out !== undefined) {
      const out = resolve(options.out);
      mkdirSync(dirname(out), { recursive: true, mode: 0o700 });
      mkdirSync(out, { mode: 0o700 });
      saveJson(join(out, 'result.json'), emptyResult);
    }
    return emptyResult;
  }

  const startMs = performance.now();
  let out: string | undefined;
  let filesOutDirCreated = false;
  if (options.out !== undefined) {
    out = resolve(options.out);
    mkdirSync(dirname(out), { recursive: true, mode: 0o700 });
    mkdirSync(out, { mode: 0o700 });
  }
  const ensureFileDir = (index: number, file: string): { relDir?: string; absDir?: string } => {
    if (out === undefined) return {};
    if (!filesOutDirCreated) {
      mkdirSync(join(out, 'files'), { recursive: true, mode: 0o700 });
      filesOutDirCreated = true;
    }
    const slug = safeFileSlug(index, workItems.length, file);
    const relDir = `files/${slug}`;
    const absDir = join(out, relDir);
    mkdirSync(absDir, { recursive: true, mode: 0o700 });
    return { relDir, absDir };
  };

  const concurrency = options.concurrency ?? defaultConcurrency;
  let totalRetries = 0;

  interface FileOutcome {
    entry: FileJudgment;
    questionIds: string[];
  }

  const outcomes = await runWithConcurrency(workItems, concurrency, async (item, index): Promise<FileOutcome> => {
    const fileStart = performance.now();
    const { file, content, partition } = item;

    let fileRubric: ResolvedRubric;
    let fileRole: string | undefined;
    let useTestPayload = !isUnified && options.rubric.target === 'test_code';

    if (!isUnified) {
      fileRubric = filterRubricForFiles(options.rubric, { [file]: content });
    } else if (partition === 'production') {
      fileRubric = prodRubric
        ? filterRubricForFiles(prodRubric, { [file]: content })
        : emptyResolvedRubric(candidateRubric);
    } else {
      useTestPayload = true;
      if (!testRubric) {
        fileRubric = emptyResolvedRubric(candidateRubric);
      } else if (options.explicitTestSelection) {
        fileRubric = filterRubricForFiles(testRubric, { [file]: content });
        fileRole = 'test';
      } else if (options.dryRun) {
        const preview = previewTestFileRubric({ filePath: file, content }, testRubric);
        fileRubric = preview.rubric;
        fileRole = preview.fileRole;
      } else {
        if (!classifyTest) {
          throw new Error('Test classifier is required for automatic test-file linting');
        }
        try {
          const classification = await classifyTest(file, content);
          totalRetries += classification.retries;
          fileRole = classification.fileRole;
          fileRubric = routeTestRubrics(classification, testRubric);
        } catch (error) {
          const entry: FileJudgment = {
            file,
            file_role: 'test',
            status: 'error',
            returned_model: null,
            elapsed_ms: Math.round(performance.now() - fileStart),
            pass_rate: null,
            checks: null,
            error: error instanceof Error ? error.message : 'Test classification failed',
          };
          return { entry, questionIds: [] };
        }
      }
    }

    const fileQuestionIds = Object.keys(fileRubric.questions);
    if (fileQuestionIds.length === 0) {
      return {
        entry: {
          file,
          ...(fileRole ? { file_role: fileRole } : {}),
          status: 'skipped',
          skip_reason: 'not_applicable',
          returned_model: null,
          elapsed_ms: Math.round(performance.now() - fileStart),
          pass_rate: null,
          checks: null,
        },
        questionIds: [],
      };
    }

    const { relDir, absDir } = ensureFileDir(index, file);
    const hasProductionContext = !isUnified
      && options.productionContext !== undefined
      && Object.keys(options.productionContext).length > 0;
    const request: CodeRequest = {
      model: options.model ?? `${backend}-default`,
      state: {
        ...(options.requirements !== undefined ? { requirement: options.requirements } : {}),
        ...(options.conventions !== undefined ? { conventions: options.conventions } : {}),
        ...(useTestPayload
          ? {
            test_files: numbered({ [file]: content }),
            ...(hasProductionContext ? { production_files_context: numbered(options.productionContext!) } : {}),
          }
          : { production_files: numbered({ [file]: content }) }),
      },
      questions: fileRubric.questions,
    };
    const body = absDir !== undefined
      ? saveJson(join(absDir, 'request.json'), request)
      : `${JSON.stringify(request, null, 2)}\n`;

    const entry: FileJudgment = {
      file,
      ...(fileRole ? { file_role: fileRole } : {}),
      status: options.dryRun ? 'dry_run' : 'scored',
      returned_model: null,
      elapsed_ms: 0,
      pass_rate: null,
      checks: null,
      ...(relDir !== undefined ? { result_dir: relDir } : {}),
    };

    if (options.dryRun) {
      entry.elapsed_ms = Math.round(performance.now() - fileStart);
      if (absDir !== undefined) saveJson(join(absDir, 'result.json'), entry);
      return { entry, questionIds: fileQuestionIds };
    }

    try {
      const judged = await scoreFile(request, body, absDir);
      totalRetries += judged.retries ?? 0;
      entry.status = 'scored';
      entry.returned_model = judged.model;
      entry.checks = judged.checks;
      entry.pass_rate = passRate(judged.checks);
    } catch (error) {
      entry.status = 'error';
      entry.error = error instanceof Error ? error.message : 'Judging failed';
    }
    entry.elapsed_ms = Math.round(performance.now() - fileStart);
    if (absDir !== undefined) saveJson(join(absDir, 'result.json'), entry);
    return { entry, questionIds: fileQuestionIds };
  });

  const activeCheckIds = new Set<string>();
  for (const outcome of outcomes) {
    for (const id of outcome.questionIds) activeCheckIds.add(id);
  }
  const effectiveRubric = narrowResolvedRubric(candidateRubric, activeCheckIds);
  const skippedNotApplicable = Object.keys(candidateRubric.questions).filter((id) => !activeCheckIds.has(id));
  const activeQuestionIds = Object.keys(effectiveRubric.questions);
  const checkThresholds = overriddenThresholds(thresholdsToScores(effectiveRubric.thresholds), passThreshold);

  const fileResults = outcomes.map(({ entry, questionIds }) => {
    if (questionIds.length > 0 && questionIds.length < activeQuestionIds.length) {
      return { ...entry, applicable_checks: questionIds };
    }
    return entry;
  });

  const errored = fileResults.filter((entry) => entry.status === 'error');
  const models = [...new Set(fileResults.map((entry) => entry.returned_model).filter((m): m is string => Boolean(m)))];
  const elapsedMs = Math.round(performance.now() - startMs);

  const result: JudgeResult = {
    status: options.dryRun ? 'dry_run' : errored.length > 0 ? 'error' : 'scored',
    backend,
    mode: 'file',
    file_count: workItems.length,
    elapsed_ms: elapsedMs,
    ...(totalRetries > 0 ? { retries: totalRetries } : {}),
    requested_model: options.model ?? null,
    returned_model: models.join(', ') || null,
    rubric: effectiveRubric.rubric,
    rubric_groups: effectiveRubric.groups,
    ...(effectiveRubric.excluded.length > 0 ? { excluded_checks: effectiveRubric.excluded } : {}),
    ...(ignoredPatterns.length > 0 ? { ignored_patterns: ignoredPatterns } : {}),
    ...(effectiveRubric.skippedModuleChecks.length > 0
      ? { skipped_module_checks: effectiveRubric.skippedModuleChecks }
      : {}),
    ...(skippedNotApplicable.length > 0 ? { skipped_not_applicable_checks: skippedNotApplicable } : {}),
    pass_threshold: passThreshold,
    ...(checkThresholds ? { check_thresholds: checkThresholds } : {}),
    quality: !options.dryRun && errored.length === 0
      ? aggregatePerFile(fileResults, activeQuestionIds, passThreshold !== null ? thresholdsToScores(effectiveRubric.thresholds) : undefined)
      : null,
    file_results: fileResults,
    ...(errored.length > 0
      ? {
        error: `${errored.length} of ${fileResults.length} file(s) failed: ${errored[0].file}: ${errored[0].error}`,
      }
      : {}),
  };

  if (out !== undefined) saveJson(join(out, 'result.json'), result);
  return result;
}

interface ModuleEvalOutcome {
  entry: ModuleJudgment;
  questionIds: string[];
  retries: number;
}

async function evaluateModuleBundle(
  mod: ModuleInput,
  options: JudgeRunOptions,
  backend: JudgeBackend,
  concurrency: number,
  scoreModule: ScoreRequestFn,
  classifyTest: TestClassifierFn | undefined,
  absDir: string | undefined,
  relDir: string | undefined,
): Promise<ModuleEvalOutcome> {
  const modStart = performance.now();
  const { isUnified, prodRubric, testRubric, candidateRubric } = resolvePartitionRubrics(options);
  const prodFiles = mod.files;
  const testFiles = isUnified ? (mod.testFiles ?? {}) : {};
  const prodCount = Object.keys(prodFiles).length;
  const testCount = Object.keys(testFiles).length;
  const totalFileCount = prodCount + testCount;
  const requirements = mod.requirements ?? options.requirements;
  const conventions = mod.conventions ?? options.conventions;

  let retries = 0;

  const activeProdRubric = prodCount > 0 && prodRubric
    ? filterRubricForFiles(prodRubric, prodFiles)
    : emptyResolvedRubric(candidateRubric);
  const hasProdPass = Object.keys(activeProdRubric.questions).length > 0;

  let activeTestRubric = emptyResolvedRubric(candidateRubric);
  if (testCount > 0 && testRubric) {
    if (options.explicitTestSelection) {
      activeTestRubric = filterRubricForFiles(testRubric, testFiles);
    } else if (options.dryRun) {
      activeTestRubric = previewTestBundleRubric(testFiles, testRubric);
    } else {
      if (!classifyTest) {
        throw new Error('Test classifier is required for automatic test-file module linting');
      }
      const testEntries = Object.entries(testFiles).sort(([a], [b]) => a.localeCompare(b));
      try {
        const classifications = await runWithConcurrency(
          testEntries,
          concurrency,
          async ([filePath, content]) => classifyTest(filePath, content),
        );
        for (const c of classifications) retries += c.retries;
        activeTestRubric = routeTestBundleRubrics(classifications, testRubric);
      } catch (error) {
        return {
          entry: {
            module: mod.name,
            status: 'error',
            file_count: totalFileCount,
            returned_model: null,
            elapsed_ms: Math.round(performance.now() - modStart),
            pass_rate: null,
            checks: null,
            ...(relDir !== undefined ? { result_dir: relDir } : {}),
            error: error instanceof Error ? error.message : 'Test classification failed',
          },
          questionIds: [],
          retries,
        };
      }
    }
    if (hasProdPass && CONVENTIONS_CHECK_ID in activeProdRubric.questions) {
      activeTestRubric = withoutConventionsCheck(activeTestRubric);
    }
  }
  const hasTestPass = Object.keys(activeTestRubric.questions).length > 0;

  const questionIds = [
    ...Object.keys(activeProdRubric.questions),
    ...Object.keys(activeTestRubric.questions),
  ];

  if (!hasProdPass && !hasTestPass) {
    return {
      entry: {
        module: mod.name,
        status: 'skipped',
        skip_reason: 'not_applicable',
        file_count: totalFileCount,
        returned_model: null,
        elapsed_ms: Math.round(performance.now() - modStart),
        pass_rate: null,
        checks: null,
      },
      questionIds: [],
      retries,
    };
  }

  if (absDir !== undefined) {
    mkdirSync(absDir, { recursive: true, mode: 0o700 });
  }

  const prodRequest: CodeRequest | undefined = hasProdPass
    ? {
      model: options.model ?? `${backend}-default`,
      state: {
        ...(requirements !== undefined ? { requirement: requirements } : {}),
        ...(conventions !== undefined ? { conventions } : {}),
        production_files: numbered(prodFiles),
      },
      questions: activeProdRubric.questions,
    }
    : undefined;

  const includeProdContext = hasTestPass
    && fitsProductionContext(testFiles, prodFiles, requirements, conventions);
  const testRequest: CodeRequest | undefined = hasTestPass
    ? {
      model: options.model ?? `${backend}-default`,
      state: {
        ...(requirements !== undefined ? { requirement: requirements } : {}),
        ...(conventions !== undefined ? { conventions } : {}),
        test_files: numbered(testFiles),
        ...(includeProdContext ? { production_files_context: numbered(prodFiles) } : {}),
      },
      questions: activeTestRubric.questions,
    }
    : undefined;

  const prodBody = prodRequest
    ? (absDir !== undefined
      ? saveJson(join(absDir, 'request.json'), prodRequest)
      : `${JSON.stringify(prodRequest, null, 2)}\n`)
    : undefined;
  const testReqFilename = hasProdPass ? 'test-request.json' : 'request.json';
  const testBody = testRequest
    ? (absDir !== undefined
      ? saveJson(join(absDir, testReqFilename), testRequest)
      : `${JSON.stringify(testRequest, null, 2)}\n`)
    : undefined;

  const entry: ModuleJudgment = {
    module: mod.name,
    status: options.dryRun ? 'dry_run' : 'scored',
    file_count: totalFileCount,
    returned_model: null,
    elapsed_ms: 0,
    pass_rate: null,
    checks: null,
    ...(relDir !== undefined ? { result_dir: relDir } : {}),
  };

  if (options.dryRun) {
    entry.elapsed_ms = Math.round(performance.now() - modStart);
    if (absDir !== undefined) saveJson(join(absDir, 'result.json'), entry);
    return { entry, questionIds, retries };
  }

  try {
    const models: string[] = [];
    const mergedChecks: Record<string, Judgment> = {};
    const tasks: Array<Promise<void>> = [];

    if (prodRequest && prodBody !== undefined) {
      tasks.push((async () => {
        const judged = await scoreModule(prodRequest, prodBody, absDir);
        retries += judged.retries ?? 0;
        models.push(judged.model);
        Object.assign(mergedChecks, judged.checks);
      })());
    }
    if (testRequest && testBody !== undefined) {
      const testArtifactDir = absDir !== undefined && hasProdPass ? join(absDir, 'tests') : absDir;
      if (testArtifactDir !== undefined && testArtifactDir !== absDir) {
        mkdirSync(testArtifactDir, { recursive: true, mode: 0o700 });
      }
      tasks.push((async () => {
        const judged = await scoreModule(testRequest, testBody, testArtifactDir);
        retries += judged.retries ?? 0;
        models.push(judged.model);
        Object.assign(mergedChecks, judged.checks);
      })());
    }

    await Promise.all(tasks);
    entry.status = 'scored';
    entry.returned_model = [...new Set(models)].join(', ') || null;
    entry.checks = mergedChecks;
    entry.pass_rate = passRate(mergedChecks);
  } catch (error) {
    entry.status = 'error';
    entry.error = error instanceof Error ? error.message : 'Judging failed';
  }

  entry.elapsed_ms = Math.round(performance.now() - modStart);
  if (absDir !== undefined) saveJson(join(absDir, 'result.json'), entry);
  return { entry, questionIds, retries };
}

export async function runMultiModuleJudge(
  options: JudgeRunOptions,
  backend: JudgeBackend,
  passThreshold: number | null,
  defaultConcurrency: number,
  scoreModule: ScoreRequestFn,
  classifyTest?: TestClassifierFn,
): Promise<JudgeResult> {
  const modules = options.modules ?? [];
  if (modules.length === 0) throw new Error('No modules to score');

  const { candidateRubric } = resolvePartitionRubrics(options);
  const startMs = performance.now();
  let out: string | undefined;
  let modulesOutCreated = false;
  if (options.out !== undefined) {
    out = resolve(options.out);
    mkdirSync(dirname(out), { recursive: true, mode: 0o700 });
    mkdirSync(out, { mode: 0o700 });
  }

  const concurrency = options.concurrency ?? defaultConcurrency;
  let totalRetries = 0;

  const outcomes = await runWithConcurrency(modules, concurrency, async (mod, index) => {
    let relDir: string | undefined;
    let absDir: string | undefined;
    if (out !== undefined) {
      if (!modulesOutCreated) {
        mkdirSync(join(out, 'modules'), { recursive: true, mode: 0o700 });
        modulesOutCreated = true;
      }
      const slug = safeFileSlug(index, modules.length, mod.name);
      relDir = `modules/${slug}`;
      absDir = join(out, relDir);
    }
    const outcome = await evaluateModuleBundle(
      mod,
      options,
      backend,
      concurrency,
      scoreModule,
      classifyTest,
      absDir,
      relDir,
    );
    totalRetries += outcome.retries;
    return outcome;
  });

  const activeCheckIds = new Set<string>();
  for (const outcome of outcomes) {
    for (const id of outcome.questionIds) activeCheckIds.add(id);
  }
  const effectiveRubric = narrowResolvedRubric(candidateRubric, activeCheckIds);
  const skippedNotApplicable = Object.keys(candidateRubric.questions).filter((id) => !activeCheckIds.has(id));
  const activeQuestionIds = Object.keys(effectiveRubric.questions);

  const moduleResults = outcomes.map(({ entry, questionIds }) => {
    if (questionIds.length > 0 && questionIds.length < activeQuestionIds.length) {
      return { ...entry, applicable_checks: questionIds };
    }
    return entry;
  });

  const errored = moduleResults.filter((entry) => entry.status === 'error');
  const models = [...new Set(moduleResults.map((entry) => entry.returned_model).filter((m): m is string => Boolean(m)))];
  const elapsedMs = Math.round(performance.now() - startMs);
  const totalFiles = moduleResults.reduce((sum, entry) => sum + entry.file_count, 0);
  const checkThresholds = overriddenThresholds(thresholdsToScores(effectiveRubric.thresholds), passThreshold);
  const ignoredPatterns = [...new Set(options.ignore ?? [])];

  const result: JudgeResult = {
    status: options.dryRun ? 'dry_run' : errored.length > 0 ? 'error' : 'scored',
    backend,
    mode: 'code',
    file_count: totalFiles,
    elapsed_ms: elapsedMs,
    ...(totalRetries > 0 ? { retries: totalRetries } : {}),
    requested_model: options.model ?? null,
    returned_model: models.join(', ') || null,
    rubric: effectiveRubric.rubric,
    rubric_groups: effectiveRubric.groups,
    ...(effectiveRubric.excluded.length > 0 ? { excluded_checks: effectiveRubric.excluded } : {}),
    ...(ignoredPatterns.length > 0 ? { ignored_patterns: ignoredPatterns } : {}),
    ...(skippedNotApplicable.length > 0 ? { skipped_not_applicable_checks: skippedNotApplicable } : {}),
    pass_threshold: passThreshold,
    ...(checkThresholds ? { check_thresholds: checkThresholds } : {}),
    quality: !options.dryRun && errored.length === 0
      ? aggregatePerFile(moduleResults, activeQuestionIds, passThreshold !== null ? thresholdsToScores(effectiveRubric.thresholds) : undefined)
      : null,
    module_results: moduleResults,
    ...(errored.length > 0
      ? {
        error: `${errored.length} of ${moduleResults.length} module(s) failed: ${errored[0].module}: ${errored[0].error}`,
      }
      : {}),
  };

  if (out !== undefined) saveJson(join(out, 'result.json'), result);
  return result;
}

export async function runSingleTargetJudge(
  options: JudgeRunOptions,
  backend: JudgeBackend,
  passThreshold: number | null,
  defaultConcurrency: number,
  scoreTarget: ScoreRequestFn,
  classifyTest?: TestClassifierFn,
): Promise<JudgeResult> {
  const { isUnified, candidateRubric } = resolvePartitionRubrics(options);
  if (options.rubric.target === 'project_structure' || !isUnified) {
    const startMs = performance.now();
    const { out, request, body, result } = prepareJudgeRun(options, backend, passThreshold);
    if (!options.dryRun && Object.keys(request.questions).length > 0) {
      try {
        const judged = await scoreTarget(request, body, out);
        if (judged.retries && judged.retries > 0) result.retries = judged.retries;
        result.returned_model = judged.model;
        result.quality = { pass_rate: passRate(judged.checks), checks: judged.checks };
      } catch (error) {
        result.status = 'error';
        result.error = error instanceof Error ? error.message : 'Judging failed';
      }
    }
    result.elapsed_ms = Math.round(performance.now() - startMs);
    if (out !== undefined) saveJson(join(out, 'result.json'), result);
    return result;
  }

  const prodFiles = options.files ?? {};
  const testFiles = options.testFiles ?? {};
  const totalFileCount = Object.keys(prodFiles).length + Object.keys(testFiles).length;
  if (totalFileCount === 0) throw new Error('No files to score');

  const startMs = performance.now();
  let out: string | undefined;
  if (options.out !== undefined) {
    out = resolve(options.out);
    mkdirSync(dirname(out), { recursive: true, mode: 0o700 });
    mkdirSync(out, { mode: 0o700 });
  }

  const concurrency = options.concurrency ?? defaultConcurrency;
  const outcome = await evaluateModuleBundle(
    {
      name: options.target ?? 'module',
      files: prodFiles,
      testFiles,
      requirements: options.requirements,
      conventions: options.conventions,
    },
    options,
    backend,
    concurrency,
    scoreTarget,
    classifyTest,
    out,
    undefined,
  );

  const activeCheckIds = new Set(outcome.questionIds);
  const effectiveRubric = narrowResolvedRubric(candidateRubric, activeCheckIds);
  const skippedNotApplicable = Object.keys(candidateRubric.questions).filter((id) => !activeCheckIds.has(id));
  const checkThresholds = overriddenThresholds(thresholdsToScores(effectiveRubric.thresholds), passThreshold);
  const ignoredPatterns = [...new Set(options.ignore ?? [])];

  const isError = outcome.entry.status === 'error';
  const result: JudgeResult = {
    status: options.dryRun ? 'dry_run' : isError ? 'error' : 'scored',
    backend,
    mode: 'code',
    ...(options.target ? { target: options.target } : {}),
    file_count: totalFileCount,
    elapsed_ms: Math.round(performance.now() - startMs),
    ...(outcome.retries > 0 ? { retries: outcome.retries } : {}),
    requested_model: options.model ?? null,
    returned_model: outcome.entry.returned_model,
    rubric: effectiveRubric.rubric,
    rubric_groups: effectiveRubric.groups,
    ...(effectiveRubric.excluded.length > 0 ? { excluded_checks: effectiveRubric.excluded } : {}),
    ...(ignoredPatterns.length > 0 ? { ignored_patterns: ignoredPatterns } : {}),
    ...(skippedNotApplicable.length > 0 ? { skipped_not_applicable_checks: skippedNotApplicable } : {}),
    pass_threshold: passThreshold,
    ...(checkThresholds ? { check_thresholds: checkThresholds } : {}),
    quality: options.dryRun || isError
      ? null
      : outcome.entry.checks
        ? { pass_rate: outcome.entry.pass_rate ?? passRate(outcome.entry.checks), checks: outcome.entry.checks }
        : { pass_rate: 1, checks: {} },
    ...(isError ? { error: outcome.entry.error } : {}),
  };

  if (out !== undefined) saveJson(join(out, 'result.json'), result);
  return result;
}

/** Parse an HTTP Retry-After header (delta-seconds or HTTP-date) into bounded milliseconds. */
export function parseRetryAfterMs(
  headerValue: string | null,
  nowMs: number = Date.now(),
  maxRetryAfterMs: number = DEFAULT_MAX_RETRY_AFTER_MS,
): number | null {
  if (!headerValue) return null;
  const trimmed = headerValue.trim();
  if (!trimmed) return null;
  if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
    const seconds = Number(trimmed);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(Math.round(seconds * 1000), maxRetryAfterMs);
    }
    return null;
  }
  const parsedDate = Date.parse(trimmed);
  if (Number.isFinite(parsedDate)) {
    return Math.min(Math.max(0, parsedDate - nowMs), maxRetryAfterMs);
  }
  return null;
}

function computeRetryDelayMs(
  retryIndex: number,
  retryAfterHeader: string | null,
  baseDelayMs: number,
  maxDelayMs: number,
  maxRetryAfterMs: number,
  random: () => number,
  now: () => number,
): number {
  const retryAfterMs = parseRetryAfterMs(retryAfterHeader, now(), maxRetryAfterMs);
  if (retryAfterMs !== null) return retryAfterMs;
  const exponential = Math.min(maxDelayMs, baseDelayMs * (2 ** retryIndex));
  const jitterFactor = 0.75 + random() * 0.5;
  return Math.min(maxDelayMs, Math.max(0, Math.round(exponential * jitterFactor)));
}

function extractErrorDetail(rawText: string): string | null {
  try {
    const parsed = JSON.parse(rawText) as Record<string, unknown>;
    const errObj = parsed?.error && typeof parsed.error === 'object' && !Array.isArray(parsed.error)
      ? (parsed.error as Record<string, unknown>)
      : null;
    const rawMsg = typeof errObj?.message === 'string'
      ? errObj.message
      : typeof parsed?.error === 'string'
        ? parsed.error
        : typeof parsed?.message === 'string'
          ? parsed.message
          : null;
    if (!rawMsg) return null;
    const cleaned = rawMsg.replace(/\s+/g, ' ').trim();
    if (!cleaned) return null;
    return cleaned.length > 200 ? `${cleaned.slice(0, 197)}...` : cleaned;
  } catch {
    return null;
  }
}

async function postDecisions(
  body: string,
  key: string,
  responsePath: string | undefined,
  transport: typeof fetch,
  retry: RetryOptions = {},
): Promise<{ raw: unknown; retries: number }> {
  const maxRetries = retry.maxRetries ?? DEFAULT_MAX_RETRIES;
  const baseDelayMs = retry.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const maxDelayMs = retry.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  const maxRetryAfterMs = retry.maxRetryAfterMs ?? DEFAULT_MAX_RETRY_AFTER_MS;
  const sleep = retry.sleep ?? ((ms: number) => new Promise<void>((resolveDelay) => setTimeout(resolveDelay, ms)));
  const random = retry.random ?? Math.random;
  const now = retry.now ?? Date.now;
  const onRetry = retry.onRetry ?? (({ status, attempt, maxAttempts, delayMs }) => {
    console.error(`OpenRouter returned HTTP ${status}; retrying in ${(delayMs / 1000).toFixed(1)}s (attempt ${attempt}/${maxAttempts})...`);
  });

  const maxAttempts = maxRetries + 1;
  let retries = 0;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let response: Response;
    let rawText: string;
    try {
      response = await transport(ENDPOINT, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body,
        redirect: 'error',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      rawText = await response.text();
    } catch {
      throw new Error('OpenRouter request failed or timed out');
    }
    if (rawText.includes(key)) {
      if (responsePath !== undefined) {
        writeFileSync(responsePath, rawText.replaceAll(key, '[redacted]'), { mode: 0o600 });
      }
      throw new Error('OpenRouter response contained credential material');
    }
    if (responsePath !== undefined) {
      writeFileSync(responsePath, rawText, { mode: 0o600 });
    }
    if (response.ok) {
      try {
        return { raw: JSON.parse(rawText), retries };
      } catch {
        throw new Error('OpenRouter returned invalid JSON');
      }
    }
    const detail = extractErrorDetail(rawText);
    const detailSuffix = detail ? `: ${detail}` : '';
    if (!RETRYABLE_HTTP_STATUSES.has(response.status)) {
      throw new Error(`OpenRouter returned HTTP ${response.status}${detailSuffix}`);
    }
    if (attempt === maxAttempts) {
      throw new Error(`OpenRouter returned HTTP ${response.status} after ${maxAttempts} attempts${detailSuffix}`);
    }
    const delayMs = computeRetryDelayMs(
      attempt - 1,
      response.headers.get('retry-after'),
      baseDelayMs,
      maxDelayMs,
      maxRetryAfterMs,
      random,
      now,
    );
    retries += 1;
    onRetry({ status: response.status, attempt: attempt + 1, maxAttempts, delayMs });
    await sleep(delayMs);
  }

  throw new Error('OpenRouter request failed');
}

function probability(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${label} must be a number from 0 to 1`);
  }
  return value;
}

/** Validate every required answer before producing any quality scores. */
export function readAnswers(
  raw: unknown,
  questions: Record<string, ChoiceQuestion>,
  thresholds?: Record<string, number>,
) {
  const response = object(raw, 'OpenRouter response');
  const model = nonempty(response.model, 'Returned model');
  const answers = object(response.answers, 'answers');
  const checks: Record<string, Judgment> = Object.fromEntries(Object.keys(questions).map((id) => {
    const answer = object(answers[id], `Answer ${id}`);
    if (answer.type !== 'choice' || (answer.choice !== 'pass' && answer.choice !== 'fail')) {
      throw new Error(`Answer ${id} must choose pass or fail`);
    }
    const probabilities = object(answer.probabilities, `${id}.probabilities`);
    const pass = probability(probabilities.pass, `${id}.pass`);
    const fail = probability(probabilities.fail, `${id}.fail`);
    if (Object.keys(probabilities).sort().join(',') !== 'fail,pass'
      || Math.abs(pass + fail - 1) > 0.001
      || (answer.choice === 'pass' ? pass < fail : fail < pass)) {
      throw new Error(`Answer ${id} has inconsistent probabilities`);
    }
    const rawThreshold = thresholds?.[id] ?? PASS_THRESHOLD;
    const scoreThreshold = probabilityToScore(rawThreshold);
    const choice: 'pass' | 'fail' = pass >= rawThreshold ? 'pass' : 'fail';
    const severity: FindingSeverity | undefined = choice === 'fail'
      ? (pass < ERROR_SCORE_THRESHOLD / 100 ? 'error' : 'warning')
      : undefined;
    const score = probabilityToScore(pass, [ERROR_SCORE_THRESHOLD, scoreThreshold]);
    return [id, {
      choice,
      ...(severity ? { severity } : {}),
      model_choice: answer.choice,
      score,
      ...(scoreThreshold !== DEFAULT_PASS_SCORE ? { pass_threshold: scoreThreshold } : {}),
    }];
  }));
  return { model, checks };
}

function hasAnyApplicableRequest(options: JudgeRunOptions): boolean {
  if (options.rubric.target === 'project_structure') return true;
  const { isUnified, prodRubric, testRubric } = resolvePartitionRubrics(options);
  if (!isUnified) {
    if (options.mode === 'file') {
      const files = options.files ?? {};
      return Object.entries(files).some(
        ([file, content]) => Object.keys(filterRubricForFiles(options.rubric, { [file]: content }).questions).length > 0,
      );
    }
    if (options.modules && options.modules.length > 0) {
      return options.modules.some(
        (mod) => Object.keys(filterRubricForFiles(options.rubric, mod.files).questions).length > 0,
      );
    }
    return Object.keys(filterRubricForFiles(options.rubric, options.files ?? {}).questions).length > 0;
  }

  const testFileApplicable = (file: string, content: string): boolean => {
    if (!testRubric) return false;
    if (options.explicitTestSelection) {
      return Object.keys(filterRubricForFiles(testRubric, { [file]: content }).questions).length > 0;
    }
    return Object.keys(previewTestFileRubric({ filePath: file, content }, testRubric).rubric.questions).length > 0;
  };
  const testBundleApplicable = (testFiles: Record<string, string>): boolean => {
    if (!testRubric || Object.keys(testFiles).length === 0) return false;
    if (options.explicitTestSelection) {
      return Object.keys(filterRubricForFiles(testRubric, testFiles).questions).length > 0;
    }
    return Object.keys(previewTestBundleRubric(testFiles, testRubric).questions).length > 0;
  };

  if (options.mode === 'file') {
    const prodMatch = prodRubric !== undefined && Object.entries(options.files ?? {}).some(
      ([file, content]) => Object.keys(filterRubricForFiles(prodRubric, { [file]: content }).questions).length > 0,
    );
    const testMatch = Object.entries(options.testFiles ?? {}).some(([file, content]) => testFileApplicable(file, content));
    return prodMatch || testMatch;
  }
  if (options.modules && options.modules.length > 0) {
    return options.modules.some((mod) => {
      const prodMatch = prodRubric !== undefined
        && Object.keys(mod.files).length > 0
        && Object.keys(filterRubricForFiles(prodRubric, mod.files).questions).length > 0;
      const testMatch = testBundleApplicable(mod.testFiles ?? {});
      return prodMatch || testMatch;
    });
  }
  const prodMatch = prodRubric !== undefined
    && Object.keys(options.files ?? {}).length > 0
    && Object.keys(filterRubricForFiles(prodRubric, options.files ?? {}).questions).length > 0;
  const testMatch = testBundleApplicable(options.testFiles ?? {});
  return prodMatch || testMatch;
}

/** Score a file scan, module bundle(s), or project structure manifest through OpenRouter's Decisions API. */
export async function runDecisionJudge(
  options: JudgeRunOptions,
  transport: typeof fetch = fetch,
  retry: RetryOptions = {},
): Promise<JudgeResult> {
  nonempty(options.model, 'model');
  const needsApiCall = !options.dryRun && hasAnyApplicableRequest(options);
  const key = needsApiCall ? process.env.OPENROUTER_API_KEY?.trim() ?? '' : '';
  if (needsApiCall && !key) {
    throw new Error('Set OPENROUTER_API_KEY before judging (or pass --backend codex / --backend claude)');
  }

  const { candidateRubric } = resolvePartitionRubrics(options);
  const scoreOpenRouter: ScoreRequestFn = async (request, body, artifactDir) => {
    const responsePath = artifactDir !== undefined ? join(artifactDir, 'response.txt') : undefined;
    const { raw, retries } = await postDecisions(body, key, responsePath, transport, retry);
    const judged = readAnswers(raw, request.questions, candidateRubric.thresholds);
    return { ...judged, retries };
  };
  const classifyOpenRouter: TestClassifierFn = (filePath, content) =>
    classifyTestFile({
      filePath,
      content,
      invokeOpenRouter: (body) => postDecisions(body, key, undefined, transport, retry),
    });

  if (options.mode === 'file') {
    return runPerFileJudge(
      options,
      'openrouter',
      DEFAULT_PASS_SCORE,
      DEFAULT_OPENROUTER_CONCURRENCY,
      scoreOpenRouter,
      classifyOpenRouter,
    );
  }

  if (options.modules && options.modules.length > 0) {
    return runMultiModuleJudge(
      options,
      'openrouter',
      DEFAULT_PASS_SCORE,
      DEFAULT_OPENROUTER_CONCURRENCY,
      scoreOpenRouter,
      classifyOpenRouter,
    );
  }

  return runSingleTargetJudge(
    options,
    'openrouter',
    DEFAULT_PASS_SCORE,
    DEFAULT_OPENROUTER_CONCURRENCY,
    scoreOpenRouter,
    classifyOpenRouter,
  );
}
