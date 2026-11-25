/** Offline tests for authoritative rubrics/, SHA-256 sync parity, and rubric fixture harness dry-run. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  AUTHORITATIVE_RUBRICS_DIR,
  SKILL_RUBRICS_DIR,
  checkRubricSync,
  formatSyncDrift,
  listShippedRubricFiles,
  syncRubrics,
} from './sync.mts';
import { loadFixtures, runRubricHarness } from './test-rubrics.mts';

const SYNC_CLI = fileURLToPath(new URL('./sync.mts', import.meta.url));
const HARNESS_CLI = fileURLToPath(new URL('./test-rubrics.mts', import.meta.url));

function makeTempDir(t: TestContext, prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('skills/judge-code/rubrics/ has exact file-set and SHA-256 parity with shipped rubrics in rubrics/', () => {
  const shipped = listShippedRubricFiles(AUTHORITATIVE_RUBRICS_DIR);
  assert.equal(shipped.length, 9, `Expected 9 shipped rubrics, found ${shipped.length}: ${shipped.join(', ')}`);
  assert.ok(!shipped.some((file) => file.startsWith('testing-')), 'test_code rubrics must not be shipped to judge-code');

  const check = checkRubricSync(AUTHORITATIVE_RUBRICS_DIR, SKILL_RUBRICS_DIR);
  assert.equal(check.inSync, true, formatSyncDrift(check));

  const cli = spawnSync(process.execPath, [SYNC_CLI, '--check'], { encoding: 'utf8' });
  assert.ifError(cli.error);
  assert.equal(cli.status, 0, cli.stderr || cli.stdout);
  assert.match(cli.stdout, /OK: 9 shipped rubric\(s\) match/);
});

test('syncRubrics mirrors shipped rubrics, removes stale files, and checkRubricSync detects all drift types', (t) => {
  const root = makeTempDir(t, 'rubric-sync-test-');
  const sourceDir = join(root, 'rubrics');
  const targetDir = join(root, 'skill-rubrics');
  mkdirSync(sourceDir, { recursive: true });
  mkdirSync(targetDir, { recursive: true });

  writeFileSync(join(sourceDir, 'prod.json'), JSON.stringify({ rubric: 'prod-v1', target: 'production_code', questions: {} }));
  writeFileSync(join(sourceDir, 'struct.json'), JSON.stringify({ rubric: 'struct-v1', target: 'project_structure', questions: {} }));
  writeFileSync(join(sourceDir, 'testing-core.json'), JSON.stringify({ rubric: 'testing-core-v1', target: 'test_code', questions: {} }));

  // Stale extra file in target + missing shipped files.
  writeFileSync(join(targetDir, 'stale.json'), '{"rubric":"stale-v1"}');
  writeFileSync(join(targetDir, 'prod.json'), '{"rubric":"prod-v1","target":"production_code","questions":{"drifted":true}}');

  const before = checkRubricSync(sourceDir, targetDir);
  assert.equal(before.inSync, false);
  assert.deepEqual(before.missing, ['struct.json']);
  assert.deepEqual(before.extra, ['stale.json']);
  assert.deepEqual(before.mismatched.map((m) => m.file), ['prod.json']);
  assert.match(formatSyncDrift(before), /pnpm sync:rubrics/);

  const synced = syncRubrics(sourceDir, targetDir);
  assert.deepEqual(synced.expectedFiles, ['prod.json', 'struct.json']);
  assert.deepEqual(synced.copied, ['prod.json', 'struct.json']);
  assert.deepEqual(synced.removed, ['stale.json']);
  assert.equal(existsSync(join(targetDir, 'testing-core.json')), false);
  assert.equal(existsSync(join(targetDir, 'stale.json')), false);

  const after = checkRubricSync(sourceDir, targetDir);
  assert.equal(after.inSync, true);

  // Second sync is a clean no-op.
  const second = syncRubrics(sourceDir, targetDir);
  assert.deepEqual(second.copied, []);
  assert.deepEqual(second.removed, []);
  assert.deepEqual(second.unchanged, ['prod.json', 'struct.json']);
});

test('pnpm test:rubrics --dry-run validates all checked-in fixtures, rubrics, and request payloads offline', () => {
  const fixtures = loadFixtures();
  assert.ok(fixtures.length >= 10, `Expected at least 10 starter fixtures, found ${fixtures.length}`);

  const env = { ...process.env };
  delete env.OPENROUTER_API_KEY;
  const proc = spawnSync(process.execPath, [HARNESS_CLI, '--dry-run', '--json'], {
    env,
    encoding: 'utf8',
  });
  assert.ifError(proc.error);
  assert.equal(proc.status, 0, proc.stderr || proc.stdout);

  const report = JSON.parse(proc.stdout);
  assert.equal(report.status, 'dry_run');
  assert.equal(report.dry_run, true);
  assert.equal(report.fixtures_total, fixtures.length);
  assert.equal(report.fixtures_passed, fixtures.length);
  assert.ok(report.checks_total >= fixtures.length);
});

test('runRubricHarness enforces expected choices across all repeats and reports probabilities with mocked transport', async (t) => {
  const root = makeTempDir(t, 'rubric-harness-mock-');
  const fixturesDir = join(root, 'fixtures');
  mkdirSync(fixturesDir, { recursive: true });
  writeFileSync(join(fixturesDir, 'sample-good.json'), JSON.stringify({
    id: 'sample-good',
    description: 'Sample fixture for mocked repeats',
    mode: 'file',
    rubric: 'readability',
    files: { 'clean.ts': ['export const isValid = (n: number) => n > 0;'] },
    expect: { direct_readability: 'pass', named_domain_expressions: 'pass' },
  }));

  const prevKey = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = 'fixture-test-key';
  t.after(() => {
    if (prevKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = prevKey;
  });

  // Case 1: Both repeats pass with differing probabilities -> passes and reports min/max.
  let callCount = 0;
  const passReport = await runRubricHarness({
    fixturesDir,
    repeats: 2,
    transport: (async (_url, init) => {
      callCount += 1;
      const body = JSON.parse(String(init?.body));
      const p = callCount === 1 ? 0.91 : 0.97;
      const answers = Object.fromEntries(Object.keys(body.questions).map((id) => [id, {
        type: 'choice',
        choice: 'pass',
        probabilities: { pass: p, fail: Number((1 - p).toFixed(4)) },
        confidence: 0.9,
      }]));
      return Response.json({ model: 'typesafe/jev-1.14-mock', answers });
    }) as typeof fetch,
  });
  assert.equal(passReport.status, 'passed');
  assert.equal(passReport.fixtures_passed, 1);
  assert.equal(passReport.checks_passed, 2);
  const readCheck = passReport.fixtures[0].checks.find((c) => c.check_id === 'direct_readability')!;
  assert.equal(readCheck.min_pass_probability, 0.91);
  assert.equal(readCheck.max_pass_probability, 0.97);

  // Case 2: One repeat flips to fail -> overall harness fails because all repeats must match.
  let flipCall = 0;
  const failReport = await runRubricHarness({
    fixturesDir,
    repeats: 2,
    transport: (async (_url, init) => {
      flipCall += 1;
      const body = JSON.parse(String(init?.body));
      const answers = Object.fromEntries(Object.keys(body.questions).map((id) => {
        const failThis = flipCall === 2 && id === 'direct_readability';
        const p = failThis ? 0.3 : 0.92;
        return [id, {
          type: 'choice',
          choice: failThis ? 'fail' : 'pass',
          probabilities: { pass: p, fail: Number((1 - p).toFixed(4)) },
          confidence: 0.85,
        }];
      }));
      return Response.json({ model: 'typesafe/jev-1.14-mock', answers });
    }) as typeof fetch,
  });
  assert.equal(failReport.status, 'failed');
  assert.equal(failReport.fixtures_passed, 0);
  assert.equal(failReport.checks_passed, 1);

  // Case 3: Module-scoped check expected under mode "file" is rejected cleanly before any API call.
  const badFixturesDir = join(root, 'bad-fixtures');
  mkdirSync(badFixturesDir, { recursive: true });
  writeFileSync(join(badFixturesDir, 'bad-scope.json'), JSON.stringify({
    id: 'bad-scope',
    description: 'Module check under file mode',
    mode: 'file',
    rubric: 'fowler-smells',
    files: { 'a.ts': 'export const a = 1;\n' },
    expect: { no_duplicated_code: 'pass' },
  }));
  await assert.rejects(
    runRubricHarness({ fixturesDir: badFixturesDir, dryRun: true }),
    /module-scoped and skipped in mode "file"/,
  );
});

test('evals/code-change/rubrics/ has been removed in favor of authoritative rubrics/', () => {
  const legacyDir = fileURLToPath(new URL('../evals/code-change/rubrics', import.meta.url));
  assert.equal(existsSync(legacyDir), false, 'Legacy evals/code-change/rubrics/ directory must not exist');
  const rootRubrics = readFileSync(join(AUTHORITATIVE_RUBRICS_DIR, 'testing-core.json'), 'utf8');
  assert.match(rootRubrics, /"target":\s*"test_code"/);
});
