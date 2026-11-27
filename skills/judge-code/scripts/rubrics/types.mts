export const CONVENTIONS_CHECK_ID = 'follows_repo_conventions';
export const PASS_THRESHOLD = 0.8;

export type RubricTarget = 'production_code' | 'project_structure' | 'test_code';
export type JudgeMode = 'code' | 'file' | 'structure';
export type CheckScope = 'file' | 'module' | 'structure';

export interface ChoiceQuestion {
  type: 'choice';
  instructions: string;
  criteria: { pass: string; fail: string };
}

export interface RubricApplicability {
  extensions?: string[];
  runtime_imports?: string[];
}

export interface BundledRubricSummary {
  slug: string;
  id: string;
  target: RubricTarget;
  appliesTo?: RubricApplicability;
  checks: string[];
  scopes: Record<string, CheckScope>;
  thresholds: Record<string, number>;
  questions: Record<string, ChoiceQuestion>;
}

export interface RuleDefinition {
  id: string;
  rubricSlug: string;
  rubricId: string;
  target: RubricTarget;
  appliesTo?: RubricApplicability;
  scope: CheckScope;
  threshold: number;
  instructions: string;
  criteria: { pass: string; fail: string };
}

export interface ResolvedRubric {
  rubric: string;
  target: RubricTarget;
  questions: Record<string, ChoiceQuestion>;
  scopes: Record<string, CheckScope>;
  thresholds: Record<string, number>;
  appliesTo?: Record<string, RubricApplicability>;
  groups: Record<string, string[]>;
  groupRubricIds?: Record<string, string>;
  excluded: string[];
  skippedModuleChecks: string[];
}

export interface ResolveRubricsOptions {
  mode?: JudgeMode;
  target?: RubricTarget;
  rubrics?: string[];
  rules?: string[];
  exclude?: string[];
  hasRequirements: boolean;
  hasConventions: boolean;
  allowTestCode?: boolean;
}

export interface ResolveUnifiedRubricsOptions {
  mode: JudgeMode;
  rubrics?: string[];
  rules?: string[];
  exclude?: string[];
  hasRequirements: boolean;
  hasConventions: boolean;
}

export interface UnifiedResolvedRubrics {
  production?: ResolvedRubric;
  test?: ResolvedRubric;
  structure?: ResolvedRubric;
  explicitTestSelection: boolean;
  combinedCriteria: {
    questions: Record<string, ChoiceQuestion>;
    scopes: Record<string, CheckScope>;
    thresholds: Record<string, number>;
    groups: Record<string, string[]>;
  };
}

export interface ParsedRubricFile {
  id: string;
  group: string;
  target: RubricTarget;
  appliesTo?: RubricApplicability;
  questions: Record<string, ChoiceQuestion>;
  scopes: Record<string, CheckScope>;
  thresholds: Record<string, number>;
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
