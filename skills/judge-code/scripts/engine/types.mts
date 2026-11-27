import type { StructureManifest } from '../inputs/structure.mts';
import type { TestKindClassification } from '../rubrics/classifier.mts';
import {
  PASS_THRESHOLD,
  type ChoiceQuestion,
  type JudgeMode,
  type ResolvedRubric,
} from '../rubrics/types.mts';

export { PASS_THRESHOLD };

export const ERROR_SCORE_THRESHOLD = 60;
export const DEFAULT_PASS_SCORE = Number((PASS_THRESHOLD * 100).toFixed(1));
export const ENDPOINT = 'https://openrouter.ai/api/alpha/decisions';
export const DEFAULT_DECISION_MODEL = 'liquid/d1.2-ultra';
export const DEFAULT_FILE_MODE_DECISION_MODEL = 'typesafe/jev-1.14';
export const DEFAULT_OPENROUTER_CONCURRENCY = 16;
export const DEFAULT_CLI_CONCURRENCY = 4;

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

export interface ScoredRequestOutput {
  model: string;
  checks: Record<string, Judgment>;
  retries?: number;
}

export type ScoreRequestFn = (
  request: CodeRequest,
  body: string,
  artifactDir?: string,
) => Promise<ScoredRequestOutput>;

export type TestClassifierFn = (
  filePath: string,
  content: string,
) => Promise<TestKindClassification>;

export interface JudgeRunnerContext {
  backend: JudgeBackend;
  passThreshold: number | null;
  defaultConcurrency: number;
  scoreRequest: ScoreRequestFn;
  classifyTest?: TestClassifierFn;
}
