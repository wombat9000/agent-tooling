import { join } from 'node:path';
import {
  findingSeverity,
  type FindingSeverity,
  type JudgeResult,
  type Judgment,
} from './decisions.mts';
import {
  PASS_THRESHOLD,
  formatApplicability,
  type BundledRubricSummary,
  type CheckScope,
  type ChoiceQuestion,
  type RuleDefinition,
} from './rubrics.mts';

export interface RubricCriteriaInfo {
  questions: Record<string, ChoiceQuestion>;
  scopes?: Record<string, CheckScope>;
  thresholds?: Record<string, number>;
  groups?: Record<string, string[]>;
}

export interface FormatLinterOptions {
  quiet?: boolean;
  outDir?: string;
  conventionsLabel?: string;
  rubric?: RubricCriteriaInfo;
}

export interface FormatRubricListOptions {
  verbose?: boolean;
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
  minProb: number;
}

interface RuleStat {
  id: string;
  errors: number;
  warnings: number;
  minProb: number;
}

function formatElapsed(ms: number | undefined): string {
  if (ms === undefined) return 'n/a';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

export function formatThreshold(value: number): string {
  const fixed2 = value.toFixed(2);
  if (Math.abs(Number(fixed2) - value) < 1e-9) return fixed2;
  return String(Number(value.toFixed(4)));
}

function checkThreshold(result: JudgeResult, id: string, check?: Judgment): number | null {
  return check?.pass_threshold ?? result.check_thresholds?.[id] ?? result.pass_threshold;
}

function formatProb(value: number | null | undefined, threshold?: number | null): string {
  if (typeof value !== 'number') return 'n/a';
  const rounded = value.toFixed(2);
  if (typeof threshold === 'number' && value < threshold && Number(rounded) >= threshold) {
    return (Math.floor(value * 1000) / 1000).toFixed(3);
  }
  return rounded;
}

function formatFindingDetail(finding: TargetFinding): string {
  const { check, severity, threshold } = finding;
  if (typeof check.pass_probability === 'number') {
    const prob = formatProb(check.pass_probability, threshold);
    if (severity === 'warning' && typeof threshold === 'number') {
      return `(${prob} < ${formatThreshold(threshold)})`;
    }
    return `(${prob})`;
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
    if (!severity) continue;
    if (quiet && severity === 'warning') continue;
    findings.push({
      id,
      severity,
      check,
      threshold: checkThreshold(result, id, check),
    });
  }
  findings.sort((a, b) => {
    const sevDiff = Number(b.severity === 'error') - Number(a.severity === 'error');
    if (sevDiff !== 0) return sevDiff;
    const pa = a.check.pass_probability ?? 0;
    const pb = b.check.pass_probability ?? 0;
    if (pa !== pb) return pa - pb;
    return a.id.localeCompare(b.id);
  });
  return findings;
}

function buildTargetBlock(label: string, findings: TargetFinding[]): TargetBlock {
  let errorCount = 0;
  let warningCount = 0;
  const probs: number[] = [];
  for (const f of findings) {
    if (f.severity === 'error') errorCount += 1;
    else warningCount += 1;
    if (typeof f.check.pass_probability === 'number') probs.push(f.check.pass_probability);
  }
  return {
    label,
    findings,
    errorCount,
    warningCount,
    minProb: probs.length > 0 ? Math.min(...probs) : 0,
  };
}

function collectRuleStats(blocks: TargetBlock[]): RuleStat[] {
  const byRule = new Map<string, RuleStat>();
  for (const block of blocks) {
    for (const f of block.findings) {
      let stat = byRule.get(f.id);
      if (!stat) {
        stat = { id: f.id, errors: 0, warnings: 0, minProb: Number.POSITIVE_INFINITY };
        byRule.set(f.id, stat);
      }
      if (f.severity === 'error') stat.errors += 1;
      else stat.warnings += 1;
      if (typeof f.check.pass_probability === 'number') {
        stat.minProb = Math.min(stat.minProb, f.check.pass_probability);
      }
    }
  }
  return [...byRule.values()].sort((a, b) => {
    if (b.errors !== a.errors) return b.errors - a.errors;
    if (b.warnings !== a.warnings) return b.warnings - a.warnings;
    const pa = Number.isFinite(a.minProb) ? a.minProb : 0;
    const pb = Number.isFinite(b.minProb) ? b.minProb : 0;
    if (pa !== pb) return pa - pb;
    return a.id.localeCompare(b.id);
  });
}

function formatRuleBreakdown(sorted: RuleStat[]): string[] {
  if (sorted.length === 0) return [];
  const maxIdLen = Math.max(...sorted.map((r) => r.id.length), 24);
  const lines = ['Rules:'];
  for (const rule of sorted) {
    const parts: string[] = [];
    if (rule.errors > 0) parts.push(pluralize(rule.errors, 'error'));
    if (rule.warnings > 0) parts.push(pluralize(rule.warnings, 'warning'));
    lines.push(`  ${rule.id.padEnd(maxIdLen)}  ${parts.join(', ')}`);
  }
  return lines;
}

function findRuleGroup(
  id: string,
  groups: Record<string, string[]> | undefined,
): string | undefined {
  if (!groups) return undefined;
  for (const [group, ids] of Object.entries(groups)) {
    if (ids.includes(id)) return group;
  }
  return undefined;
}

function formatRuleCriteria(
  sorted: RuleStat[],
  result: JudgeResult,
  rubric: RubricCriteriaInfo | undefined,
): string[] {
  if (sorted.length === 0 || !rubric) return [];
  const groups = rubric.groups ?? result.rubric_groups;
  const lines: string[] = [];
  for (const rule of sorted) {
    const question = rubric.questions[rule.id];
    if (!question) continue;
    const group = findRuleGroup(rule.id, groups);
    const scope = rubric.scopes?.[rule.id];
    const threshold = rubric.thresholds?.[rule.id] ?? checkThreshold(result, rule.id);
    const meta: string[] = [];
    if (group) meta.push(group);
    if (scope) meta.push(scope);
    if (typeof threshold === 'number') meta.push(`>=${formatThreshold(threshold)}`);
    const header = meta.length > 0 ? `  ${rule.id} (${meta.join(', ')})` : `  ${rule.id}`;
    lines.push(header);
    lines.push(`    pass: ${question.criteria.pass}`);
    lines.push(`    fail: ${question.criteria.fail}`);
  }
  return lines.length > 0 ? ['Rule criteria:', ...lines] : [];
}

export function formatRubricList(
  rubrics: BundledRubricSummary[],
  options: FormatRubricListOptions = {},
): string {
  const formatTags = (rubric: BundledRubricSummary): string => {
    const tags: string[] = [];
    if (rubric.target === 'project_structure') tags.push('[structure]');
    if (rubric.appliesTo) tags.push(`[applies: ${formatApplicability(rubric.appliesTo)}]`);
    return tags.length > 0 ? ` ${tags.join(' ')}` : '';
  };

  if (!options.verbose) {
    return rubrics.map((rubric) => {
      const tag = formatTags(rubric);
      const checks = rubric.checks.map((id) => {
        const threshold = rubric.thresholds[id];
        const thresholdNote = threshold !== PASS_THRESHOLD ? `, >=${formatThreshold(threshold)}` : '';
        return `${id} [${rubric.scopes[id]}${thresholdNote}]`;
      }).join(', ');
      return `${rubric.slug} (${rubric.id})${tag}: ${checks}`;
    }).join('\n');
  }

  return rubrics.map((rubric) => {
    const tag = formatTags(rubric);
    const lines = [`${rubric.slug} (${rubric.id})${tag}`];
    for (const id of rubric.checks) {
      const question = rubric.questions[id];
      lines.push(`  ${id} [${rubric.scopes[id]}, >=${formatThreshold(rubric.thresholds[id])}]`);
      lines.push(`    instructions: ${question.instructions}`);
      lines.push(`    pass: ${question.criteria.pass}`);
      lines.push(`    fail: ${question.criteria.fail}`);
    }
    return lines.join('\n');
  }).join('\n\n');
}

export function formatRuleExplanations(rules: RuleDefinition[]): string {
  return rules.map((rule) => {
    const rubricLabel = rule.rubricSlug === rule.rubricId
      ? rule.rubricId
      : `${rule.rubricSlug} (${rule.rubricId})`;
    return [
      rule.id,
      `  rubric: ${rubricLabel}`,
      ...(rule.appliesTo ? [`  applies: ${formatApplicability(rule.appliesTo)}`] : []),
      `  scope: ${rule.scope}`,
      `  threshold: >=${formatThreshold(rule.threshold)}`,
      `  instructions: ${rule.instructions}`,
      `  pass: ${rule.criteria.pass}`,
      `  fail: ${rule.criteria.fail}`,
    ].join('\n');
  }).join('\n\n');
}

/**
 * Render ESLint-style linter punch-list output for stdout.
 * Lists only files/modules with findings sorted worst-first (errors, warnings, min P(pass)),
 * followed by a compact rule breakdown, a Rule criteria legend for triggered rules, and a final summary line.
 */
export function formatLinterOutput(result: JudgeResult, options: FormatLinterOptions = {}): string {
  const quiet = options.quiet ?? false;
  const outDir = options.outDir;
  const modelLabel = result.returned_model ?? result.requested_model ?? result.backend;
  const lines: string[] = [];

  if (result.status === 'dry_run') {
    const modeTag = result.mode === 'code' ? 'module' : result.mode;
    const checks = Object.values(result.rubric_groups).flat();
    const checkLabels = checks.map((id) => {
      const threshold = checkThreshold(result, id);
      if (typeof threshold === 'number' && result.pass_threshold !== null && threshold !== result.pass_threshold) {
        return `${id} (>=${formatThreshold(threshold)})`;
      }
      return id;
    });
    const skippedFiles = result.file_results?.filter((f) => f.status === 'skipped') ?? [];
    const activeFiles = result.file_results?.filter((f) => f.status !== 'skipped') ?? [];
    const skippedModules = result.module_results?.filter((m) => m.status === 'skipped') ?? [];
    const activeModules = result.module_results?.filter((m) => m.status !== 'skipped') ?? [];

    let scopeLabel: string;
    if (result.module_results) {
      scopeLabel = skippedModules.length > 0
        ? `${activeModules.length} applicable of ${pluralize(result.module_results.length, 'module')} (${skippedModules.length} skipped: not applicable; ${pluralize(result.file_count, 'file')})`
        : `${pluralize(result.module_results.length, 'module')} (${pluralize(result.file_count, 'file')})`;
    } else if (skippedFiles.length > 0) {
      scopeLabel = `${activeFiles.length} applicable of ${pluralize(result.file_count, 'file')} (${skippedFiles.length} skipped: not applicable)`;
    } else {
      scopeLabel = pluralize(result.file_count, 'file');
    }
    lines.push(`DRY RUN (${modeTag}): ${scopeLabel}, ${pluralize(checks.length, 'check')} [${result.backend}: ${modelLabel}]`);
    lines.push(`Checks (${checks.length}): ${checkLabels.length > 0 ? checkLabels.join(', ') : '(none applicable)'}`);
    if (result.file_results && result.file_results.length > 0) {
      if (activeFiles.length > 0) {
        const preview = activeFiles.slice(0, 20).map((f) =>
          f.applicable_checks ? `${f.file} (${f.applicable_checks.length}/${checks.length})` : f.file,
        ).join(', ');
        const suffix = activeFiles.length > 20 ? `, ... (+${activeFiles.length - 20} more)` : '';
        lines.push(`Files (${activeFiles.length}): ${preview}${suffix}`);
      }
      if (skippedFiles.length > 0) {
        const preview = skippedFiles.slice(0, 20).map((f) => f.file).join(', ');
        const suffix = skippedFiles.length > 20 ? `, ... (+${skippedFiles.length - 20} more)` : '';
        lines.push(`Skipped files (not applicable, ${skippedFiles.length}): ${preview}${suffix}`);
      }
    } else if (result.module_results && result.module_results.length > 0) {
      if (activeModules.length > 0) {
        lines.push(`Modules (${activeModules.length}): ${activeModules.map((m) => m.module).join(', ')}`);
      }
      if (skippedModules.length > 0) {
        lines.push(`Skipped modules (not applicable, ${skippedModules.length}): ${skippedModules.map((m) => m.module).join(', ')}`);
      }
    } else if (result.target) {
      lines.push(`Target: ${result.target}`);
    }
    if (options.conventionsLabel) {
      lines.push(`Conventions: ${options.conventionsLabel}`);
    }
    if (result.skipped_module_checks?.length) {
      lines.push(`Skipped module checks (${result.skipped_module_checks.length}): ${result.skipped_module_checks.join(', ')}`);
    }
    if (result.skipped_not_applicable_checks?.length) {
      lines.push(`Skipped non-applicable checks (${result.skipped_not_applicable_checks.length}): ${result.skipped_not_applicable_checks.join(', ')}`);
    }
    if (result.ignored_patterns?.length) {
      lines.push(`Ignored patterns (${result.ignored_patterns.length}): ${result.ignored_patterns.join(', ')}`);
    }
    if (outDir !== undefined) {
      lines.push(`Artifacts: ${join(outDir, 'result.json')}`);
    }
    return lines.join('\n');
  }

  if (result.status === 'error') {
    lines.push(`ERROR: ${result.error ?? 'Judging failed'}`);
    if (result.file_results) {
      const errored = result.file_results.filter((entry) => entry.status === 'error');
      const scored = result.file_results.filter((entry) => entry.status === 'scored');
      lines.push(`Files: ${scored.length} scored, ${errored.length} errored (${result.file_count} total) in ${formatElapsed(result.elapsed_ms)}`);
      for (const entry of errored) {
        lines.push(`  error  ${entry.file}: ${entry.error ?? 'failed'}`);
      }
    } else if (result.module_results) {
      const errored = result.module_results.filter((entry) => entry.status === 'error');
      const scored = result.module_results.filter((entry) => entry.status === 'scored');
      lines.push(`Modules: ${scored.length} scored, ${errored.length} errored (${result.module_results.length} total) in ${formatElapsed(result.elapsed_ms)}`);
      for (const entry of errored) {
        lines.push(`  error  ${entry.module}: ${entry.error ?? 'failed'}`);
      }
    }
    if (outDir !== undefined) {
      lines.push(`Artifacts: ${join(outDir, 'result.json')}`);
    }
    return lines.join('\n');
  }

  const blocks: TargetBlock[] = [];
  let totalTargets = 0;
  let targetNoun: 'file' | 'module' | 'structure' = 'file';

  if (result.mode === 'file' && result.file_results) {
    totalTargets = result.file_results.length;
    targetNoun = 'file';
    for (const entry of result.file_results) {
      const findings = extractTargetFindings(result, entry.checks, quiet);
      if (findings.length > 0) {
        blocks.push(buildTargetBlock(entry.file, findings));
      }
    }
  } else if (result.module_results) {
    totalTargets = result.module_results.length;
    targetNoun = 'module';
    for (const entry of result.module_results) {
      const findings = extractTargetFindings(result, entry.checks, quiet);
      if (findings.length > 0) {
        blocks.push(buildTargetBlock(entry.module, findings));
      }
    }
  } else {
    totalTargets = 1;
    targetNoun = result.mode === 'structure' ? 'structure' : 'module';
    const findings = extractTargetFindings(result, result.quality?.checks, quiet);
    if (findings.length > 0) {
      const label = result.target ?? (result.mode === 'structure' ? 'structure' : 'module');
      blocks.push(buildTargetBlock(label, findings));
    }
  }

  blocks.sort((a, b) => {
    if (b.errorCount !== a.errorCount) return b.errorCount - a.errorCount;
    if (b.warningCount !== a.warningCount) return b.warningCount - a.warningCount;
    if (a.minProb !== b.minProb) return a.minProb - b.minProb;
    return a.label.localeCompare(b.label);
  });

  const maxRuleLen = blocks.length > 0
    ? Math.max(...blocks.flatMap((b) => b.findings.map((f) => f.id.length)), 24)
    : 24;

  for (let i = 0; i < blocks.length; i += 1) {
    const block = blocks[i];
    if (i > 0) lines.push('');
    lines.push(block.label);
    for (const finding of block.findings) {
      const sevLabel = finding.severity.padEnd(7);
      const idLabel = finding.id.padEnd(maxRuleLen);
      lines.push(`  ${sevLabel}  ${idLabel}  ${formatFindingDetail(finding)}`);
    }
  }

  const ruleStats = collectRuleStats(blocks);
  const ruleLines = formatRuleBreakdown(ruleStats);
  if (ruleLines.length > 0) {
    lines.push('');
    lines.push(...ruleLines);
  }

  const criteriaLines = formatRuleCriteria(ruleStats, result, options.rubric);
  if (criteriaLines.length > 0) {
    lines.push('');
    lines.push(...criteriaLines);
  }

  const visibleErrors = blocks.reduce((sum, b) => sum + b.errorCount, 0);
  const visibleWarnings = blocks.reduce((sum, b) => sum + b.warningCount, 0);
  const hasVisibleFindings = visibleErrors > 0 || visibleWarnings > 0;
  const icon = hasVisibleFindings ? '✖' : '✓';

  const countsText = quiet
    ? pluralize(visibleErrors, 'error')
    : `${pluralize(visibleErrors, 'error')}, ${pluralize(visibleWarnings, 'warning')}`;

  const skippedFileCount = result.file_results?.filter((e) => e.status === 'skipped').length ?? 0;
  const skippedModuleCount = result.module_results?.filter((e) => e.status === 'skipped').length ?? 0;
  const isSingleModuleNotApplicable = !result.file_results
    && !result.module_results
    && result.mode === 'code'
    && Object.keys(result.rubric_groups).length === 0
    && (result.skipped_not_applicable_checks?.length ?? 0) > 0;

  let scopeText: string;
  if (targetNoun === 'file') {
    const scoredTargets = totalTargets - skippedFileCount;
    if (skippedFileCount > 0) {
      scopeText = hasVisibleFindings
        ? `${blocks.length} of ${pluralize(scoredTargets, 'applicable file')} (${skippedFileCount} skipped)`
        : `${pluralize(scoredTargets, 'applicable file')} (${skippedFileCount} skipped: not applicable)`;
    } else {
      scopeText = hasVisibleFindings
        ? `${blocks.length} of ${pluralize(totalTargets, 'file')}`
        : pluralize(totalTargets, 'file');
    }
  } else if (targetNoun === 'module' && result.module_results) {
    const scoredModules = totalTargets - skippedModuleCount;
    if (skippedModuleCount > 0) {
      scopeText = hasVisibleFindings
        ? `${blocks.length} of ${pluralize(scoredModules, 'applicable module')} (${skippedModuleCount} skipped)`
        : `${pluralize(scoredModules, 'applicable module')} (${skippedModuleCount} skipped: not applicable)`;
    } else {
      scopeText = hasVisibleFindings
        ? `${blocks.length} of ${pluralize(totalTargets, 'module')}`
        : pluralize(totalTargets, 'module');
    }
  } else if (targetNoun === 'structure') {
    scopeText = `structure (${pluralize(result.file_count, 'file')})`;
  } else if (isSingleModuleNotApplicable) {
    scopeText = `0 applicable modules (1 skipped: not applicable; ${pluralize(result.file_count, 'file')})`;
  } else {
    scopeText = `1 module (${pluralize(result.file_count, 'file')})`;
  }

  const metaParts = [modelLabel];
  if (result.elapsed_ms !== undefined) metaParts.push(formatElapsed(result.elapsed_ms));
  if (result.retries) metaParts.push(`${result.retries} retries`);

  if (lines.length > 0) lines.push('');
  lines.push(`${icon} ${countsText} across ${scopeText} (${metaParts.join(', ')})`);

  if (outDir !== undefined) {
    lines.push(`Artifacts: ${join(outDir, 'result.json')}`);
  }

  return lines.join('\n');
}
