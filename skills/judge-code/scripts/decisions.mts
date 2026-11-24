import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { nonempty, object, type ChoiceQuestion, type JudgeMode, type ResolvedRubric } from './rubrics.mts';
import type { StructureManifest } from './structure.mts';

export const ENDPOINT = 'https://openrouter.ai/api/alpha/decisions';
export const DEFAULT_DECISION_MODEL = 'liquid/d1.2-ultra';
export const PASS_THRESHOLD = 0.8;
const REQUEST_TIMEOUT_MS = 60_000;

export interface Judgment {
  choice: 'pass' | 'fail';
  model_choice: 'pass' | 'fail';
  pass_probability: number;
  confidence: number;
}

export interface CodeRequest {
  model: string;
  state: {
    requirement?: string;
    conventions?: string;
    production_files?: Record<string, string>;
    project_structure?: StructureManifest;
  };
  questions: Record<string, ChoiceQuestion>;
}

export interface JudgeResult {
  status: 'scored' | 'dry_run' | 'error';
  mode: JudgeMode;
  file_count: number;
  requested_model: string;
  returned_model: string | null;
  rubric: string;
  rubric_groups: Record<string, string[]>;
  excluded_checks?: string[];
  pass_threshold: number;
  quality: {
    pass_rate: number;
    checks: Record<string, Judgment>;
  } | null;
  error?: string;
}

export interface JudgeRunOptions {
  files?: Record<string, string>;
  structure?: StructureManifest;
  requirements?: string;
  conventions?: string;
  rubric: ResolvedRubric;
  model: string;
  out: string;
  dryRun?: boolean;
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

async function postDecisions(
  body: string,
  key: string,
  responsePath: string,
  transport: typeof fetch,
): Promise<unknown> {
  let response: Response;
  let raw: string;
  try {
    response = await transport(ENDPOINT, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body,
      redirect: 'error',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    raw = await response.text();
  } catch {
    throw new Error('OpenRouter request failed or timed out');
  }
  if (raw.includes(key)) {
    writeFileSync(responsePath, raw.replaceAll(key, '[redacted]'), { mode: 0o600 });
    throw new Error('OpenRouter response contained credential material');
  }
  writeFileSync(responsePath, raw, { mode: 0o600 });
  if (!response.ok) throw new Error(`OpenRouter returned HTTP ${response.status}`);
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error('OpenRouter returned invalid JSON');
  }
}

function probability(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${label} must be a number from 0 to 1`);
  }
  return value;
}

/** Validate every required answer before producing any quality scores. */
export function readAnswers(raw: unknown, questions: Record<string, ChoiceQuestion>) {
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
    return [id, {
      choice: pass >= PASS_THRESHOLD ? 'pass' : 'fail',
      model_choice: answer.choice,
      pass_probability: pass,
      confidence: probability(answer.confidence, `${id}.confidence`),
    }];
  }));
  return { model, checks };
}

function passRate(checks: Record<string, Judgment>): number {
  const values = Object.values(checks);
  return values.filter((check) => check.choice === 'pass').length / values.length;
}

/** Score a production module or project structure manifest through OpenRouter's Decisions API. */
export async function runDecisionJudge(
  options: JudgeRunOptions,
  transport: typeof fetch = fetch,
): Promise<JudgeResult> {
  nonempty(options.model, 'model');
  const isStructure = options.rubric.target === 'project_structure';
  const fileCount = isStructure
    ? (options.structure?.total_files ?? 0)
    : Object.keys(options.files ?? {}).length;
  if (fileCount === 0) throw new Error('No files to score');

  const key = options.dryRun ? '' : process.env.OPENROUTER_API_KEY?.trim() ?? '';
  if (!options.dryRun && !key) {
    throw new Error('Set OPENROUTER_API_KEY before judging');
  }

  const out = resolve(options.out);
  mkdirSync(dirname(out), { recursive: true, mode: 0o700 });
  mkdirSync(out, { mode: 0o700 });

  const state: CodeRequest['state'] = {
    ...(options.requirements !== undefined ? { requirement: options.requirements } : {}),
    ...(options.conventions !== undefined ? { conventions: options.conventions } : {}),
    ...(isStructure
      ? { project_structure: options.structure }
      : { production_files: numbered(options.files!) }),
  };
  const request: CodeRequest = {
    model: options.model,
    state,
    questions: options.rubric.questions,
  };
  const body = saveJson(join(out, 'request.json'), request);

  const result: JudgeResult = {
    status: options.dryRun ? 'dry_run' : 'scored',
    mode: isStructure ? 'structure' : 'code',
    file_count: fileCount,
    requested_model: options.model,
    returned_model: null,
    rubric: options.rubric.rubric,
    rubric_groups: options.rubric.groups,
    ...(options.rubric.excluded.length > 0 ? { excluded_checks: options.rubric.excluded } : {}),
    pass_threshold: PASS_THRESHOLD,
    quality: null,
  };

  if (!options.dryRun) {
    try {
      const raw = await postDecisions(body, key, join(out, 'response.txt'), transport);
      const judged = readAnswers(raw, options.rubric.questions);
      result.returned_model = judged.model;
      result.quality = { pass_rate: passRate(judged.checks), checks: judged.checks };
    } catch (error) {
      result.status = 'error';
      result.error = error instanceof Error ? error.message : 'Judging failed';
    }
  }

  saveJson(join(out, 'result.json'), result);
  return result;
}
