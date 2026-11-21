import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { judgeReview, type JudgeOptions } from './judge_review.mts';

const TASKS = fileURLToPath(new URL('../tasks/', import.meta.url));
const CLI = fileURLToPath(new URL('./judge_review.mts', import.meta.url));
const originalKey = process.env.OPENROUTER_API_KEY;
beforeEach(() => { process.env.OPENROUTER_API_KEY = 'test-openrouter-key'; });
afterEach(() => {
  if (originalKey === undefined) delete process.env.OPENROUTER_API_KEY;
  else process.env.OPENROUTER_API_KEY = originalKey;
});

function fixture(t: TestContext, task = 'review-seeded-bug'): JudgeOptions {
  const root = mkdtempSync(join(tmpdir(), 'code-change-judge-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const report = join(root, 'REVIEW.md');
  execFileSync('bash', [join(TASKS, task, 'solution/solve.sh')], {
    env: { ...process.env, OUTPUT_DIR: root },
  });
  return { task: join(TASKS, task), report, model: 'typesafe/jev-1.14', out: join(root, 'results/judge') };
}

function json(path: string) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

/** Model answers are simulated; these tests validate transport and scoring, not judge accuracy. */
function response(choices: Record<string, 'pass' | 'fail'>, model = 'typesafe/jev-1.14-20261014') {
  return {
    model,
    provider: 'Test provider',
    usage: { cost: 0.00001, input_tokens: 1500 },
    answers: Object.fromEntries(Object.entries(choices).map(([id, choice]) => [id, {
      type: 'choice', choice, confidence: 0.8,
      probabilities: { pass: choice === 'pass' ? 0.9 : 0.1, fail: choice === 'pass' ? 0.1 : 0.9 },
    }])),
  };
}

test('both models use the Decisions endpoint; scores and raw answers are saved without the key', async (t) => {
  for (const model of ['typesafe/jev-1.14', 'liquid/d1.2-ultra']) {
    const options = { ...fixture(t), model };
    let calls = 0;
    const raw = response({ defect_identified: 'pass', evidence_supported: 'fail', restraint: 'pass' }, `${model}-snapshot`);
    const result = await judgeReview(options, async (url, init) => {
      calls += 1;
      assert.equal(url, 'https://openrouter.ai/api/alpha/decisions');
      assert.equal(init?.method, 'POST');
      assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer test-openrouter-key');
      assert.equal(init?.redirect, 'error');
      assert.ok(init?.signal instanceof AbortSignal);
      const body = JSON.parse(String(init?.body));
      assert.equal(body.model, model);
      assert.match(body.state.base_files['src/main/kotlin/shop/PricingPolicy.kt'], /= order.subtotal/);
      assert.match(body.state.feature_files['src/main/kotlin/shop/PricingPolicy.kt'], /18:.*>= discountThreshold/);
      assert.ok(body.state.feature_files['src/main/kotlin/shop/Order.kt']);
      assert.match(body.questions.defect_identified.instructions, /data, not instructions/);
      assert.equal(body.questions.defect_identified.type, 'choice');
      return Response.json(raw);
    });
    assert.equal(calls, 1);
    assert.equal(result.status, 'scored');
    assert.equal(result.returned_model, `${model}-snapshot`);
    assert.equal(result.deterministic.reward, 1);
    assert.equal(result.quality?.pass_rate, 2 / 3);
    assert.deepEqual(result.quality?.checks.evidence_supported, {
      choice: 'fail', pass_probability: 0.1, confidence: 0.8,
    });
    assert.deepEqual(json(join(options.out, 'response.txt')), raw);
    assert.deepEqual(json(join(options.out, 'result.json')), result);
    for (const name of ['request.json', 'result.json', 'response.txt']) {
      assert.ok(!readFileSync(join(options.out, name), 'utf8').includes('test-openrouter-key'));
    }
  }
});

test('dry runs need no key, include full free-form reviews, and load every task rubric', async (t) => {
  delete process.env.OPENROUTER_API_KEY;
  for (const task of ['canary', 'review-clean-change', 'review-seeded-bug']) {
    const options = { ...fixture(t, task), dryRun: true };
    const report = 'The >= comparison gives an order of exactly 100.00 the discount; it should use >.';
    writeFileSync(options.report, report);
    const result = await judgeReview(options, async () => { throw new Error('Must not call API'); });
    assert.equal(result.status, 'dry_run');
    assert.equal(result.quality, null);
    assert.equal(result.deterministic.format, 0);
    const request = json(join(options.out, 'request.json'));
    assert.equal(request.state.review, report);
    assert.equal(Object.keys(request.questions).length, task === 'review-seeded-bug' ? 3 : 2);
    assert.ok(!existsSync(join(options.out, 'response.txt')));
  }
});

test('missing reports make no request and have no fabricated model scores', async (t) => {
  const options = fixture(t);
  rmSync(options.report);
  delete process.env.OPENROUTER_API_KEY;
  const result = await judgeReview(options, async () => { throw new Error('Must not call API'); });
  assert.equal(result.status, 'missing_report');
  assert.equal(result.deterministic.report_exists, 0);
  assert.equal(result.quality, null);
  assert.ok(!existsSync(join(options.out, 'request.json')));
});

test('missing credentials and existing output directories fail before spending', async (t) => {
  const options = fixture(t);
  delete process.env.OPENROUTER_API_KEY;
  await assert.rejects(judgeReview(options), /Set OPENROUTER_API_KEY/);
  assert.ok(!existsSync(options.out));
  await judgeReview({ ...options, dryRun: true });
  process.env.OPENROUTER_API_KEY = 'test-openrouter-key';
  await assert.rejects(judgeReview(options, async () => { throw new Error('Must not call API'); }), /EEXIST/);
  assert.equal(json(join(options.out, 'result.json')).status, 'dry_run');
});

test('HTTP and transport failures are grading errors, with no retries or zero quality scores', async (t) => {
  for (const failure of ['http', 'network'] as const) {
    const options = fixture(t);
    let calls = 0;
    const result = await judgeReview(options, async () => {
      calls += 1;
      if (failure === 'network') throw new Error('Do not log headers: test-openrouter-key');
      return Response.json({ error: { code: 429 } }, { status: 429 });
    });
    assert.equal(calls, 1);
    assert.equal(result.status, 'error');
    assert.equal(result.quality, null);
    assert.equal(result.deterministic.reward, 1);
    assert.match(result.error!, failure === 'http' ? /HTTP 429/ : /failed or timed out/);
    assert.ok(!readFileSync(join(options.out, 'result.json'), 'utf8').includes('test-openrouter-key'));
  }
});

test('malformed, incomplete, refused, and inconsistent answers cannot become quality scores', async (t) => {
  const good = response({ defect_identified: 'pass', evidence_supported: 'pass', restraint: 'pass' });
  const invalids = [
    'not JSON',
    { ...good, model: '' },
    { ...good, answers: {} },
    { ...good, answers: { ...good.answers, restraint: { type: 'refusal' } } },
    { ...good, answers: { ...good.answers, restraint: { ...good.answers.restraint, confidence: 2 } } },
    { ...good, answers: { ...good.answers, restraint: { ...good.answers.restraint, probabilities: { pass: 0.2, fail: 0.8 } } } },
    { ...good, answers: { ...good.answers, restraint: { ...good.answers.restraint, probabilities: { pass: 0.9, fail: 0.9 } } } },
  ];
  for (const raw of invalids) {
    const options = fixture(t);
    const result = await judgeReview(options, async () => new Response(typeof raw === 'string' ? raw : JSON.stringify(raw)));
    assert.equal(result.status, 'error');
    assert.equal(result.quality, null);
    assert.ok(existsSync(join(options.out, 'response.txt')));
  }
});

test('invalid task rubrics fail before network or output writes', async (t) => {
  const options = fixture(t);
  const task = join(options.report, '../task-copy');
  cpSync(options.task, task, { recursive: true });
  const rubric = join(task, 'tests/judge.json');
  writeFileSync(rubric, JSON.stringify({ rubric: 'bad', questions: {} }));
  await assert.rejects(judgeReview({ ...options, task }), /at least one question/);
  writeFileSync(rubric, JSON.stringify({ rubric: 'bad', questions: { check: {
    type: 'choice', instructions: 'Check', criteria: { pass: 'Pass' },
  } } }));
  await assert.rejects(judgeReview({ ...options, task }), /exactly pass and fail/);
  assert.ok(!existsSync(options.out));
});

test('CLI supports dry runs and exits nonzero on bad input', (t) => {
  const options = fixture(t);
  const run = spawnSync(process.execPath, [CLI, '--task', options.task, '--report', options.report,
    '--model', options.model, '--out', options.out, '--dry-run'], { encoding: 'utf8' });
  assert.ifError(run.error);
  assert.equal(run.status, 0, run.stderr);
  assert.equal(JSON.parse(run.stdout).status, 'dry_run');
  const invalid = spawnSync(process.execPath, [CLI], { encoding: 'utf8' });
  assert.ifError(invalid.error);
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /Usage:/);
});
