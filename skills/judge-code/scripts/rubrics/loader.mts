import { readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseApplicability } from './applicability.mts';
import {
  CONVENTIONS_CHECK_ID,
  PASS_THRESHOLD,
  nonempty,
  object,
  type BundledRubricSummary,
  type CheckScope,
  type ChoiceQuestion,
  type ParsedRubricFile,
  type RubricTarget,
  type RuleDefinition,
} from './types.mts';

const RUBRICS_DIR = fileURLToPath(new URL('../../rubrics', import.meta.url));

function parseTarget(value: unknown, fallback: RubricTarget): RubricTarget {
  if (value === undefined) return fallback;
  if (value === 'production_code' || value === 'project_structure' || value === 'test_code') return value;
  throw new Error(`Unsupported rubric target: ${String(value)}. Expected production_code, project_structure, or test_code.`);
}

function parseQuestionScope(value: unknown, checkId: string, target: RubricTarget): CheckScope {
  if (target === 'project_structure') {
    if (value === undefined || value === 'structure') return 'structure';
    throw new Error(`Invalid scope for ${checkId}: ${String(value)}. project_structure rubrics do not support "file" or "module" scope.`);
  }
  if (value === undefined) return 'module';
  if (value === 'file' || value === 'module') return value;
  throw new Error(`Invalid scope for ${checkId}: ${String(value)}. Expected "file" or "module".`);
}

export function parsePassThreshold(value: unknown, checkId: string): number {
  if (value === undefined) return PASS_THRESHOLD;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > 1) {
    throw new Error(`Invalid pass_threshold for ${checkId}: ${String(value)}. Expected a finite number in (0, 1].`);
  }
  return value;
}

function parseQuestionEntry(
  checkId: string,
  value: unknown,
  target: RubricTarget,
): { question: ChoiceQuestion; scope: CheckScope; threshold: number } {
  if (!/^[a-z][a-z0-9_]*$/.test(checkId)) throw new Error(`Invalid question ID: ${checkId}`);
  const question = object(value, checkId);
  if (question.type !== 'choice') throw new Error(`${checkId} must use type choice`);
  const scope = parseQuestionScope(question.scope, checkId, target);
  const threshold = parsePassThreshold(question.pass_threshold, checkId);
  const criteria = object(question.criteria, `${checkId}.criteria`);
  if (Object.keys(criteria).sort().join(',') !== 'fail,pass') {
    throw new Error(`${checkId} must define exactly pass and fail criteria`);
  }
  return {
    question: {
      type: 'choice',
      instructions: nonempty(question.instructions, `${checkId}.instructions`),
      criteria: {
        pass: nonempty(criteria.pass, `${checkId}.pass`),
        fail: nonempty(criteria.fail, `${checkId}.fail`),
      },
    },
    scope,
    threshold,
  };
}

export function parseRubricJson(
  path: string,
  group: string,
  fallbackTarget: RubricTarget,
): ParsedRubricFile {
  const raw = object(JSON.parse(readFileSync(path, 'utf8')), `Rubric ${group}`);
  const id = nonempty(raw.rubric, `${group}.rubric`);
  const target = parseTarget(raw.target, fallbackTarget);
  const appliesTo = parseApplicability(raw.applies_to, group, target);
  const entries = Object.entries(object(raw.questions, `${group}.questions`));
  if (!entries.length) throw new Error(`Rubric ${id} must contain at least one question`);

  const questions: Record<string, ChoiceQuestion> = {};
  const scopes: Record<string, CheckScope> = {};
  const thresholds: Record<string, number> = {};
  for (const [checkId, value] of entries) {
    const parsed = parseQuestionEntry(checkId, value, target);
    questions[checkId] = parsed.question;
    scopes[checkId] = parsed.scope;
    thresholds[checkId] = parsed.threshold;
  }
  return { id, group, target, ...(appliesTo ? { appliesTo } : {}), questions, scopes, thresholds };
}

export function bundledSlugs(): string[] {
  return readdirSync(RUBRICS_DIR)
    .filter((file) => file.endsWith('.json'))
    .sort()
    .map((file) => file.slice(0, -5));
}

export function loadBundledRubric(slug: string): ParsedRubricFile {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
    throw new Error(`Unknown rubric: ${slug}`);
  }
  const path = join(RUBRICS_DIR, `${slug}.json`);
  if (!statSync(path, { throwIfNoEntry: false })?.isFile()) {
    throw new Error(`Unknown rubric: ${slug}. Run \`judge-code list\` to see bundled rubrics.`);
  }
  return parseRubricJson(path, slug, 'production_code');
}

function isLocalRubricPath(spec: string): boolean {
  return spec.endsWith('.json') || spec.includes('/') || spec.includes('\\');
}

function parseBundledSpec(spec: string): { slug: string; expectedVersion?: string } {
  const versioned = /^([a-z0-9]+(?:-[a-z0-9]+)*)-v[1-9][0-9]*$/.exec(spec);
  return versioned ? { slug: versioned[1], expectedVersion: spec } : { slug: spec };
}

export function bundledRubrics(): BundledRubricSummary[] {
  return bundledSlugs().map((slug) => {
    const parsed = loadBundledRubric(slug);
    return {
      slug,
      id: parsed.id,
      target: parsed.target,
      ...(parsed.appliesTo ? { appliesTo: parsed.appliesTo } : {}),
      checks: Object.keys(parsed.questions),
      scopes: parsed.scopes,
      thresholds: parsed.thresholds,
      questions: parsed.questions,
    };
  });
}

export function loadRubricSpecs(specs: string[], fallbackTarget: RubricTarget): ParsedRubricFile[] {
  const parsedSources: ParsedRubricFile[] = [];
  const seenBundled = new Set<string>();
  const seenLocal = new Set<string>();

  for (const spec of specs) {
    if (isLocalRubricPath(spec)) {
      const fullPath = resolve(spec);
      if (!statSync(fullPath, { throwIfNoEntry: false })?.isFile()) {
        throw new Error(`Rubric file not found: ${spec}`);
      }
      const canonical = realpathSync(fullPath);
      if (seenLocal.has(canonical)) throw new Error(`Duplicate rubric file: ${spec}`);
      seenLocal.add(canonical);
      parsedSources.push(parseRubricJson(canonical, basename(canonical, '.json'), fallbackTarget));
    } else {
      const { slug, expectedVersion } = parseBundledSpec(spec);
      if (seenBundled.has(slug)) throw new Error(`Duplicate rubric selected: ${slug}`);
      seenBundled.add(slug);
      const parsed = loadBundledRubric(slug);
      if (expectedVersion && parsed.id !== expectedVersion) {
        throw new Error(`Rubric version unavailable: ${expectedVersion}. Installed version: ${parsed.id}`);
      }
      parsedSources.push(parsed);
    }
  }
  return parsedSources;
}

function indexRuleDefinitions(parsedSources: readonly ParsedRubricFile[]): Map<string, RuleDefinition> {
  const seenRubricIds = new Set<string>();
  const byId = new Map<string, RuleDefinition>();
  for (const parsed of parsedSources) {
    if (seenRubricIds.has(parsed.id)) {
      throw new Error(`Duplicate rubric ID: ${parsed.id}`);
    }
    seenRubricIds.add(parsed.id);
    for (const [id, question] of Object.entries(parsed.questions)) {
      const existing = byId.get(id);
      if (existing !== undefined) {
        throw new Error(`Overlapping question ID ${id} in rubrics ${existing.rubricId} and ${parsed.id}`);
      }
      byId.set(id, {
        id,
        rubricSlug: parsed.group,
        rubricId: parsed.id,
        target: parsed.target,
        ...(parsed.appliesTo ? { appliesTo: parsed.appliesTo } : {}),
        scope: parsed.scopes[id],
        threshold: parsed.thresholds[id],
        instructions: question.instructions,
        criteria: question.criteria,
      });
    }
  }
  return byId;
}

function defaultConventionsRuleDefinition(): RuleDefinition {
  return {
    id: CONVENTIONS_CHECK_ID,
    rubricSlug: 'conventions',
    rubricId: 'repo-conventions',
    target: 'production_code',
    scope: 'module',
    threshold: PASS_THRESHOLD,
    instructions: 'Does the supplied production code (or project structure) follow the explicit conventions in state.conventions? (Enabled automatically when AGENTS.md is present or --conventions FILE is passed.)',
    criteria: {
      pass: 'The production code (or project structure) adheres to all applicable conventions stated in state.conventions, or none of the conventions apply.',
      fail: 'The production code (or project structure) violates one or more explicit conventions stated in state.conventions.',
    },
  };
}

export function explainRules(ruleIds: string[], rubricSpecs: string[] = []): RuleDefinition[] {
  if (ruleIds.length === 0) {
    throw new Error('Specify one or more check IDs for `judge-code explain <check-id...>`');
  }
  const parsedSources = rubricSpecs.length === 0
    ? bundledSlugs().map((slug) => loadBundledRubric(slug))
    : loadRubricSpecs(rubricSpecs, 'production_code');
  const byId = indexRuleDefinitions(parsedSources);

  if (rubricSpecs.length === 0 && !byId.has(CONVENTIONS_CHECK_ID)) {
    byId.set(CONVENTIONS_CHECK_ID, defaultConventionsRuleDefinition());
  }

  const requested = [...new Set(ruleIds)];
  const unknown = requested.filter((id) => !byId.has(id));
  if (unknown.length > 0) {
    const suffix = rubricSpecs.length > 0
      ? ` in selected rubric(s): ${rubricSpecs.join(', ')}`
      : '. Run `judge-code list` to see available checks.';
    throw new Error(`Unknown check ID${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}${suffix}`);
  }
  return requested.map((id) => byId.get(id)!);
}
