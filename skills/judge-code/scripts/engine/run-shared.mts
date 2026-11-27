import { MAX_INPUT_BYTES } from '../inputs/files.mts';
import { narrowResolvedRubric } from '../rubrics/applicability.mts';
import { mergeResolvedRubrics } from '../rubrics/resolver.mts';
import { CONVENTIONS_CHECK_ID, type JudgeMode, type ResolvedRubric } from '../rubrics/types.mts';
import { aggregatePerFile, overriddenThresholds, passRate, thresholdsToScores } from './scoring.mts';
import type { JudgeResult, JudgeRunOptions, JudgeRunnerContext, Judgment } from './types.mts';

export interface PartitionRubrics {
  isUnified: boolean;
  prodRubric?: ResolvedRubric;
  testRubric?: ResolvedRubric;
  candidateRubric: ResolvedRubric;
}

export interface ResultEnvelopeParams {
  mode: JudgeMode;
  status: JudgeResult['status'];
  target?: string;
  fileCount: number;
  elapsedMs?: number;
  retries?: number;
  returnedModel: string | null;
  effectiveRubric: ResolvedRubric;
  skippedNotApplicable: string[];
  includeSkippedModuleChecks?: boolean;
  options: JudgeRunOptions;
  ctx: Pick<JudgeRunnerContext, 'backend' | 'passThreshold'>;
  quality: JudgeResult['quality'];
  error?: string;
}

export interface BatchOutcomeEntry {
  status: 'scored' | 'dry_run' | 'skipped' | 'error';
  skip_reason?: 'not_applicable';
  returned_model: string | null;
  elapsed_ms: number;
  pass_rate: number | null;
  checks: Record<string, Judgment> | null;
  error?: string;
  applicable_checks?: string[];
}

export function elapsedSince(startMs: number): number {
  return Math.round(performance.now() - startMs);
}

export function makeNonScoredEntry<TBase extends object>(
  baseFields: TBase,
  status: 'dry_run' | 'skipped' | 'error',
  startMs: number,
  extra?: { skip_reason?: 'not_applicable'; error?: string },
): TBase & BatchOutcomeEntry {
  return {
    ...baseFields,
    status,
    ...extra,
    returned_model: null,
    elapsed_ms: elapsedSince(startMs),
    pass_rate: null,
    checks: null,
  };
}

export async function runDryOrScoredEntry<TBase extends object>(params: {
  baseFields: TBase;
  dryRun: boolean;
  startMs: number;
  onDryRun?: () => void;
  score: () => Promise<{ returnedModel: string | null; checks: Record<string, Judgment>; retries: number }>;
}): Promise<{ entry: TBase & BatchOutcomeEntry; retries: number }> {
  if (params.dryRun) {
    params.onDryRun?.();
    return { entry: makeNonScoredEntry(params.baseFields, 'dry_run', params.startMs), retries: 0 };
  }
  try {
    const scored = await params.score();
    return {
      entry: {
        ...params.baseFields,
        status: 'scored',
        returned_model: scored.returnedModel,
        elapsed_ms: elapsedSince(params.startMs),
        pass_rate: passRate(scored.checks),
        checks: scored.checks,
      },
      retries: scored.retries,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Judging failed';
    return { entry: makeNonScoredEntry(params.baseFields, 'error', params.startMs, { error: message }), retries: 0 };
  }
}

export function resolvePartitionRubrics(options: JudgeRunOptions): PartitionRubrics {
  const isUnified = options.testFiles !== undefined || options.testRubric !== undefined;
  const prodRubric = options.rubric.target === 'production_code' ? options.rubric : undefined;
  const testRubric = options.testRubric ?? (options.rubric.target === 'test_code' ? options.rubric : undefined);
  const parts = [prodRubric, testRubric].filter((rubric): rubric is ResolvedRubric => rubric !== undefined);
  const candidateRubric = parts.length > 0 ? mergeResolvedRubrics(parts) : options.rubric;
  return { isUnified, prodRubric, testRubric, candidateRubric };
}

export function emptyResolvedRubric(base: ResolvedRubric): ResolvedRubric {
  return narrowResolvedRubric(base, new Set());
}

export function withoutConventionsCheck(rubric: ResolvedRubric): ResolvedRubric {
  if (!(CONVENTIONS_CHECK_ID in rubric.questions)) return rubric;
  const keep = new Set(Object.keys(rubric.questions).filter((id) => id !== CONVENTIONS_CHECK_ID));
  return narrowResolvedRubric(rubric, keep);
}

function utf8BytesOfFiles(files: Record<string, string>): number {
  let bytes = 0;
  for (const content of Object.values(files)) bytes += Buffer.byteLength(content, 'utf8');
  return bytes;
}

export function fitsProductionContext(params: {
  testFiles: Record<string, string>;
  prodFiles: Record<string, string>;
  requirements?: string;
  conventions?: string;
}): boolean {
  if (Object.keys(params.prodFiles).length === 0) return false;
  let total = utf8BytesOfFiles(params.testFiles) + utf8BytesOfFiles(params.prodFiles);
  if (params.requirements !== undefined) total += Buffer.byteLength(params.requirements, 'utf8');
  if (params.conventions !== undefined) total += Buffer.byteLength(params.conventions, 'utf8');
  return total <= MAX_INPUT_BYTES;
}

export function narrowAndDiffRubric(candidateRubric: ResolvedRubric, activeCheckIds: ReadonlySet<string>): {
  effectiveRubric: ResolvedRubric;
  skippedNotApplicable: string[];
  activeQuestionIds: string[];
} {
  const effectiveRubric = narrowResolvedRubric(candidateRubric, activeCheckIds);
  const skippedNotApplicable = Object.keys(candidateRubric.questions).filter((id) => !activeCheckIds.has(id));
  return {
    effectiveRubric,
    skippedNotApplicable,
    activeQuestionIds: Object.keys(effectiveRubric.questions),
  };
}

export function buildJudgeResultEnvelope(params: ResultEnvelopeParams): JudgeResult {
  const { effectiveRubric, options, ctx } = params;
  const checkThresholds = overriddenThresholds(thresholdsToScores(effectiveRubric.thresholds), ctx.passThreshold);
  const ignoredPatterns = [...new Set(options.ignore ?? [])];

  return {
    status: params.status,
    backend: ctx.backend,
    mode: params.mode,
    ...(params.target ? { target: params.target } : {}),
    file_count: params.fileCount,
    ...(params.elapsedMs !== undefined ? { elapsed_ms: params.elapsedMs } : {}),
    ...(params.retries && params.retries > 0 ? { retries: params.retries } : {}),
    requested_model: options.model ?? null,
    returned_model: params.returnedModel,
    rubric: effectiveRubric.rubric,
    rubric_groups: effectiveRubric.groups,
    ...(effectiveRubric.excluded.length > 0 ? { excluded_checks: effectiveRubric.excluded } : {}),
    ...(ignoredPatterns.length > 0 ? { ignored_patterns: ignoredPatterns } : {}),
    ...(params.includeSkippedModuleChecks && effectiveRubric.skippedModuleChecks.length > 0
      ? { skipped_module_checks: effectiveRubric.skippedModuleChecks }
      : {}),
    ...(params.skippedNotApplicable.length > 0
      ? { skipped_not_applicable_checks: params.skippedNotApplicable }
      : {}),
    pass_threshold: ctx.passThreshold,
    ...(checkThresholds ? { check_thresholds: checkThresholds } : {}),
    quality: params.quality,
    ...(params.error !== undefined ? { error: params.error } : {}),
  };
}

export function finalizeBatchResult<TEntry extends BatchOutcomeEntry>(params: {
  outcomes: readonly { entry: TEntry; questionIds: string[]; retries: number }[];
  candidateRubric: ResolvedRubric;
  mode: JudgeMode;
  fileCount: number;
  elapsedMs: number;
  includeSkippedModuleChecks?: boolean;
  noun: 'file' | 'module';
  entryLabel: (entry: TEntry) => string;
  options: JudgeRunOptions;
  ctx: JudgeRunnerContext;
}): { baseResult: JudgeResult; entries: TEntry[] } {
  const activeCheckIds = new Set(params.outcomes.flatMap((outcome) => outcome.questionIds));
  const { effectiveRubric, skippedNotApplicable, activeQuestionIds } = narrowAndDiffRubric(
    params.candidateRubric,
    activeCheckIds,
  );
  const entries = params.outcomes.map(({ entry, questionIds }) => (
    questionIds.length > 0 && questionIds.length < activeQuestionIds.length
      ? { ...entry, applicable_checks: questionIds }
      : entry
  ));

  const errored = entries.filter((entry) => entry.status === 'error');
  const models = [...new Set(entries.map((entry) => entry.returned_model).filter((m): m is string => Boolean(m)))];
  const scoreThresholds = params.ctx.passThreshold !== null
    ? thresholdsToScores(effectiveRubric.thresholds)
    : undefined;

  const baseResult = buildJudgeResultEnvelope({
    mode: params.mode,
    status: params.options.dryRun ? 'dry_run' : errored.length > 0 ? 'error' : 'scored',
    fileCount: params.fileCount,
    elapsedMs: params.elapsedMs,
    retries: params.outcomes.reduce((sum, outcome) => sum + outcome.retries, 0),
    returnedModel: models.join(', ') || null,
    effectiveRubric,
    skippedNotApplicable,
    includeSkippedModuleChecks: params.includeSkippedModuleChecks,
    options: params.options,
    ctx: params.ctx,
    quality: !params.options.dryRun && errored.length === 0
      ? aggregatePerFile(entries, activeQuestionIds, scoreThresholds)
      : null,
    error: errored.length > 0
      ? `${errored.length} of ${entries.length} ${params.noun}(s) failed: ${params.entryLabel(errored[0])}: ${errored[0].error}`
      : undefined,
  });

  return { baseResult, entries };
}
