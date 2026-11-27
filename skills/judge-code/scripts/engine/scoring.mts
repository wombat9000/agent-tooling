import {
  DEFAULT_PASS_SCORE,
  ERROR_SCORE_THRESHOLD,
  type FindingSeverity,
  type JudgeResult,
  type Judgment,
} from './types.mts';

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

export function normalizeThresholdToScore(rawThreshold: number | undefined): number {
  if (rawThreshold === undefined) return DEFAULT_PASS_SCORE;
  return rawThreshold > 0 && rawThreshold <= 1 ? probabilityToScore(rawThreshold) : rawThreshold;
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
  if (check.model_choice === 'borderline') return 'warning';
  return 'error';
}

function collectScoredCheckMaps(result: JudgeResult): Array<Record<string, Judgment>> {
  const entries = result.file_results ?? result.module_results;
  if (entries) {
    return entries
      .filter((entry) => entry.status === 'scored' && entry.checks !== null)
      .map((entry) => entry.checks!);
  }
  if (result.status === 'scored' && result.quality) {
    return [result.quality.checks];
  }
  return [];
}

/** Count total error and warning findings across a JudgeResult. */
export function countResultFindings(result: JudgeResult): { errors: number; warnings: number } {
  let errors = 0;
  let warnings = 0;
  for (const checks of collectScoredCheckMaps(result)) {
    for (const check of Object.values(checks)) {
      const severity = findingSeverity(check);
      if (severity === 'error') errors += 1;
      else if (severity === 'warning') warnings += 1;
    }
  }
  return { errors, warnings };
}

export function numbered(files: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(files).map(([path, text]) => [
      path,
      text.split(/\r?\n/).map((line, index) => `${index + 1}: ${line}`).join('\n'),
    ]),
  );
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

export function overriddenThresholds(
  thresholds: Record<string, number>,
  defaultThreshold: number | null,
): Record<string, number> | undefined {
  if (defaultThreshold === null) return undefined;
  const overrides = Object.entries(thresholds).filter(([, threshold]) => threshold !== defaultThreshold);
  return overrides.length > 0 ? Object.fromEntries(overrides) : undefined;
}

function summarizeCheckAcrossTargets(
  perTarget: readonly Judgment[],
  rawThreshold: number | undefined,
): Judgment {
  const targetCount = perTarget.length;
  const passed = perTarget.filter((check) => check.choice === 'pass').length;
  const errors = perTarget.filter((check) => findingSeverity(check) === 'error').length;
  const warnings = perTarget.filter((check) => findingSeverity(check) === 'warning').length;
  const hasScores = perTarget.every((check) => typeof check.score === 'number');
  const meanScore = hasScores
    ? Number((perTarget.reduce((sum, check) => sum + check.score!, 0) / targetCount).toFixed(1))
    : null;
  const minScore = hasScores ? Math.min(...perTarget.map((check) => check.score!)) : null;
  const scoreThreshold = rawThreshold !== undefined ? normalizeThresholdToScore(rawThreshold) : undefined;
  const choice: 'pass' | 'fail' = passed === targetCount ? 'pass' : 'fail';
  const severity: FindingSeverity | undefined = choice === 'fail'
    ? (errors > 0 ? 'error' : 'warning')
    : undefined;

  return {
    choice,
    ...(severity ? { severity } : {}),
    files_passed: passed,
    files_total: targetCount,
    ...(errors > 0 ? { files_errors: errors } : {}),
    ...(warnings > 0 ? { files_warnings: warnings } : {}),
    score: meanScore,
    min_score: minScore,
    ...(scoreThreshold !== undefined && scoreThreshold !== DEFAULT_PASS_SCORE
      ? { pass_threshold: scoreThreshold }
      : {}),
  };
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
      .filter((check): check is Judgment => check !== undefined);
    if (perTarget.length > 0) {
      checks[id] = summarizeCheckAcrossTargets(perTarget, thresholds?.[id]);
    }
  }

  const evaluatedCount = Object.keys(checks).length;
  const meanTargetPassRate = scoredTargets.reduce((sum, entry) => sum + (entry.pass_rate ?? 0), 0) / scoredTargets.length;
  const allTargetsPassRate = evaluatedCount > 0
    ? Object.values(checks).filter((check) => check.choice === 'pass').length / evaluatedCount
    : 1;
  return { pass_rate: meanTargetPassRate, all_files_pass_rate: allTargetsPassRate, checks };
}
