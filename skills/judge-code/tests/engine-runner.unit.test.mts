import assert from 'node:assert/strict';
import test from 'node:test';
import { runDecisionJudge } from '../scripts/engine/openrouter.mts';
import { resolveUnifiedRubrics } from '../scripts/rubrics/resolver.mts';
import type { ResolvedRubric } from '../scripts/rubrics/types.mts';
import { findFileEntry, withTempOpenRouterKey } from './helpers/cli-harness.mts';

interface Stage1Call {
  model: string;
  file: string;
}

interface Stage2Call {
  model: string;
  isTest: boolean;
  file: string;
  questions: string[];
}

function createTwoThresholdRubric(): ResolvedRubric {
  const question = (instructions: string) => ({
    type: 'choice' as const,
    instructions,
    criteria: { pass: 'Y', fail: 'N' },
  });
  return {
    rubric: 'mixed-v1',
    target: 'production_code',
    questions: {
      lenient_check: question('Lenient?'),
      default_check: question('Default?'),
    },
    scopes: { lenient_check: 'file', default_check: 'file' },
    thresholds: { lenient_check: 0.7, default_check: 0.8 },
    groups: { mixed: ['lenient_check', 'default_check'] },
    excluded: [],
    skippedModuleChecks: [],
  };
}

function createStage1And2MockFetch() {
  const stage1Calls: Stage1Call[] = [];
  const stage2Calls: Stage2Call[] = [];

  const transport = (async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as {
      model: string;
      state: { file_path?: string; production_files?: Record<string, string>; test_files?: Record<string, string> };
      questions: Record<string, unknown>;
    };
    if (body.questions.test_kind) {
      const filePath = body.state.file_path ?? '';
      stage1Calls.push({ model: body.model, file: filePath });
      const kind = filePath.includes('helper') || filePath.includes('driver')
        ? 'test_support'
        : filePath.includes('checkout')
          ? 'e2e_browser'
          : 'unit';
      const probs = { unit: 0, integration: 0, e2e_browser: 0, test_support: 0, other: 0, [kind]: 1 };
      return Response.json({ model: body.model, answers: { test_kind: { type: 'choice', choice: kind, probabilities: probs } } });
    }
    const isTest = body.state.test_files !== undefined;
    const file = Object.keys(isTest ? body.state.test_files! : body.state.production_files!)[0];
    const questionIds = Object.keys(body.questions).sort();
    stage2Calls.push({ model: body.model, isTest, file, questions: questionIds });
    const answers = Object.fromEntries(questionIds.map((id) => {
      const fail = file === 'e2e/checkout.spec.ts' && id === 'playwright_web_first_and_race_free';
      return [id, { type: 'choice', choice: fail ? 'fail' : 'pass', probabilities: { pass: fail ? 0.12 : 0.94, fail: fail ? 0.88 : 0.06 } }];
    }));
    return Response.json({ model: body.model, answers });
  }) as typeof fetch;

  return { transport, stage1Calls, stage2Calls };
}

test('runDecisionJudge retries HTTP 429 and 503 with exponential backoff and Retry-After header', async (t) => {
  withTempOpenRouterKey(t);
  const rubric = createTwoThresholdRubric();
  const sleeps: number[] = [];
  let attempts = 0;

  const result = await runDecisionJudge(
    { mode: 'code', files: { 'a.ts': 'export const a = 1;\n' }, rubric, model: 'liquid/d1.2-ultra' },
    async () => {
      attempts += 1;
      if (attempts === 1) return new Response('rate limit', { status: 429 });
      if (attempts === 2) return new Response('unavailable', { status: 503, headers: { 'Retry-After': '7' } });
      return Response.json({
        model: 'mock-retry',
        answers: {
          lenient_check: { type: 'choice', choice: 'pass', probabilities: { pass: 0.9, fail: 0.1 } },
          default_check: { type: 'choice', choice: 'pass', probabilities: { pass: 0.9, fail: 0.1 } },
        },
      });
    },
    { sleep: async (ms) => { sleeps.push(ms); }, random: () => 0.5, onRetry: () => {} },
  );

  assert.equal(attempts, 3);
  assert.deepEqual(sleeps, [4_000, 7_000]);
  assert.equal(result.retries, 2);
  assert.equal(result.status, 'scored');
});

test('runDecisionJudge evaluates per-criterion thresholds independently for the same score', async (t) => {
  withTempOpenRouterKey(t);
  const rubric = createTwoThresholdRubric();

  const result = await runDecisionJudge(
    { mode: 'code', files: { 'a.ts': 'export const a = 1;\n' }, rubric, model: 'liquid/d1.2-ultra' },
    async () => Response.json({
      model: 'mock-thresholds',
      answers: {
        lenient_check: { type: 'choice', choice: 'pass', probabilities: { pass: 0.72, fail: 0.28 } },
        default_check: { type: 'choice', choice: 'pass', probabilities: { pass: 0.72, fail: 0.28 } },
      },
    }),
  );

  assert.equal(result.quality?.checks.lenient_check.choice, 'pass');
  assert.equal(result.quality?.checks.default_check.choice, 'fail');
  assert.equal(result.quality?.checks.default_check.severity, 'warning');
});

test('runDecisionJudge caps concurrent per-file requests and returns sorted file results', async (t) => {
  withTempOpenRouterKey(t);
  const rubric = createTwoThresholdRubric();
  let inFlight = 0;
  let peakInFlight = 0;

  const result = await runDecisionJudge(
    {
      mode: 'file',
      files: { 'z.ts': 'export const z = 1;\n', 'a.ts': 'export const a = 1;\n', 'm.ts': 'export const m = 1;\n', 'b.ts': 'export const b = 1;\n', 'c.ts': 'export const c = 1;\n' },
      rubric,
      model: 'typesafe/jev-1.14',
      concurrency: 2,
    },
    async (_url, init) => {
      inFlight += 1;
      peakInFlight = Math.max(peakInFlight, inFlight);
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 15));
      inFlight -= 1;
      const body = JSON.parse(String(init?.body)) as { state: { production_files: Record<string, string> } };
      const passProb = Object.keys(body.state.production_files)[0] === 'm.ts' ? 0.35 : 0.9;
      return Response.json({
        model: 'mock-concurrent',
        answers: {
          lenient_check: { type: 'choice', choice: 'pass', probabilities: { pass: 0.9, fail: 0.1 } },
          default_check: { type: 'choice', choice: passProb >= 0.5 ? 'pass' : 'fail', probabilities: { pass: passProb, fail: Number((1 - passProb).toFixed(4)) } },
        },
      });
    },
  );

  assert.equal(peakInFlight, 2);
  assert.deepEqual(result.file_results?.map((f) => f.file), ['a.ts', 'b.ts', 'c.ts', 'm.ts', 'z.ts']);
  assert.equal(result.quality?.checks.default_check.files_errors, 1);
});

test('runDecisionJudge classifies test files on Stage 1 jev-1.14 even when Stage 2 uses a deep model', async (t) => {
  withTempOpenRouterKey(t);
  const { transport, stage1Calls, stage2Calls } = createStage1And2MockFetch();
  const unified = resolveUnifiedRubrics({ mode: 'file', hasRequirements: false, hasConventions: false });

  await runDecisionJudge(
    {
      mode: 'file',
      files: { 'src/calc.ts': 'export const add = (a: number, b: number) => a + b;\n' },
      testFiles: {
        'e2e/checkout.spec.ts': "import { test } from '@playwright/test';\ntest('pay', async ({ page }) => { await page.goto('/'); });\n",
      },
      rubric: unified.production!,
      testRubric: unified.test,
      explicitTestSelection: false,
      model: 'liquid/d1.2-ultra',
    },
    transport,
  );

  assert.deepEqual(stage1Calls, [{ model: 'typesafe/jev-1.14', file: 'e2e/checkout.spec.ts' }]);
  assert.deepEqual(stage2Calls.map((req) => req.model), ['liquid/d1.2-ultra', 'liquid/d1.2-ultra']);
});

test('runDecisionJudge routes Playwright support helpers to Playwright helper checks only', async (t) => {
  withTempOpenRouterKey(t);
  const { transport, stage2Calls } = createStage1And2MockFetch();
  const unified = resolveUnifiedRubrics({ mode: 'file', hasRequirements: false, hasConventions: false });

  await runDecisionJudge(
    {
      mode: 'file',
      files: {},
      testFiles: { 'e2e/driver.ts': "import { expect } from '@playwright/test';\nexport const ok = expect;\n" },
      rubric: unified.production!,
      testRubric: unified.test,
      explicitTestSelection: false,
      model: 'typesafe/jev-1.14',
    },
    transport,
  );

  assert.deepEqual(
    stage2Calls.find((req) => req.file === 'e2e/driver.ts')?.questions,
    ['playwright_strict_scoped_locators', 'playwright_web_first_and_race_free'],
  );
});

test('runDecisionJudge skips non-Playwright support files and playwright.config in file mode with zero Stage 2 calls', async (t) => {
  withTempOpenRouterKey(t);
  const { transport, stage1Calls, stage2Calls } = createStage1And2MockFetch();
  const unified = resolveUnifiedRubrics({ mode: 'file', hasRequirements: false, hasConventions: false });

  const result = await runDecisionJudge(
    {
      mode: 'file',
      files: {},
      testFiles: {
        'tests/helper.ts': 'export const factory = () => ({});\n',
        'playwright.config.ts': "import { defineConfig } from '@playwright/test';\nexport default defineConfig({});\n",
      },
      rubric: unified.production!,
      testRubric: unified.test,
      explicitTestSelection: false,
      model: 'typesafe/jev-1.14',
    },
    transport,
  );

  assert.deepEqual(stage1Calls.map((req) => req.file), ['tests/helper.ts']);
  assert.deepEqual(stage2Calls, []);
  assert.equal(findFileEntry(result, 'tests/helper.ts').status, 'skipped');
  assert.equal(findFileEntry(result, 'tests/helper.ts').skip_reason, 'not_applicable');
  assert.equal(findFileEntry(result, 'playwright.config.ts').status, 'skipped');
});
