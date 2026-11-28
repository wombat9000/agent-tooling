import { writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { isPlaywrightConfigFilename } from '../inputs/classify-path.mts';
import {
  classifyTestFile,
  previewTestBundleRubric,
  previewTestFileRubric,
  type PlaywrightDetectionContext,
} from '../rubrics/classifier.mts';
import { filterRubricForFiles } from '../rubrics/applicability.mts';
import {
  PASS_THRESHOLD,
  nonempty,
  object,
  type ChoiceQuestion,
  type ResolvedRubric,
} from '../rubrics/types.mts';
import { dispatchJudgeRun } from './run-module.mts';
import { resolvePartitionRubrics } from './run-shared.mts';
import { probabilityToScore } from './scoring.mts';
import {
  DEFAULT_OPENROUTER_CONCURRENCY,
  DEFAULT_PASS_SCORE,
  ENDPOINT,
  ERROR_SCORE_THRESHOLD,
  type FindingSeverity,
  type JudgeResult,
  type JudgeRunOptions,
  type Judgment,
  type RetryOptions,
  type ScoreRequestFn,
  type TestClassifierFn,
} from './types.mts';

const REQUEST_TIMEOUT_MS = 60_000;
const PROBABILITY_SUM_TOLERANCE = 0.001;
const ERROR_PROBABILITY_CUTOFF = ERROR_SCORE_THRESHOLD / 100;

export const RETRYABLE_HTTP_STATUSES = new Set([429, 502, 503, 504]);
export const DEFAULT_MAX_RETRIES = 4;
export const DEFAULT_BASE_DELAY_MS = 4_000;
export const DEFAULT_MAX_DELAY_MS = 30_000;
export const DEFAULT_MAX_RETRY_AFTER_MS = 60_000;

interface ResolvedRetryPolicy {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  maxRetryAfterMs: number;
  sleep: (ms: number) => Promise<void>;
  random: () => number;
  now: () => number;
  onRetry: (info: { status: number; attempt: number; maxAttempts: number; delayMs: number }) => void;
}

interface DecisionsPostParams {
  body: string;
  key: string;
  responsePath?: string;
  transport: typeof fetch;
  retry: RetryOptions;
}

interface HttpAttemptOutcome {
  ok: boolean;
  status: number;
  retryAfterHeader: string | null;
  rawText: string;
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
    return Number.isFinite(seconds) && seconds >= 0
      ? Math.min(Math.round(seconds * 1000), maxRetryAfterMs)
      : null;
  }
  const parsedDate = Date.parse(trimmed);
  return Number.isFinite(parsedDate)
    ? Math.min(Math.max(0, parsedDate - nowMs), maxRetryAfterMs)
    : null;
}

function resolveRetryPolicy(retry: RetryOptions): ResolvedRetryPolicy {
  return {
    maxAttempts: (retry.maxRetries ?? DEFAULT_MAX_RETRIES) + 1,
    baseDelayMs: retry.baseDelayMs ?? DEFAULT_BASE_DELAY_MS,
    maxDelayMs: retry.maxDelayMs ?? DEFAULT_MAX_DELAY_MS,
    maxRetryAfterMs: retry.maxRetryAfterMs ?? DEFAULT_MAX_RETRY_AFTER_MS,
    sleep: retry.sleep ?? ((ms: number) => new Promise<void>((resolveDelay) => setTimeout(resolveDelay, ms))),
    random: retry.random ?? Math.random,
    now: retry.now ?? Date.now,
    onRetry: retry.onRetry ?? (({ status, attempt, maxAttempts, delayMs }) => {
      console.error(`OpenRouter returned HTTP ${status}; retrying in ${(delayMs / 1000).toFixed(1)}s (attempt ${attempt}/${maxAttempts})...`);
    }),
  };
}

function computeRetryDelayMs(
  retryIndex: number,
  retryAfterHeader: string | null,
  policy: ResolvedRetryPolicy,
): number {
  const retryAfterMs = parseRetryAfterMs(retryAfterHeader, policy.now(), policy.maxRetryAfterMs);
  if (retryAfterMs !== null) return retryAfterMs;
  const exponential = Math.min(policy.maxDelayMs, policy.baseDelayMs * (2 ** retryIndex));
  const jitterFactor = 0.75 + policy.random() * 0.5;
  return Math.min(policy.maxDelayMs, Math.max(0, Math.round(exponential * jitterFactor)));
}

function extractRawErrorMessage(parsed: Record<string, unknown>): string | null {
  const errorField = parsed.error;
  if (errorField && typeof errorField === 'object' && !Array.isArray(errorField)) {
    const nested = (errorField as Record<string, unknown>).message;
    if (typeof nested === 'string') return nested;
  }
  if (typeof errorField === 'string') return errorField;
  return typeof parsed.message === 'string' ? parsed.message : null;
}

function extractErrorDetail(rawText: string): string | null {
  try {
    const rawMsg = extractRawErrorMessage(JSON.parse(rawText) as Record<string, unknown>);
    if (!rawMsg) return null;
    const cleaned = rawMsg.replace(/\s+/g, ' ').trim();
    if (!cleaned) return null;
    return cleaned.length > 200 ? `${cleaned.slice(0, 197)}...` : cleaned;
  } catch {
    return null;
  }
}

async function sendOpenRouterAttempt(
  transport: typeof fetch,
  key: string,
  body: string,
): Promise<HttpAttemptOutcome> {
  try {
    const response = await transport(ENDPOINT, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body,
      redirect: 'error',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const rawText = await response.text();
    return {
      ok: response.ok,
      status: response.status,
      retryAfterHeader: response.headers.get('retry-after'),
      rawText,
    };
  } catch {
    throw new Error('OpenRouter request failed or timed out');
  }
}

function saveAndVerifyResponseText(rawText: string, key: string, responsePath?: string): void {
  if (rawText.includes(key)) {
    if (responsePath !== undefined) {
      writeFileSync(responsePath, rawText.replaceAll(key, '[redacted]'), { mode: 0o600 });
    }
    throw new Error('OpenRouter response contained credential material');
  }
  if (responsePath !== undefined) {
    writeFileSync(responsePath, rawText, { mode: 0o600 });
  }
}

function assertRetryableOrThrow(outcome: HttpAttemptOutcome, attempt: number, maxAttempts: number): void {
  const detail = extractErrorDetail(outcome.rawText);
  const detailSuffix = detail ? `: ${detail}` : '';
  if (!RETRYABLE_HTTP_STATUSES.has(outcome.status)) {
    throw new Error(`OpenRouter returned HTTP ${outcome.status}${detailSuffix}`);
  }
  if (attempt === maxAttempts) {
    throw new Error(`OpenRouter returned HTTP ${outcome.status} after ${maxAttempts} attempts${detailSuffix}`);
  }
}

async function postDecisions(params: DecisionsPostParams): Promise<{ raw: unknown; retries: number }> {
  const policy = resolveRetryPolicy(params.retry);
  let retries = 0;

  for (let attempt = 1; attempt <= policy.maxAttempts; attempt += 1) {
    const outcome = await sendOpenRouterAttempt(params.transport, params.key, params.body);
    saveAndVerifyResponseText(outcome.rawText, params.key, params.responsePath);

    if (outcome.ok) {
      try {
        return { raw: JSON.parse(outcome.rawText), retries };
      } catch {
        throw new Error('OpenRouter returned invalid JSON');
      }
    }

    assertRetryableOrThrow(outcome, attempt, policy.maxAttempts);
    const delayMs = computeRetryDelayMs(attempt - 1, outcome.retryAfterHeader, policy);
    retries += 1;
    policy.onRetry({ status: outcome.status, attempt: attempt + 1, maxAttempts: policy.maxAttempts, delayMs });
    await policy.sleep(delayMs);
  }

  throw new Error('OpenRouter request failed');
}

function probability(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${label} must be a number from 0 to 1`);
  }
  return value;
}

function hasConsistentChoiceProbabilities(
  probabilities: Record<string, unknown>,
  choice: 'pass' | 'fail',
  scores: { pass: number; fail: number },
): boolean {
  const hasOnlyPassAndFail = Object.keys(probabilities).sort().join(',') === 'fail,pass';
  const sumsToOne = Math.abs(scores.pass + scores.fail - 1) <= PROBABILITY_SUM_TOLERANCE;
  const matchesSelectedChoice = choice === 'pass' ? scores.pass >= scores.fail : scores.fail >= scores.pass;
  return hasOnlyPassAndFail && sumsToOne && matchesSelectedChoice;
}

function parseSingleDecisionAnswer(id: string, rawAnswer: unknown, rawThreshold: number): Judgment {
  const answer = object(rawAnswer, `Answer ${id}`);
  if (answer.type !== 'choice' || (answer.choice !== 'pass' && answer.choice !== 'fail')) {
    throw new Error(`Answer ${id} must choose pass or fail`);
  }
  const probabilities = object(answer.probabilities, `${id}.probabilities`);
  const pass = probability(probabilities.pass, `${id}.pass`);
  const fail = probability(probabilities.fail, `${id}.fail`);
  if (!hasConsistentChoiceProbabilities(probabilities, answer.choice, { pass, fail })) {
    throw new Error(`Answer ${id} has inconsistent probabilities`);
  }

  const scoreThreshold = probabilityToScore(rawThreshold);
  const passedThreshold = pass >= rawThreshold;
  const severity: FindingSeverity | undefined = passedThreshold
    ? undefined
    : (pass < ERROR_PROBABILITY_CUTOFF ? 'error' : 'warning');

  return {
    choice: passedThreshold ? 'pass' : 'fail',
    ...(severity ? { severity } : {}),
    model_choice: answer.choice,
    score: probabilityToScore(pass, [ERROR_SCORE_THRESHOLD, scoreThreshold]),
    ...(scoreThreshold !== DEFAULT_PASS_SCORE ? { pass_threshold: scoreThreshold } : {}),
  };
}

/** Validate every required answer before producing any quality scores. */
export function readAnswers(
  raw: unknown,
  questions: Record<string, ChoiceQuestion>,
  thresholds?: Record<string, number>,
): { model: string; checks: Record<string, Judgment> } {
  const response = object(raw, 'OpenRouter response');
  const model = nonempty(response.model, 'Returned model');
  const answers = object(response.answers, 'answers');
  const checks = Object.fromEntries(
    Object.keys(questions).map((id) => [
      id,
      parseSingleDecisionAnswer(id, answers[id], thresholds?.[id] ?? PASS_THRESHOLD),
    ]),
  );
  return { model, checks };
}

function rubricMatchesAnyFiles(
  rubric: ResolvedRubric | undefined,
  files: Record<string, string>,
  context?: PlaywrightDetectionContext,
): boolean {
  if (!rubric || Object.keys(files).length === 0) return false;
  return Object.keys(filterRubricForFiles(rubric, files, context).questions).length > 0;
}

function hasApplicableTestFiles(params: {
  testRubric?: ResolvedRubric;
  testFiles: Record<string, string>;
  explicitTestSelection: boolean;
  perFile: boolean;
  filePaths?: Record<string, string>;
  repoRoot?: string;
}): boolean {
  const { testRubric, testFiles, explicitTestSelection, perFile, filePaths, repoRoot } = params;
  if (!testRubric || Object.keys(testFiles).length === 0) return false;
  const bundleContext: PlaywrightDetectionContext = { bundleFiles: testFiles, filePaths, repoRoot };
  if (perFile) {
    return Object.entries(testFiles).some(([filePath, content]) => {
      const fileCtx: PlaywrightDetectionContext = { ...bundleContext, absPath: filePaths?.[filePath] };
      if (explicitTestSelection) {
        if (isPlaywrightConfigFilename(basename(filePath)) && testRubric.playwrightConfigRubric) return true;
        return Object.keys(filterRubricForFiles(testRubric, { [filePath]: content }, fileCtx).questions).length > 0;
      }
      return Object.keys(previewTestFileRubric({ filePath, content }, testRubric, fileCtx).rubric.questions).length > 0;
    });
  }
  return explicitTestSelection
    ? Object.keys(filterRubricForFiles(testRubric, testFiles, bundleContext).questions).length > 0
    : Object.keys(previewTestBundleRubric(testFiles, testRubric, bundleContext).questions).length > 0;
}

function hasAnyApplicableRequest(options: JudgeRunOptions): boolean {
  if (options.rubric.target === 'project_structure') return true;
  const { isUnified, prodRubric, testRubric } = resolvePartitionRubrics(options);
  const explicitTestSelection = Boolean(options.explicitTestSelection);
  const activeProdRubric = isUnified ? prodRubric : options.rubric;

  if (options.mode === 'file') {
    const prodMatch = activeProdRubric !== undefined && Object.entries(options.files ?? {}).some(
      ([file, content]) => rubricMatchesAnyFiles(activeProdRubric, { [file]: content }, {
        absPath: options.filePaths?.[file],
        bundleFiles: options.files,
        filePaths: options.filePaths,
        repoRoot: options.repoRoot,
      }),
    );
    return prodMatch || (isUnified && hasApplicableTestFiles({
      testRubric,
      testFiles: options.testFiles ?? {},
      explicitTestSelection,
      perFile: true,
      filePaths: options.filePaths,
      repoRoot: options.repoRoot,
    }));
  }

  const bundles = options.modules && options.modules.length > 0
    ? options.modules.map((mod) => ({
      files: mod.files,
      testFiles: mod.testFiles ?? {},
      filePaths: mod.filePaths,
    }))
    : [{ files: options.files ?? {}, testFiles: options.testFiles ?? {}, filePaths: options.filePaths }];

  return bundles.some((bundle) => (
    rubricMatchesAnyFiles(activeProdRubric, bundle.files, {
      bundleFiles: bundle.files,
      filePaths: bundle.filePaths,
      repoRoot: options.repoRoot,
    })
    || (isUnified && hasApplicableTestFiles({
      testRubric,
      testFiles: bundle.testFiles,
      explicitTestSelection,
      perFile: false,
      filePaths: bundle.filePaths,
      repoRoot: options.repoRoot,
    }))
  ));
}

/** Score a file scan, module bundle(s), or project structure manifest through OpenRouter's Decisions API. */
export async function runDecisionJudge(
  options: JudgeRunOptions,
  transport: typeof fetch = fetch,
  retry: RetryOptions = {},
): Promise<JudgeResult> {
  nonempty(options.model, 'model');
  const needsApiCall = !options.dryRun && hasAnyApplicableRequest(options);
  const key = needsApiCall ? process.env.OPENROUTER_API_KEY?.trim() ?? '' : '';
  if (needsApiCall && !key) {
    throw new Error('Set OPENROUTER_API_KEY before judging (or pass --backend codex / --backend claude)');
  }

  const { candidateRubric } = resolvePartitionRubrics(options);
  const candidateThresholds = candidateRubric.playwrightConfigRubric
    ? { ...candidateRubric.playwrightConfigRubric.thresholds, ...candidateRubric.thresholds }
    : candidateRubric.thresholds;
  const scoreRequest: ScoreRequestFn = async (request, body, artifactDir) => {
    const responsePath = artifactDir !== undefined ? join(artifactDir, 'response.txt') : undefined;
    const { raw, retries } = await postDecisions({ body, key, responsePath, transport, retry });
    const judged = readAnswers(raw, request.questions, candidateThresholds);
    return { ...judged, retries };
  };
  const classifyTest: TestClassifierFn = (filePath, content, detectionContext) =>
    classifyTestFile({
      filePath,
      content,
      detectionContext,
      invokeOpenRouter: (body) => postDecisions({ body, key, transport, retry }),
    });

  return dispatchJudgeRun(options, {
    backend: 'openrouter',
    passThreshold: DEFAULT_PASS_SCORE,
    defaultConcurrency: DEFAULT_OPENROUTER_CONCURRENCY,
    scoreRequest,
    classifyTest,
  });
}
