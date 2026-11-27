import { join } from 'node:path';
import { findingSeverity } from '../engine/scoring.mts';
import type { FindingSeverity, JudgeResult, Judgment } from '../engine/types.mts';
import {
  checkThreshold,
  formatElapsed,
  formatRuleBreakdown,
  formatRuleCriteria,
  formatScore,
  formatThreshold,
  pluralize,
  type RubricCriteriaInfo,
  type RuleStat,
} from './format-summary.mts';

export interface FormatLinterOptions {
  quiet?: boolean;
  outDir?: string;
  conventionsLabel?: string;
  rubric?: RubricCriteriaInfo;
}

interface TargetFinding {
  id: string;
  severity: FindingSeverity;
  check: Judgment;
  threshold: number | null;
}

interface TargetBlock {
  label: string;
  findings: TargetFinding[];
  errorCount: number;
  warningCount: number;
  minScore: number;
}

interface NormalizedTargetEntry {
  label: string;
  status: string;
  checks: Record<string, Judgment> | null;
  error?: string;
}

const PREVIEW_LIMIT = 20;

function formatFindingDetail(finding: TargetFinding): string {
  const { check, severity, threshold } = finding;
  if (typeof check.score === 'number') {
    const score = formatScore(check.score, threshold);
    return typeof threshold === 'number'
      ? `(score ${score}/100, pass >= ${formatThreshold(threshold)})`
      : `(score ${score}/100)`;
  }
  if (check.note) return `(${check.note})`;
  return severity === 'warning' ? '(borderline)' : '(fail)';
}

function extractTargetFindings(
  result: JudgeResult,
  checks: Record<string, Judgment> | null | undefined,
  quiet: boolean,
): TargetFinding[] {
  if (!checks) return [];
  const findings: TargetFinding[] = [];
  for (const [id, check] of Object.entries(checks)) {
    const severity = findingSeverity(check);
    if (!severity || (quiet && severity === 'warning')) continue;
    findings.push({ id, severity, check, threshold: checkThreshold(result, id, check) });
  }
  findings.sort((a, b) => {
    const sevDiff = Number(b.severity === 'error') - Number(a.severity === 'error');
    if (sevDiff !== 0) return sevDiff;
    const scoreDiff = (a.check.score ?? 0) - (b.check.score ?? 0);
    return scoreDiff !== 0 ? scoreDiff : a.id.localeCompare(b.id);
  });
  return findings;
}

function buildTargetBlock(label: string, findings: TargetFinding[]): TargetBlock {
  let errorCount = 0;
  let warningCount = 0;
  const scores: number[] = [];
  for (const finding of findings) {
    if (finding.severity === 'error') errorCount += 1;
    else warningCount += 1;
    if (typeof finding.check.score === 'number') scores.push(finding.check.score);
  }
  return { label, findings, errorCount, warningCount, minScore: scores.length > 0 ? Math.min(...scores) : 0 };
}

function sortTargetBlocks(blocks: readonly TargetBlock[]): TargetBlock[] {
  return [...blocks].sort((a, b) => {
    if (b.errorCount !== a.errorCount) return b.errorCount - a.errorCount;
    if (b.warningCount !== a.warningCount) return b.warningCount - a.warningCount;
    if (a.minScore !== b.minScore) return a.minScore - b.minScore;
    return a.label.localeCompare(b.label);
  });
}

function renderTargetBlocks(blocks: readonly TargetBlock[]): string[] {
  const lines: string[] = [];
  const maxRuleLen = blocks.length > 0
    ? Math.max(...blocks.flatMap((block) => block.findings.map((finding) => finding.id.length)), 24)
    : 24;
  for (let i = 0; i < blocks.length; i += 1) {
    const block = blocks[i];
    if (i > 0) lines.push('');
    lines.push(block.label);
    for (const finding of block.findings) {
      lines.push(`  ${finding.severity.padEnd(7)}  ${finding.id.padEnd(maxRuleLen)}  ${formatFindingDetail(finding)}`);
    }
  }
  return lines;
}

function collectRuleStats(blocks: readonly TargetBlock[]): RuleStat[] {
  const byRule = new Map<string, RuleStat>();
  for (const block of blocks) {
    for (const finding of block.findings) {
      let stat = byRule.get(finding.id);
      if (!stat) {
        stat = { id: finding.id, errors: 0, warnings: 0, minScore: Number.POSITIVE_INFINITY };
        byRule.set(finding.id, stat);
      }
      if (finding.severity === 'error') stat.errors += 1;
      else stat.warnings += 1;
      if (typeof finding.check.score === 'number') {
        stat.minScore = Math.min(stat.minScore, finding.check.score);
      }
    }
  }
  return [...byRule.values()].sort((a, b) => {
    if (b.errors !== a.errors) return b.errors - a.errors;
    if (b.warnings !== a.warnings) return b.warnings - a.warnings;
    const scoreDiff = (Number.isFinite(a.minScore) ? a.minScore : 0) - (Number.isFinite(b.minScore) ? b.minScore : 0);
    return scoreDiff !== 0 ? scoreDiff : a.id.localeCompare(b.id);
  });
}

function formatPreviewList(items: readonly string[], limit = PREVIEW_LIMIT): string {
  const preview = items.slice(0, limit).join(', ');
  const suffix = items.length > limit ? `, ... (+${items.length - limit} more)` : '';
  return `${preview}${suffix}`;
}

function formatDryRunScopeLabel(result: JudgeResult): string {
  if (result.module_results) {
    const skippedCount = result.module_results.filter((mod) => mod.status === 'skipped').length;
    const activeCount = result.module_results.length - skippedCount;
    return skippedCount > 0
      ? `${activeCount} applicable of ${pluralize(result.module_results.length, 'module')} (${skippedCount} skipped: not applicable; ${pluralize(result.file_count, 'file')})`
      : `${pluralize(result.module_results.length, 'module')} (${pluralize(result.file_count, 'file')})`;
  }
  const skippedFiles = result.file_results?.filter((file) => file.status === 'skipped').length ?? 0;
  if (skippedFiles > 0) {
    const activeFiles = (result.file_results?.length ?? 0) - skippedFiles;
    return `${activeFiles} applicable of ${pluralize(result.file_count, 'file')} (${skippedFiles} skipped: not applicable)`;
  }
  return pluralize(result.file_count, 'file');
}

function formatDryRunTargetLines(result: JudgeResult, totalChecks: number): string[] {
  const lines: string[] = [];
  if (result.file_results?.length) {
    const active = result.file_results.filter((file) => file.status !== 'skipped');
    const skipped = result.file_results.filter((file) => file.status === 'skipped');
    if (active.length > 0) {
      const formatted = active.map((file) => {
        const roleNote = file.file_role ? ` [${file.file_role}]` : '';
        const checkNote = file.applicable_checks ? ` (${file.applicable_checks.length}/${totalChecks})` : '';
        return `${file.file}${roleNote}${checkNote}`;
      });
      lines.push(`Files (${active.length}): ${formatPreviewList(formatted)}`);
    }
    if (skipped.length > 0) {
      lines.push(`Skipped files (not applicable, ${skipped.length}): ${formatPreviewList(skipped.map((file) => file.file))}`);
    }
    return lines;
  }
  if (result.module_results?.length) {
    const active = result.module_results.filter((mod) => mod.status !== 'skipped');
    const skipped = result.module_results.filter((mod) => mod.status === 'skipped');
    if (active.length > 0) lines.push(`Modules (${active.length}): ${active.map((mod) => mod.module).join(', ')}`);
    if (skipped.length > 0) lines.push(`Skipped modules (not applicable, ${skipped.length}): ${skipped.map((mod) => mod.module).join(', ')}`);
    return lines;
  }
  return result.target ? [`Target: ${result.target}`] : [];
}

function formatDryRunOutput(result: JudgeResult, options: FormatLinterOptions, modelLabel: string): string {
  const modeTag = result.mode === 'code' ? 'module' : result.mode;
  const checks = Object.values(result.rubric_groups).flat();
  const checkLabels = checks.map((id) => {
    const threshold = checkThreshold(result, id);
    const hasCustomThreshold = typeof threshold === 'number'
      && result.pass_threshold !== null
      && threshold !== result.pass_threshold;
    return hasCustomThreshold ? `${id} (>=${formatThreshold(threshold)})` : id;
  });

  const lines = [
    `DRY RUN (${modeTag}): ${formatDryRunScopeLabel(result)}, ${pluralize(checks.length, 'check')} [${result.backend}: ${modelLabel}]`,
    `Checks (${checks.length}): ${checkLabels.length > 0 ? checkLabels.join(', ') : '(none applicable)'}`,
    ...formatDryRunTargetLines(result, checks.length),
  ];
  if (options.conventionsLabel) lines.push(`Conventions: ${options.conventionsLabel}`);
  if (result.skipped_module_checks?.length) {
    lines.push(`Skipped module checks (${result.skipped_module_checks.length}): ${result.skipped_module_checks.join(', ')}`);
  }
  if (result.skipped_not_applicable_checks?.length) {
    lines.push(`Skipped non-applicable checks (${result.skipped_not_applicable_checks.length}): ${result.skipped_not_applicable_checks.join(', ')}`);
  }
  if (result.ignored_patterns?.length) {
    lines.push(`Ignored patterns (${result.ignored_patterns.length}): ${result.ignored_patterns.join(', ')}`);
  }
  if (options.outDir !== undefined) lines.push(`Artifacts: ${join(options.outDir, 'result.json')}`);
  return lines.join('\n');
}

function extractTargetCollection(result: JudgeResult): {
  heading: 'Files' | 'Modules';
  totalCount: number;
  entries: NormalizedTargetEntry[];
} | null {
  if (result.file_results) {
    return {
      heading: 'Files',
      totalCount: result.file_count,
      entries: result.file_results.map((entry) => ({
        label: entry.file,
        status: entry.status,
        checks: entry.checks,
        error: entry.error,
      })),
    };
  }
  if (result.module_results) {
    return {
      heading: 'Modules',
      totalCount: result.module_results.length,
      entries: result.module_results.map((entry) => ({
        label: entry.module,
        status: entry.status,
        checks: entry.checks,
        error: entry.error,
      })),
    };
  }
  return null;
}

function formatErrorOutput(result: JudgeResult, options: FormatLinterOptions): string {
  const lines = [`ERROR: ${result.error ?? 'Judging failed'}`];
  const collection = extractTargetCollection(result);
  if (collection) {
    const errored = collection.entries.filter((entry) => entry.status === 'error');
    const scored = collection.entries.filter((entry) => entry.status === 'scored');
    lines.push(`${collection.heading}: ${scored.length} scored, ${errored.length} errored (${collection.totalCount} total) in ${formatElapsed(result.elapsed_ms)}`);
    for (const entry of errored) {
      lines.push(`  error  ${entry.label}: ${entry.error ?? 'failed'}`);
    }
  }
  if (options.outDir !== undefined) lines.push(`Artifacts: ${join(options.outDir, 'result.json')}`);
  return lines.join('\n');
}

function isSingleModuleNotApplicable(result: JudgeResult): boolean {
  return !result.file_results
    && !result.module_results
    && result.mode === 'code'
    && Object.keys(result.rubric_groups).length === 0
    && (result.skipped_not_applicable_checks?.length ?? 0) > 0;
}

function formatCollectionScopeText(params: {
  noun: 'file' | 'module';
  totalTargets: number;
  skippedCount: number;
  blocksWithFindings: number;
  hasVisibleFindings: boolean;
}): string {
  const { noun, totalTargets, skippedCount, blocksWithFindings, hasVisibleFindings } = params;
  if (skippedCount > 0) {
    const applicableCount = totalTargets - skippedCount;
    return hasVisibleFindings
      ? `${blocksWithFindings} of ${pluralize(applicableCount, `applicable ${noun}`)} (${skippedCount} skipped)`
      : `${pluralize(applicableCount, `applicable ${noun}`)} (${skippedCount} skipped: not applicable)`;
  }
  return hasVisibleFindings
    ? `${blocksWithFindings} of ${pluralize(totalTargets, noun)}`
    : pluralize(totalTargets, noun);
}

function buildScoredTargetsAndScope(result: JudgeResult, quiet: boolean): {
  blocks: TargetBlock[];
  formatScope: (hasVisibleFindings: boolean) => string;
} {
  const collection = extractTargetCollection(result);
  if (collection && (result.mode === 'file' || result.module_results)) {
    const noun: 'file' | 'module' = collection.heading === 'Files' ? 'file' : 'module';
    const blocks = collection.entries
      .map((entry) => buildTargetBlock(entry.label, extractTargetFindings(result, entry.checks, quiet)))
      .filter((block) => block.findings.length > 0);
    const skippedCount = collection.entries.filter((entry) => entry.status === 'skipped').length;
    return {
      blocks,
      formatScope: (hasVisibleFindings) => formatCollectionScopeText({
        noun,
        totalTargets: collection.entries.length,
        skippedCount,
        blocksWithFindings: blocks.length,
        hasVisibleFindings,
      }),
    };
  }

  const findings = extractTargetFindings(result, result.quality?.checks, quiet);
  const label = result.target ?? (result.mode === 'structure' ? 'structure' : 'module');
  const blocks = findings.length > 0 ? [buildTargetBlock(label, findings)] : [];
  const scopeText = result.mode === 'structure'
    ? `structure (${pluralize(result.file_count, 'file')})`
    : isSingleModuleNotApplicable(result)
      ? `0 applicable modules (1 skipped: not applicable; ${pluralize(result.file_count, 'file')})`
      : `1 module (${pluralize(result.file_count, 'file')})`;
  return { blocks, formatScope: () => scopeText };
}

function formatSummaryLine(params: {
  blocks: readonly TargetBlock[];
  quiet: boolean;
  result: JudgeResult;
  modelLabel: string;
  formatScope: (hasVisibleFindings: boolean) => string;
}): string {
  const visibleErrors = params.blocks.reduce((sum, block) => sum + block.errorCount, 0);
  const visibleWarnings = params.blocks.reduce((sum, block) => sum + block.warningCount, 0);
  const hasVisibleFindings = visibleErrors > 0 || visibleWarnings > 0;
  const icon = hasVisibleFindings ? '✖' : '✓';
  const countsText = params.quiet
    ? pluralize(visibleErrors, 'error')
    : `${pluralize(visibleErrors, 'error')}, ${pluralize(visibleWarnings, 'warning')}`;
  const metaParts = [params.modelLabel];
  if (params.result.elapsed_ms !== undefined) metaParts.push(formatElapsed(params.result.elapsed_ms));
  if (params.result.retries) metaParts.push(`${params.result.retries} retries`);
  return `${icon} ${countsText} across ${params.formatScope(hasVisibleFindings)} (${metaParts.join(', ')})`;
}

function formatScoredOutput(result: JudgeResult, options: FormatLinterOptions, modelLabel: string): string {
  const quiet = options.quiet ?? false;
  const { blocks, formatScope } = buildScoredTargetsAndScope(result, quiet);
  const sortedBlocks = sortTargetBlocks(blocks);
  const lines = renderTargetBlocks(sortedBlocks);

  const ruleStats = collectRuleStats(sortedBlocks);
  const ruleLines = formatRuleBreakdown(ruleStats);
  if (ruleLines.length > 0) lines.push('', ...ruleLines);

  const criteriaLines = formatRuleCriteria(ruleStats, result, options.rubric);
  if (criteriaLines.length > 0) lines.push('', ...criteriaLines);

  if (lines.length > 0) lines.push('');
  lines.push(formatSummaryLine({ blocks: sortedBlocks, quiet, result, modelLabel, formatScope }));
  if (options.outDir !== undefined) lines.push(`Artifacts: ${join(options.outDir, 'result.json')}`);
  return lines.join('\n');
}

const STATUS_FORMATTERS: Record<
  JudgeResult['status'],
  (result: JudgeResult, options: FormatLinterOptions, modelLabel: string) => string
> = {
  dry_run: formatDryRunOutput,
  error: (result, options) => formatErrorOutput(result, options),
  scored: formatScoredOutput,
};

/**
 * Render ESLint-style linter punch-list output for stdout.
 * Lists only files/modules with findings sorted worst-first (errors, warnings, min score),
 * followed by a compact rule breakdown, a Rule criteria legend for triggered rules, and a final summary line.
 */
export function formatLinterOutput(result: JudgeResult, options: FormatLinterOptions = {}): string {
  const modelLabel = result.returned_model ?? result.requested_model ?? result.backend;
  return STATUS_FORMATTERS[result.status](result, options, modelLabel);
}
