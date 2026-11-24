import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { nonempty, object, type ChoiceQuestion, type JudgeMode, type ResolvedRubric } from './rubrics.mts';
import type { StructureManifest } from './structure.mts';

export const ENDPOINT = 'https://openrouter.ai/api/alpha/decisions';
export const DEFAULT_DECISION_MODEL = 'liquid/d1.2-ultra';
export const PASS_THRESHOLD = 0.8;
export const DEFAULT_OPENROUTER_CONCURRENCY = 16;
export const DEFAULT_CLI_CONCURRENCY = 4;
const REQUEST_TIMEOUT_MS = 60_000;

export const RETRYABLE_HTTP_STATUSES = new Set([429, 502, 503, 504]);
export const DEFAULT_MAX_RETRIES = 4;
export const DEFAULT_BASE_DELAY_MS = 4_000;
export const DEFAULT_MAX_DELAY_MS = 30_000;
export const DEFAULT_MAX_RETRY_AFTER_MS = 60_000;

export type JudgeBackend = 'openrouter' | 'codex' | 'claude';

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
  model_choice?: 'pass' | 'borderline' | 'fail';
  pass_probability: number | null;
  confidence: number | null;
  note?: string;
  files_passed?: number;
  files_total?: number;
  min_pass_probability?: number | null;
}

export interface FileJudgment {
  file: string;
  status: 'scored' | 'dry_run' | 'error';
  returned_model: string | null;
  elapsed_ms: number;
  pass_rate: number | null;
  checks: Record<string, Judgment> | null;
  result_dir: string;
  error?: string;
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
  backend: JudgeBackend;
  mode: JudgeMode;
  file_count: number;
  elapsed_ms?: number;
  retries?: number;
  requested_model: string | null;
  returned_model: string | null;
  rubric: string;
  rubric_groups: Record<string, string[]>;
  excluded_checks?: string[];
  skipped_module_checks?: string[];
  pass_threshold: number | null;
  quality: {
    pass_rate: number;
    all_files_pass_rate?: number;
    checks: Record<string, Judgment>;
  } | null;
  file_results?: FileJudgment[];
  error?: string;
}

export interface JudgeRunOptions {
  mode?: JudgeMode;
  files?: Record<string, string>;
  structure?: StructureManifest;
  requirements?: string;
  conventions?: string;
  rubric: ResolvedRubric;
  model?: string;
  out: string;
  concurrency?: number;
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

export function passRate(checks: Record<string, Judgment>): number {
  const values = Object.values(checks);
  return values.filter((check) => check.choice === 'pass').length / values.length;
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

export function aggregatePerFile(
  fileResults: FileJudgment[],
  questionIds: string[],
): { pass_rate: number; all_files_pass_rate: number; checks: Record<string, Judgment> } {
  const totalFiles = fileResults.length;
  const checks: Record<string, Judgment> = {};

  for (const id of questionIds) {
    const perFile = fileResults.map((entry) => entry.checks![id]);
    const filesPassed = perFile.filter((c) => c.choice === 'pass').length;
    const hasProbabilities = perFile.every((c) => typeof c.pass_probability === 'number');
    const hasConfidence = perFile.every((c) => typeof c.confidence === 'number');
    const meanProb = hasProbabilities
      ? perFile.reduce((sum, c) => sum + c.pass_probability!, 0) / totalFiles
      : null;
    const minProb = hasProbabilities
      ? Math.min(...perFile.map((c) => c.pass_probability!))
      : null;
    const meanConf = hasConfidence
      ? perFile.reduce((sum, c) => sum + c.confidence!, 0) / totalFiles
      : null;
    checks[id] = {
      choice: filesPassed === totalFiles ? 'pass' : 'fail',
      files_passed: filesPassed,
      files_total: totalFiles,
      pass_probability: meanProb,
      min_pass_probability: minProb,
      confidence: meanConf,
    };
  }

  const meanFilePassRate = fileResults.reduce((sum, entry) => sum + (entry.pass_rate ?? 0), 0) / totalFiles;
  const allFilesPassRate = Object.values(checks).filter((c) => c.choice === 'pass').length / questionIds.length;
  return {
    pass_rate: meanFilePassRate,
    all_files_pass_rate: allFilesPassRate,
    checks,
  };
}

export function prepareJudgeRun(
  options: JudgeRunOptions,
  backend: JudgeBackend,
  passThreshold: number | null,
): { out: string; request: CodeRequest; body: string; result: JudgeResult } {
  const isStructure = options.rubric.target === 'project_structure';
  const fileCount = isStructure
    ? (options.structure?.total_files ?? 0)
    : Object.keys(options.files ?? {}).length;
  if (fileCount === 0) throw new Error('No files to score');

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
    model: options.model ?? `${backend}-default`,
    state,
    questions: options.rubric.questions,
  };
  const body = saveJson(join(out, 'request.json'), request);

  const result: JudgeResult = {
    status: options.dryRun ? 'dry_run' : 'scored',
    backend,
    mode: isStructure ? 'structure' : 'code',
    file_count: fileCount,
    requested_model: options.model ?? null,
    returned_model: null,
    rubric: options.rubric.rubric,
    rubric_groups: options.rubric.groups,
    ...(options.rubric.excluded.length > 0 ? { excluded_checks: options.rubric.excluded } : {}),
    pass_threshold: passThreshold,
    quality: null,
  };

  return { out, request, body, result };
}

export async function runPerFileJudge(
  options: JudgeRunOptions,
  backend: JudgeBackend,
  passThreshold: number | null,
  defaultConcurrency: number,
  scoreFile: (
    request: CodeRequest,
    body: string,
    fileDir: string,
  ) => Promise<{ model: string; checks: Record<string, Judgment>; retries?: number }>,
): Promise<JudgeResult> {
  const files = options.files ?? {};
  const fileNames = Object.keys(files).sort((a, b) => a.localeCompare(b));
  if (fileNames.length === 0) throw new Error('No files to score');

  const startMs = performance.now();
  const out = resolve(options.out);
  mkdirSync(dirname(out), { recursive: true, mode: 0o700 });
  mkdirSync(out, { mode: 0o700 });
  const filesRoot = join(out, 'files');
  mkdirSync(filesRoot, { recursive: true, mode: 0o700 });

  const concurrency = options.concurrency ?? defaultConcurrency;
  const questionIds = Object.keys(options.rubric.questions);
  let totalRetries = 0;

  const fileResults = await runWithConcurrency(fileNames, concurrency, async (file, index): Promise<FileJudgment> => {
    const fileStart = performance.now();
    const slug = safeFileSlug(index, fileNames.length, file);
    const relDir = `files/${slug}`;
    const absDir = join(out, relDir);
    mkdirSync(absDir, { recursive: true, mode: 0o700 });

    const request: CodeRequest = {
      model: options.model ?? `${backend}-default`,
      state: {
        ...(options.requirements !== undefined ? { requirement: options.requirements } : {}),
        ...(options.conventions !== undefined ? { conventions: options.conventions } : {}),
        production_files: numbered({ [file]: files[file] }),
      },
      questions: options.rubric.questions,
    };
    const body = saveJson(join(absDir, 'request.json'), request);

    const entry: FileJudgment = {
      file,
      status: options.dryRun ? 'dry_run' : 'scored',
      returned_model: null,
      elapsed_ms: 0,
      pass_rate: null,
      checks: null,
      result_dir: relDir,
    };

    if (options.dryRun) {
      entry.elapsed_ms = Math.round(performance.now() - fileStart);
      saveJson(join(absDir, 'result.json'), entry);
      return entry;
    }

    try {
      const judged = await scoreFile(request, body, absDir);
      totalRetries += judged.retries ?? 0;
      entry.status = 'scored';
      entry.returned_model = judged.model;
      entry.checks = judged.checks;
      entry.pass_rate = passRate(judged.checks);
    } catch (error) {
      entry.status = 'error';
      entry.error = error instanceof Error ? error.message : 'Judging failed';
    }
    entry.elapsed_ms = Math.round(performance.now() - fileStart);
    saveJson(join(absDir, 'result.json'), entry);
    return entry;
  });

  const errored = fileResults.filter((entry) => entry.status === 'error');
  const models = [...new Set(fileResults.map((entry) => entry.returned_model).filter((m): m is string => Boolean(m)))];
  const elapsedMs = Math.round(performance.now() - startMs);

  const result: JudgeResult = {
    status: options.dryRun ? 'dry_run' : errored.length > 0 ? 'error' : 'scored',
    backend,
    mode: 'file',
    file_count: fileNames.length,
    elapsed_ms: elapsedMs,
    ...(totalRetries > 0 ? { retries: totalRetries } : {}),
    requested_model: options.model ?? null,
    returned_model: models.join(', ') || null,
    rubric: options.rubric.rubric,
    rubric_groups: options.rubric.groups,
    ...(options.rubric.excluded.length > 0 ? { excluded_checks: options.rubric.excluded } : {}),
    ...(options.rubric.skippedModuleChecks.length > 0
      ? { skipped_module_checks: options.rubric.skippedModuleChecks }
      : {}),
    pass_threshold: passThreshold,
    quality: !options.dryRun && errored.length === 0
      ? aggregatePerFile(fileResults, questionIds)
      : null,
    file_results: fileResults,
    ...(errored.length > 0
      ? {
        error: `${errored.length} of ${fileResults.length} file(s) failed: ${errored[0].file}: ${errored[0].error}`,
      }
      : {}),
  };

  saveJson(join(out, 'result.json'), result);
  return result;
}

/** Parse an HTTP Retry-After header (delta-seconds or HTTP-date) into bounded milliseconds. */
export function parseRetryAfterMs(
  headerValue: string | null,
  nowMs: number = Date.now(),
  maxRetryAfterMs: number = DEFAULT_MAX_RETRY_AFTER_MS,
): number | null {
  if (!headerValue) return null;
  const trimmed = headerValue.trim();
  if (!trimmed) return null;
  if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
    const seconds = Number(trimmed);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(Math.round(seconds * 1000), maxRetryAfterMs);
    }
    return null;
  }
  const parsedDate = Date.parse(trimmed);
  if (Number.isFinite(parsedDate)) {
    return Math.min(Math.max(0, parsedDate - nowMs), maxRetryAfterMs);
  }
  return null;
}

function computeRetryDelayMs(
  retryIndex: number,
  retryAfterHeader: string | null,
  baseDelayMs: number,
  maxDelayMs: number,
  maxRetryAfterMs: number,
  random: () => number,
  now: () => number,
): number {
  const retryAfterMs = parseRetryAfterMs(retryAfterHeader, now(), maxRetryAfterMs);
  if (retryAfterMs !== null) return retryAfterMs;
  const exponential = Math.min(maxDelayMs, baseDelayMs * (2 ** retryIndex));
  const jitterFactor = 0.75 + random() * 0.5;
  return Math.min(maxDelayMs, Math.max(0, Math.round(exponential * jitterFactor)));
}

async function postDecisions(
  body: string,
  key: string,
  responsePath: string,
  transport: typeof fetch,
  retry: RetryOptions = {},
): Promise<{ raw: unknown; retries: number }> {
  const maxRetries = retry.maxRetries ?? DEFAULT_MAX_RETRIES;
  const baseDelayMs = retry.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const maxDelayMs = retry.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  const maxRetryAfterMs = retry.maxRetryAfterMs ?? DEFAULT_MAX_RETRY_AFTER_MS;
  const sleep = retry.sleep ?? ((ms: number) => new Promise<void>((resolveDelay) => setTimeout(resolveDelay, ms)));
  const random = retry.random ?? Math.random;
  const now = retry.now ?? Date.now;
  const onRetry = retry.onRetry ?? (({ status, attempt, maxAttempts, delayMs }) => {
    console.error(`OpenRouter returned HTTP ${status}; retrying in ${(delayMs / 1000).toFixed(1)}s (attempt ${attempt}/${maxAttempts})...`);
  });

  const maxAttempts = maxRetries + 1;
  let retries = 0;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let response: Response;
    let rawText: string;
    try {
      response = await transport(ENDPOINT, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body,
        redirect: 'error',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      rawText = await response.text();
    } catch {
      throw new Error('OpenRouter request failed or timed out');
    }
    if (rawText.includes(key)) {
      writeFileSync(responsePath, rawText.replaceAll(key, '[redacted]'), { mode: 0o600 });
      throw new Error('OpenRouter response contained credential material');
    }
    writeFileSync(responsePath, rawText, { mode: 0o600 });
    if (response.ok) {
      try {
        return { raw: JSON.parse(rawText), retries };
      } catch {
        throw new Error('OpenRouter returned invalid JSON');
      }
    }
    if (!RETRYABLE_HTTP_STATUSES.has(response.status)) {
      throw new Error(`OpenRouter returned HTTP ${response.status}`);
    }
    if (attempt === maxAttempts) {
      throw new Error(`OpenRouter returned HTTP ${response.status} after ${maxAttempts} attempts`);
    }
    const delayMs = computeRetryDelayMs(
      attempt - 1,
      response.headers.get('retry-after'),
      baseDelayMs,
      maxDelayMs,
      maxRetryAfterMs,
      random,
      now,
    );
    retries += 1;
    onRetry({ status: response.status, attempt: attempt + 1, maxAttempts, delayMs });
    await sleep(delayMs);
  }

  throw new Error('OpenRouter request failed');
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

/** Score a production module, per-file scan, or project structure manifest through OpenRouter's Decisions API. */
export async function runDecisionJudge(
  options: JudgeRunOptions,
  transport: typeof fetch = fetch,
  retry: RetryOptions = {},
): Promise<JudgeResult> {
  nonempty(options.model, 'model');
  const key = options.dryRun ? '' : process.env.OPENROUTER_API_KEY?.trim() ?? '';
  if (!options.dryRun && !key) {
    throw new Error('Set OPENROUTER_API_KEY before judging (or pass --backend codex / --backend claude)');
  }

  if (options.mode === 'file') {
    return runPerFileJudge(
      options,
      'openrouter',
      PASS_THRESHOLD,
      DEFAULT_OPENROUTER_CONCURRENCY,
      async (_request, body, fileDir) => {
        const { raw, retries } = await postDecisions(body, key, join(fileDir, 'response.txt'), transport, retry);
        const judged = readAnswers(raw, options.rubric.questions);
        return { ...judged, retries };
      },
    );
  }

  const { out, body, result } = prepareJudgeRun(options, 'openrouter', PASS_THRESHOLD);

  if (!options.dryRun) {
    try {
      const { raw, retries } = await postDecisions(body, key, join(out, 'response.txt'), transport, retry);
      const judged = readAnswers(raw, options.rubric.questions);
      if (retries > 0) result.retries = retries;
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
