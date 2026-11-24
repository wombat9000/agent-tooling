import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { judgeCode, judgeTests } from './judge_code.mts';
import { writeHtmlReport } from './html_report.mts';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const MARS_ROVER = join(ROOT, 'evals/code-change/tasks/implement-mars-rover');

function sampleSources(t: TestContext): { root: string; src: string; rewardPath: string } {
  const root = mkdtempSync(join(tmpdir(), 'code-change-judge-code-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const src = join(root, 'src/main/kotlin/rover');
  mkdirSync(src, { recursive: true });
  writeFileSync(join(src, 'Direction.kt'), 'package rover\nenum class Direction { NORTH, EAST, SOUTH, WEST }\n');
  writeFileSync(join(src, 'Rover.kt'), 'package rover\nclass Rover(var x: Int)\n');
  writeFileSync(join(src, 'README.txt'), 'ignored\n');
  const rewardPath = join(root, 'reward.json');
  writeFileSync(rewardPath, JSON.stringify({ has_production_code: 1, has_tests: 1, tests_pass: 1, reward: 1 }));
  return { root, src: join(root, 'src/main/kotlin'), rewardPath };
}

function decisionResponse(model: string, passMap: Record<string, boolean>) {
  const answers = Object.fromEntries(Object.entries(passMap).map(([id, pass]) => [id, {
    type: 'choice',
    choice: pass ? 'pass' : 'fail',
    probabilities: pass ? { pass: 0.9, fail: 0.1 } : { pass: 0.2, fail: 0.8 },
    confidence: 0.85,
  }]));
  return new Response(JSON.stringify({ model, answers }), { status: 200 });
}

test('whole mode sends all production .kt files in one request and loads verifier reward', async (t) => {
  const { root, src, rewardPath } = sampleSources(t);
  const requests: Array<{ state: { scope: string; production_files: Record<string, string> }; questions: Record<string, unknown> }> = [];
  const prevKey = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = 'test-key';
  t.after(() => { if (prevKey === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = prevKey; });

  const out = join(root, 'whole');
  const result = await judgeCode({ task: MARS_ROVER, sourceDir: src, model: 'liquid/d1.2-ultra', out, scope: 'whole', rewardPath }, (async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    requests.push(body);
    return decisionResponse('liquid/d1.2-ultra-snap', Object.fromEntries(Object.keys(body.questions).map((id) => [id, id !== 'immutable_state'])));
  }) as typeof fetch);

  assert.equal(requests.length, 1);
  assert.equal(requests[0].state.scope, 'whole');
  assert.deepEqual(Object.keys(requests[0].state.production_files), ['rover/Direction.kt', 'rover/Rover.kt']);
  assert.equal(result.status, 'scored');
  assert.equal(result.file_count, 2);
  assert.equal(result.deterministic.reward, 1);
  assert.equal(result.quality?.checks.immutable_state.choice, 'fail');
  assert.equal(result.quality?.checks.direct_readability.choice, 'pass');
  assert.equal(result.quality?.pass_rate, 11 / 12);
  assert.deepEqual(Object.keys(result.rubric_groups ?? {}), ['domain-modelling', 'readability', 'module-design', 'solid']);

  const html = readFileSync(writeHtmlReport(out), 'utf8');
  assert.ok(html.includes('Production files (2)'));
  assert.ok(html.includes('rover/Direction.kt'));
  assert.ok(html.includes('class="matrix-controls"'));
  assert.ok(html.includes('<span class="group-name">SOLID</span>'));
});

test('per-file mode sends one request per .kt file with the same rubric and aggregates strictly', async (t) => {
  const { root, src, rewardPath } = sampleSources(t);
  const requests: Array<{ state: { scope: string; file_path: string; production_files: Record<string, string> }; questions: Record<string, unknown> }> = [];
  const prevKey = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = 'test-key';
  t.after(() => { if (prevKey === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = prevKey; });

  const out = join(root, 'per-file');
  const result = await judgeCode({ task: MARS_ROVER, sourceDir: src, model: 'liquid/d1.2-ultra', out, scope: 'per-file', rewardPath }, (async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    requests.push(body);
    const isRover = body.state.file_path === 'rover/Rover.kt';
    return decisionResponse('liquid/d1.2-ultra-snap', Object.fromEntries(
      Object.keys(body.questions).map((id) => [id, !(isRover && id === 'immutable_state')]),
    ));
  }) as typeof fetch);

  assert.equal(requests.length, 2);
  assert.deepEqual(requests.map((r) => r.state.file_path), ['rover/Direction.kt', 'rover/Rover.kt']);
  assert.deepEqual(requests[0].questions, requests[1].questions);
  assert.equal(result.status, 'scored');
  assert.equal(result.scope, 'per-file');
  assert.equal(result.file_results?.length, 2);
  // Direction.kt: 12/12, Rover.kt: 11/12 => mean file pass rate = 23/24
  assert.ok(Math.abs((result.quality?.pass_rate ?? 0) - 23 / 24) < 1e-9);
  // Strict aggregation: 11/12 checks passed in every file
  assert.ok(Math.abs((result.quality?.all_files_pass_rate ?? 0) - 11 / 12) < 1e-9);
  assert.equal(result.quality?.checks.immutable_state.choice, 'fail');
  assert.equal(result.quality?.checks.immutable_state.files_passed, 1);
  assert.equal(result.quality?.checks.immutable_state.files_total, 2);
  assert.equal(result.quality?.checks.immutable_state.min_pass_probability, 0.2);
  assert.equal(result.quality?.checks.direct_readability.choice, 'pass');
  assert.equal(result.quality?.checks.direct_readability.files_passed, 2);

  const html = readFileSync(writeHtmlReport(out), 'utf8');
  assert.ok(html.includes('Per-file scores'));
  assert.ok(html.includes('Files passed <strong>1/2</strong>'));
  assert.ok(html.includes('per-file'));
});

test('per-file mode stops on first API error and dry-run/missing make no API calls', async (t) => {
  const { root, src } = sampleSources(t);
  let calls = 0;
  const prevKey = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = 'test-key';
  t.after(() => { if (prevKey === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = prevKey; });

  const failed = await judgeCode({ task: MARS_ROVER, sourceDir: src, model: 'liquid/d1.2-ultra', out: join(root, 'err'), scope: 'per-file' }, (async () => {
    calls += 1;
    return new Response('{}', { status: 400 });
  }) as typeof fetch);
  assert.equal(calls, 1);
  assert.equal(failed.status, 'error');
  assert.equal(failed.quality, null);
  assert.deepEqual(failed.file_results?.map((f) => f.status), ['error', 'pending']);

  let retryCalls = 0;
  const sleeps: number[] = [];
  const recovered = await judgeCode(
    { task: MARS_ROVER, sourceDir: src, model: 'liquid/d1.2-ultra', out: join(root, 'recovered'), scope: 'whole' },
    (async (_url, init) => {
      retryCalls += 1;
      if (retryCalls === 1) return new Response('{}', { status: 429, headers: { 'Retry-After': '2' } });
      const body = JSON.parse(String(init?.body));
      return decisionResponse('liquid/d1.2-ultra-snap', Object.fromEntries(Object.keys(body.questions).map((id) => [id, true])));
    }) as typeof fetch,
    { sleep: async (ms) => { sleeps.push(ms); }, onRetry: () => {} },
  );
  assert.equal(retryCalls, 2);
  assert.deepEqual(sleeps, [2_000]);
  assert.equal(recovered.status, 'scored');
  assert.equal(recovered.quality?.pass_rate, 1);

  delete process.env.OPENROUTER_API_KEY;
  const dry = await judgeCode({ task: MARS_ROVER, sourceDir: src, model: 'liquid/d1.2-ultra', out: join(root, 'dry'), scope: 'per-file', dryRun: true });
  assert.equal(dry.status, 'dry_run');
  assert.ok(existsSync(join(root, 'dry/request.json')));
  assert.equal(dry.file_results?.length, 2);
  assert.ok(dry.file_results?.every((f) => f.status === 'dry_run' && existsSync(join(f.result_dir, 'request.json'))));

  const empty = join(root, 'empty');
  mkdirSync(empty);
  const missing = await judgeCode({ task: MARS_ROVER, sourceDir: empty, model: 'liquid/d1.2-ultra', out: join(root, 'missing'), scope: 'whole' });
  assert.equal(missing.status, 'missing_report');
  assert.equal(missing.quality, null);
});

test('shared skill rubrics compose via extends and reject invalid, duplicate, or conflicting configs', async (t) => {
  const { parseRubric, taskTarget } = await import('./judge_review.mts');
  assert.equal(taskTarget(MARS_ROVER), 'production_code');
  const resolved = parseRubric(MARS_ROVER, '');
  assert.equal(resolved.rubric, 'domain-modelling-v3+readability-v2+module-design-v2+solid-v3');
  assert.equal(resolved.target, 'production_code');
  assert.equal(Object.keys(resolved.questions).length, 12);
  assert.ok(resolved.questions.single_responsibility);
  assert.ok(resolved.questions.dependency_inversion);
  assert.deepEqual(resolved.groups, {
    'domain-modelling': ['immutable_state', 'domain_invariants', 'boundary_separation'],
    readability: ['direct_readability', 'named_domain_expressions'],
    'module-design': ['modular_organization', 'no_unnecessary_abstraction'],
    solid: ['single_responsibility', 'open_closed', 'liskov_substitution', 'interface_segregation', 'dependency_inversion'],
  });

  const root = mkdtempSync(join(tmpdir(), 'code-change-shared-rubric-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const makeTask = (name: string, rubricJson: unknown) => {
    const dir = join(root, name);
    mkdirSync(join(dir, 'tests'), { recursive: true });
    writeFileSync(join(dir, 'tests/judge.json'), JSON.stringify(rubricJson));
    return dir;
  };

  const single = parseRubric(makeTask('single', { extends: 'readability' }), '');
  assert.equal(single.rubric, 'readability-v2');
  assert.equal(single.target, 'production_code');
  assert.equal(Object.keys(single.questions).length, 2);

  const extended = makeTask('extended', {
    extends: ['readability', 'module-design'],
    rubric: 'custom-kata-v1',
    questions: {
      extra_check: {
        type: 'choice',
        instructions: 'Extra check?',
        criteria: { pass: 'Passes.', fail: 'Fails.' },
      },
    },
  });
  const parsedExtended = parseRubric(extended, '');
  assert.equal(parsedExtended.rubric, 'custom-kata-v1');
  assert.equal(parsedExtended.target, 'production_code');
  assert.equal(Object.keys(parsedExtended.questions).length, 5);
  assert.ok(parsedExtended.questions.extra_check);
  assert.deepEqual(parsedExtended.groups, {
    readability: ['direct_readability', 'named_domain_expressions'],
    'module-design': ['modular_organization', 'no_unnecessary_abstraction'],
    task: ['extra_check'],
  });

  assert.throws(() => parseRubric(makeTask('empty', { extends: [] }), ''), /nonempty string or array/);
  assert.throws(() => parseRubric(makeTask('duplicate', { extends: ['readability', 'readability'] }), ''), /Duplicate shared rubric/);
  assert.throws(() => parseRubric(makeTask('missing', { extends: 'does-not-exist' }), ''), /Unknown shared rubric/);
  assert.throws(() => parseRubric(makeTask('traversal', { extends: '../evil' }), ''), /Invalid shared rubric name/);
  assert.throws(() => parseRubric(makeTask('conflict', { extends: ['readability', 'solid'], target: 'review' }), ''), /conflicts with shared rubric/);
});

test('collects TypeScript and TSX production modules without including test or declaration files', async (t) => {
  const { root } = sampleSources(t);
  const sourceDir = join(root, 'app');
  mkdirSync(join(sourceDir, '__tests__'), { recursive: true });
  writeFileSync(join(sourceDir, 'App.tsx'), 'export const App = () => <main />;');
  writeFileSync(join(sourceDir, 'todos.ts'), 'export const todos = [];');
  writeFileSync(join(sourceDir, 'vite-env.d.ts'), '/// <reference types="vite/client" />');
  writeFileSync(join(sourceDir, 'App.spec.tsx'), 'ignored');
  writeFileSync(join(sourceDir, '__tests__/helpers.ts'), 'ignored');

  const out = join(root, 'todo-judge');
  const task = join(ROOT, 'evals/code-change/tasks/implement-react-router-todo');
  const result = await judgeCode({ task, sourceDir, out, model: 'dry-run', dryRun: true });
  const request = JSON.parse(readFileSync(join(out, 'request.json'), 'utf8'));
  assert.equal(result.status, 'dry_run');
  assert.deepEqual(Object.keys(request.state.production_files), ['App.tsx', 'todos.ts']);
  assert.ok(readFileSync(writeHtmlReport(out), 'utf8').includes('<span class="tok-ty">&lt;main</span>'));
});

test('judgeTests sends test_files and read-only production_files_context against composed test_code facets', async (t) => {
  const { root, src, rewardPath } = sampleSources(t);
  const testDir = join(root, 'src/test/kotlin/rover');
  mkdirSync(testDir, { recursive: true });
  writeFileSync(join(testDir, 'MarsRoverTest.kt'), 'package rover\nimport kotlin.test.Test\nclass MarsRoverTest { @Test fun ok() {} }\n');
  writeFileSync(join(testDir, 'notes.txt'), 'ignored\n');

  const requests: Array<{
    state: {
      scope: string;
      test_files: Record<string, string>;
      production_files_context?: Record<string, string>;
    };
    questions: Record<string, { instructions: string }>;
  }> = [];
  const prevKey = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = 'test-key';
  t.after(() => { if (prevKey === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = prevKey; });

  const out = join(root, 'tests-scored');
  const result = await judgeTests(
    { task: MARS_ROVER, testDir: join(root, 'src/test/kotlin'), productionDir: src, model: 'liquid/d1.2-ultra', out, rewardPath },
    (async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      requests.push(body);
      return decisionResponse('liquid/d1.2-ultra-snap', Object.fromEntries(
        Object.keys(body.questions).map((id) => [id, id !== 'unit_single_behavior_aaa']),
      ));
    }) as typeof fetch,
  );

  assert.equal(requests.length, 1);
  assert.equal(requests[0].state.scope, 'whole');
  assert.deepEqual(Object.keys(requests[0].state.test_files), ['rover/MarsRoverTest.kt']);
  assert.deepEqual(Object.keys(requests[0].state.production_files_context ?? {}), ['rover/Direction.kt', 'rover/Rover.kt']);
  assert.match(requests[0].questions.independent_requirement_coverage.instructions, /production_files_context.*read-only context/);
  assert.equal(requests[0].questions.right_execution_tier, undefined);
  assert.equal(result.status, 'scored');
  assert.equal(result.target, 'test_code');
  assert.equal(result.file_count, 1);
  assert.equal(result.context_file_count, 2);
  assert.equal(result.rubric, 'testing-core-v1+testing-unit-v1');
  assert.deepEqual(Object.keys(result.rubric_groups ?? {}), ['testing-core', 'testing-unit']);
  assert.equal(result.deterministic.reward, 1);
  assert.equal(result.quality?.checks.unit_single_behavior_aaa.choice, 'fail');
  assert.equal(result.quality?.checks.independent_requirement_coverage.choice, 'pass');
  assert.equal(result.quality?.pass_rate, 5 / 6);

  const html = readFileSync(writeHtmlReport(out), 'utf8');
  assert.ok(html.includes('Test files (1)'));
  assert.ok(html.includes('Production context (2 files)'));
  assert.ok(html.includes('rover/MarsRoverTest.kt'));
  assert.ok(html.includes('rover/Direction.kt'));
  assert.ok(html.includes('Target <strong>test_code</strong>'));
});

test('judgeTests supports custom tests/judge-tests.json, TypeScript tests, dry-run, missing test files, and rejects review tasks', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'code-change-judge-tests-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const customTask = join(root, 'custom-task');
  mkdirSync(join(customTask, 'tests'), { recursive: true });
  writeFileSync(join(customTask, 'instruction.md'), 'Build a widget.');
  writeFileSync(join(customTask, 'tests/judge.json'), JSON.stringify({ extends: 'readability', source_root: 'src' }));
  writeFileSync(join(customTask, 'tests/judge-tests.json'), JSON.stringify({
    extends: ['testing-core'],
    rubric: 'custom-testing-v1',
    test_source_root: 'tests',
    questions: {
      extra_test_check: {
        type: 'choice',
        instructions: 'Extra test check?',
        criteria: { pass: 'Yes.', fail: 'No.' },
      },
    },
  }));

  const tsTestDir = join(root, 'tests');
  mkdirSync(tsTestDir, { recursive: true });
  writeFileSync(join(tsTestDir, 'widget.spec.ts'), 'export const test = () => true;\n');
  writeFileSync(join(tsTestDir, 'helpers.ts'), 'export const helper = () => 1;\n');
  writeFileSync(join(tsTestDir, 'types.d.ts'), 'export type Ignored = string;\n');

  const prevKey = process.env.OPENROUTER_API_KEY;
  delete process.env.OPENROUTER_API_KEY;
  t.after(() => { if (prevKey === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = prevKey; });

  const dryOut = join(root, 'dry');
  const dry = await judgeTests({ task: customTask, testDir: tsTestDir, model: 'liquid/d1.2-ultra', out: dryOut, dryRun: true });
  assert.equal(dry.status, 'dry_run');
  assert.equal(dry.rubric, 'custom-testing-v1');
  assert.equal(dry.file_count, 2);
  assert.equal(dry.context_file_count, 0);
  const request = JSON.parse(readFileSync(join(dryOut, 'request.json'), 'utf8'));
  assert.deepEqual(Object.keys(request.state.test_files), ['helpers.ts', 'widget.spec.ts']);
  assert.equal(request.state.production_files_context, undefined);
  assert.ok(request.questions.extra_test_check);
  assert.deepEqual(Object.keys(dry.rubric_groups ?? {}), ['testing-core', 'task']);

  const emptyDir = join(root, 'empty-tests');
  mkdirSync(emptyDir);
  const missing = await judgeTests({ task: customTask, testDir: emptyDir, model: 'liquid/d1.2-ultra', out: join(root, 'missing') });
  assert.equal(missing.status, 'missing_report');
  assert.equal(missing.target, 'test_code');
  assert.equal(missing.file_count, 0);

  await assert.rejects(
    judgeTests({ task: join(ROOT, 'evals/code-change/tasks/canary'), testDir: tsTestDir, model: 'liquid/d1.2-ultra', out: join(root, 'bad'), dryRun: true }),
    /targets review/,
  );
});
