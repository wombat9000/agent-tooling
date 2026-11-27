import { normalizeThresholdToScore, probabilityToScore } from '../engine/scoring.mts';
import {
  DEFAULT_PASS_SCORE,
  ERROR_SCORE_THRESHOLD,
  type JudgeResult,
  type Judgment,
} from '../engine/types.mts';
import { formatApplicability } from '../rubrics/applicability.mts';
import type {
  BundledRubricSummary,
  CheckScope,
  ChoiceQuestion,
  RubricTarget,
  RuleDefinition,
} from '../rubrics/types.mts';

export interface RubricCriteriaInfo {
  questions: Record<string, ChoiceQuestion>;
  scopes?: Record<string, CheckScope>;
  thresholds?: Record<string, number>;
  groups?: Record<string, string[]>;
}

export interface FormatRubricListOptions {
  verbose?: boolean;
}

export interface RuleStat {
  id: string;
  errors: number;
  warnings: number;
  minScore: number;
}

const RUBRIC_TARGET_TAG: Partial<Record<RubricTarget, string>> = {
  project_structure: '[structure]',
  test_code: '[test]',
};

export function formatElapsed(ms: number | undefined): string {
  if (ms === undefined) return 'n/a';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

export function formatThreshold(value: number): string {
  const score = value > 0 && value <= 1 ? probabilityToScore(value) : value;
  const rounded = Number(score.toFixed(1));
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

export function checkThreshold(result: JudgeResult, id: string, check?: Judgment): number | null {
  return check?.pass_threshold ?? result.check_thresholds?.[id] ?? result.pass_threshold;
}

function wouldRoundUpPastBoundary(value: number, rounded: number, boundary: number): boolean {
  return value < boundary && rounded >= boundary;
}

export function formatScore(value: number | null | undefined, threshold?: number | null): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 'n/a';
  const rounded = Math.round(value);
  const boundaries: number[] = [ERROR_SCORE_THRESHOLD];
  if (typeof threshold === 'number' && Number.isFinite(threshold)) {
    boundaries.push(threshold);
  }
  for (const boundary of boundaries) {
    if (wouldRoundUpPastBoundary(value, rounded, boundary)) {
      const floored = Math.floor(value * 10) / 10;
      const maxBelow = Number((boundary - 0.1).toFixed(1));
      return Math.min(floored, maxBelow).toFixed(1);
    }
  }
  return String(rounded);
}

export function formatRuleBreakdown(sorted: readonly RuleStat[]): string[] {
  if (sorted.length === 0) return [];
  const maxIdLen = Math.max(...sorted.map((rule) => rule.id.length), 24);
  const lines = ['Rules:'];
  for (const rule of sorted) {
    const parts: string[] = [];
    if (rule.errors > 0) parts.push(pluralize(rule.errors, 'error'));
    if (rule.warnings > 0) parts.push(pluralize(rule.warnings, 'warning'));
    lines.push(`  ${rule.id.padEnd(maxIdLen)}  ${parts.join(', ')}`);
  }
  return lines;
}

function findRuleGroup(id: string, groups: Record<string, string[]> | undefined): string | undefined {
  if (!groups) return undefined;
  for (const [group, ids] of Object.entries(groups)) {
    if (ids.includes(id)) return group;
  }
  return undefined;
}

export function formatRuleCriteria(
  sorted: readonly RuleStat[],
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
    const rawRubricThreshold = rubric.thresholds?.[rule.id];
    const threshold = rawRubricThreshold !== undefined
      ? normalizeThresholdToScore(rawRubricThreshold)
      : checkThreshold(result, rule.id);
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

function formatRubricTags(rubric: BundledRubricSummary): string {
  const tags: string[] = [];
  const targetTag = RUBRIC_TARGET_TAG[rubric.target];
  if (targetTag) tags.push(targetTag);
  if (rubric.appliesTo) tags.push(`[applies: ${formatApplicability(rubric.appliesTo)}]`);
  return tags.length > 0 ? ` ${tags.join(' ')}` : '';
}

function formatCompactRubric(rubric: BundledRubricSummary): string {
  const checks = rubric.checks.map((id) => {
    const threshold = probabilityToScore(rubric.thresholds[id]);
    const thresholdNote = threshold !== DEFAULT_PASS_SCORE ? `, >=${formatThreshold(threshold)}` : '';
    return `${id} [${rubric.scopes[id]}${thresholdNote}]`;
  }).join(', ');
  return `${rubric.slug} (${rubric.id})${formatRubricTags(rubric)}: ${checks}`;
}

function formatVerboseRubric(rubric: BundledRubricSummary): string {
  const lines = [`${rubric.slug} (${rubric.id})${formatRubricTags(rubric)}`];
  for (const id of rubric.checks) {
    const question = rubric.questions[id];
    lines.push(`  ${id} [${rubric.scopes[id]}, >=${formatThreshold(probabilityToScore(rubric.thresholds[id]))}]`);
    lines.push(`    instructions: ${question.instructions}`);
    lines.push(`    pass: ${question.criteria.pass}`);
    lines.push(`    fail: ${question.criteria.fail}`);
  }
  return lines.join('\n');
}

export function formatRubricList(
  rubrics: BundledRubricSummary[],
  options: FormatRubricListOptions = {},
): string {
  return options.verbose
    ? rubrics.map(formatVerboseRubric).join('\n\n')
    : rubrics.map(formatCompactRubric).join('\n');
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
      `  threshold: >=${formatThreshold(probabilityToScore(rule.threshold))}`,
      `  instructions: ${rule.instructions}`,
      `  pass: ${rule.criteria.pass}`,
      `  fail: ${rule.criteria.fail}`,
    ].join('\n');
  }).join('\n\n');
}
