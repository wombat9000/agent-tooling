import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const RUBRICS = fileURLToPath(new URL('../rubrics', import.meta.url));

export interface ChoiceQuestion {
  type: 'choice';
  instructions: string;
  criteria: { pass: string; fail: string };
}

export type RubricTarget = 'review' | 'production_code';

export interface JudgeRubric {
  rubric: string;
  target: RubricTarget;
  questions: Record<string, ChoiceQuestion>;
  groups?: Record<string, string[]>;
}

export function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

export function nonempty(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} must be a nonempty string`);
  return value;
}

function parseExtends(value: unknown): string[] {
  if (typeof value === 'string') return [nonempty(value, 'extends')];
  if (Array.isArray(value) && value.length > 0) {
    return value.map((entry, idx) => nonempty(entry, `extends[${idx}]`));
  }
  throw new Error('extends must be a nonempty string or array of rubric names');
}

function loadSharedRubric(name: string): Record<string, unknown> {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) {
    throw new Error(`Invalid shared rubric name: ${name}`);
  }
  const sharedPath = join(RUBRICS, `${name}.json`);
  if (!statSync(sharedPath, { throwIfNoEntry: false })?.isFile()) {
    throw new Error(`Unknown shared rubric: ${name}`);
  }
  const base = object(JSON.parse(readFileSync(sharedPath, 'utf8')), `Shared rubric ${name}`);
  if (base.extends !== undefined) {
    throw new Error(`Shared rubric ${name} must not chain extends`);
  }
  return base;
}

/** Load a task's tests/judge.json, resolving one or more shared rubrics via `extends`. */
export function composeRubric(
  raw: Record<string, unknown>,
  load = loadSharedRubric,
): { raw: Record<string, unknown>; groups?: Record<string, string[]> } {
  if (raw.extends === undefined) return { raw };

  const names = parseExtends(raw.extends);
  const seenNames = new Set<string>();
  const baseRubrics: string[] = [];
  const mergedQuestions: Record<string, unknown> = {};
  const questionOwner = new Map<string, string>();
  const groups: Record<string, string[]> = {};
  let baseTarget: unknown;

  for (const name of names) {
    if (seenNames.has(name)) {
      throw new Error(`Duplicate shared rubric in extends: ${name}`);
    }
    seenNames.add(name);

    const base = load(name);
    baseRubrics.push(nonempty(base.rubric, `Shared rubric ${name}.rubric`));

    if (base.target !== undefined) {
      if (baseTarget !== undefined && baseTarget !== base.target) {
        throw new Error(`Shared rubric ${name} target (${String(base.target)}) conflicts with earlier shared rubric target (${String(baseTarget)})`);
      }
      baseTarget = base.target;
    }

    const baseQuestions = object(base.questions, `Shared rubric ${name}.questions`);
    const groupIds: string[] = [];
    for (const [id, question] of Object.entries(baseQuestions)) {
      const existingOwner = questionOwner.get(id);
      if (existingOwner !== undefined) {
        throw new Error(`Overlapping question ID ${id} in shared rubrics ${existingOwner} and ${name}`);
      }
      questionOwner.set(id, name);
      mergedQuestions[id] = question;
      groupIds.push(id);
    }
    groups[name] = groupIds;
  }

  if (raw.target !== undefined && baseTarget !== undefined && raw.target !== baseTarget) {
    throw new Error(`Task rubric target (${String(raw.target)}) conflicts with shared rubric target (${String(baseTarget)})`);
  }
  const taskQuestions = raw.questions === undefined ? {} : object(raw.questions, 'questions');
  const extraIds = Object.keys(taskQuestions).filter((id) => !questionOwner.has(id));
  if (extraIds.length > 0) groups.task = extraIds;

  return {
    raw: {
      rubric: raw.rubric ?? baseRubrics.join('+'),
      target: raw.target ?? baseTarget,
      source_root: raw.source_root,
      questions: { ...mergedQuestions, ...taskQuestions },
    },
    groups,
  };
}

export function parseTarget(value: unknown): RubricTarget {
  if (value === undefined || value === 'review') return 'review';
  if (value === 'production_code') return 'production_code';
  throw new Error(`Unknown rubric target: ${String(value)}`);
}

export function parseRubricObject(
  raw: Record<string, unknown>,
  rulesPrefix: string,
  groups?: Record<string, string[]>,
): JudgeRubric {
  const rubric = nonempty(raw.rubric, 'rubric');
  const target = parseTarget(raw.target);
  const entries = Object.entries(object(raw.questions, 'questions'));
  if (!entries.length) throw new Error('Rubric must contain at least one question');
  const questions = Object.fromEntries(entries.map(([id, value]) => {
    if (!/^[a-z][a-z0-9_]*$/.test(id)) throw new Error(`Invalid question ID: ${id}`);
    const question = object(value, id);
    if (question.type !== 'choice') throw new Error(`${id} must use type choice`);
    const criteria = object(question.criteria, `${id}.criteria`);
    if (Object.keys(criteria).sort().join(',') !== 'fail,pass') {
      throw new Error(`${id} must define exactly pass and fail criteria`);
    }
    return [id, {
      type: 'choice' as const,
      instructions: rulesPrefix + nonempty(question.instructions, `${id}.instructions`),
      criteria: {
        pass: nonempty(criteria.pass, `${id}.pass`),
        fail: nonempty(criteria.fail, `${id}.fail`),
      },
    }];
  }));
  return groups ? { rubric, target, questions, groups } : { rubric, target, questions };
}

/** Parse and validate a single shared rubric under rubrics/<slug>.json. */
export function parseSharedRubric(slug: string, rulesPrefix = ''): JudgeRubric {
  return parseRubricObject(loadSharedRubric(slug), rulesPrefix);
}

export function bundledRubricIds(): string[] {
  return readdirSync(RUBRICS)
    .filter((file) => file.endsWith('.json'))
    .sort()
    .map((file) => parseSharedRubric(file.slice(0, -5)).rubric);
}

export function parseBundledRubrics(ids: string[], rulesPrefix: string): JudgeRubric {
  const versions = new Map<string, string>();
  const names = ids.map((id) => {
    const slug = /^([a-z0-9]+(?:-[a-z0-9]+)*)-v[1-9][0-9]*$/.exec(id)?.[1];
    if (!slug) throw new Error('Use versioned rubric IDs from --list-rubrics');
    if (versions.has(slug)) throw new Error(`Select one version of each rubric: ${slug}`);
    versions.set(slug, id);
    return slug;
  });
  const { raw, groups } = composeRubric({ extends: names }, (slug) => {
    const rubric = loadSharedRubric(slug);
    if (rubric.rubric !== versions.get(slug)) {
      throw new Error(`Rubric version unavailable: ${versions.get(slug)}. Installed version: ${rubric.rubric}`);
    }
    return rubric;
  });
  return parseRubricObject(raw, rulesPrefix, groups);
}
