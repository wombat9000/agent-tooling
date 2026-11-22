import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { judgeCode } from './judge_code.mts';
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
  assert.ok(html.includes('class="rubric-tabs"'));
  assert.ok(html.includes('<span>SOLID</span>'));
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
    return new Response('{}', { status: 429 });
  }) as typeof fetch);
  assert.equal(calls, 1);
  assert.equal(failed.status, 'error');
  assert.equal(failed.quality, null);
  assert.deepEqual(failed.file_results?.map((f) => f.status), ['error', 'pending']);

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
  assert.equal(resolved.rubric, 'domain-modelling-v2+readability-v1+module-design-v1+solid-v1');
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
  assert.equal(single.rubric, 'readability-v1');
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
