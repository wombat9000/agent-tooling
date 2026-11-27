/** Offline tests for authoritative rubrics/, SHA-256 sync parity, and unified dual-mode rubric fixture harness. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_DECISION_MODEL,
  DEFAULT_FILE_MODE_DECISION_MODEL,
} from '../skills/judge-code/scripts/decisions.mts';
import {
  AUTHORITATIVE_RUBRICS_DIR,
  SKILL_RUBRICS_DIR,
  checkRubricSync,
  formatSyncDrift,
  listShippedRubricFiles,
  syncRubrics,
} from './sync.mts';
import {
  assertSafeRelativePosixPath,
  formatReportTable,
  loadFixtures,
  resolveFixtureRubric,
  runRubricHarness,
  type RubricHarnessReport,
} from './test-rubrics.mts';

const SYNC_CLI = fileURLToPath(new URL('./sync.mts', import.meta.url));
const HARNESS_CLI = fileURLToPath(new URL('./test-rubrics.mts', import.meta.url));

function makeTempDir(t: TestContext, prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function withFakeApiKey(t: TestContext): void {
  const prevKey = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = 'fixture-test-key';
  t.after(() => {
    if (prevKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = prevKey;
  });
}

function writeRealFixture(
  fixturesRoot: string,
  relDir: string,
  meta: Record<string, unknown>,
  files: Record<string, string>,
  extras?: { context?: Record<string, string>; requirementsMd?: string; conventionsMd?: string },
): string {
  const fixtureDir = join(fixturesRoot, ...relDir.split('/'));
  mkdirSync(join(fixtureDir, 'files'), { recursive: true });
  writeFileSync(join(fixtureDir, 'fixture.json'), `${JSON.stringify(meta, null, 2)}\n`, 'utf8');
  for (const [relPath, content] of Object.entries(files)) {
    const abs = join(fixtureDir, 'files', ...relPath.split('/'));
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content, 'utf8');
  }
  if (extras?.context) {
    mkdirSync(join(fixtureDir, 'context'), { recursive: true });
    for (const [relPath, content] of Object.entries(extras.context)) {
      const abs = join(fixtureDir, 'context', ...relPath.split('/'));
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, content, 'utf8');
    }
  }
  if (extras?.requirementsMd !== undefined) {
    writeFileSync(join(fixtureDir, 'requirements.md'), extras.requirementsMd, 'utf8');
  }
  if (extras?.conventionsMd !== undefined) {
    writeFileSync(join(fixtureDir, 'conventions.md'), extras.conventionsMd, 'utf8');
  }
  return fixtureDir;
}

test('skills/judge-code/rubrics/ has exact file-set and SHA-256 parity with shipped rubrics in rubrics/', () => {
  const shipped = listShippedRubricFiles(AUTHORITATIVE_RUBRICS_DIR);
  assert.equal(shipped.length, 10, `Expected 10 shipped rubrics, found ${shipped.length}: ${shipped.join(', ')}`);
  assert.ok(shipped.includes('react.json'), 'react.json must be shipped to judge-code');
  assert.ok(!shipped.some((file) => file.startsWith('testing-')), 'test_code rubrics must not be shipped to judge-code');

  const check = checkRubricSync(AUTHORITATIVE_RUBRICS_DIR, SKILL_RUBRICS_DIR);
  assert.equal(check.inSync, true, formatSyncDrift(check));

  const cli = spawnSync(process.execPath, [SYNC_CLI, '--check'], { encoding: 'utf8' });
  assert.ifError(cli.error);
  assert.equal(cli.status, 0, cli.stderr || cli.stdout);
  assert.match(cli.stdout, /OK: 10 shipped rubric\(s\) match/);
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

  const second = syncRubrics(sourceDir, targetDir);
  assert.deepEqual(second.copied, []);
  assert.deepEqual(second.removed, []);
  assert.deepEqual(second.unchanged, ['prod.json', 'struct.json']);
});

test('all 59 criteria across all 14 authoritative rubrics have full paired pass and fail fixture coverage under rubrics/fixtures/', () => {
  const allRubricFiles = readdirSync(AUTHORITATIVE_RUBRICS_DIR)
    .filter((f) => f.endsWith('.json'))
    .sort();
  assert.equal(allRubricFiles.length, 14, `Expected 14 authoritative rubrics, found ${allRubricFiles.length}`);

  const criteriaByTarget: Record<'production_code' | 'project_structure' | 'test_code', string[]> = {
    production_code: [],
    project_structure: [],
    test_code: [],
  };
  for (const file of allRubricFiles) {
    const parsed = JSON.parse(readFileSync(join(AUTHORITATIVE_RUBRICS_DIR, file), 'utf8')) as {
      target?: 'production_code' | 'project_structure' | 'test_code';
      questions: Record<string, unknown>;
    };
    const target = parsed.target ?? 'production_code';
    criteriaByTarget[target].push(...Object.keys(parsed.questions));
  }

  assert.equal(criteriaByTarget.production_code.length, 39, 'Expected 39 production_code criteria');
  assert.equal(criteriaByTarget.project_structure.length, 7, 'Expected 7 project_structure criteria');
  assert.equal(criteriaByTarget.test_code.length, 13, 'Expected 13 test_code criteria');
  assert.equal(
    criteriaByTarget.production_code.length + criteriaByTarget.project_structure.length + criteriaByTarget.test_code.length,
    59,
    'Expected 59 total authoritative criteria',
  );

  const fixtures = loadFixtures();
  const coverage = new Map<string, { target: string; pass: number; fail: number; multiFilePass: number; multiFileFail: number }>();
  for (const [target, list] of Object.entries(criteriaByTarget)) {
    for (const criterion of list) {
      coverage.set(criterion, { target, pass: 0, fail: 0, multiFilePass: 0, multiFileFail: 0 });
    }
  }

  for (const fixture of fixtures) {
    const resolved = resolveFixtureRubric(fixture);
    const isMultiFile = Object.keys(fixture.files).length >= 2;
    for (const [checkId, verdict] of Object.entries(fixture.expect)) {
      const stats = coverage.get(checkId);
      assert.ok(stats, `Fixture ${fixture.id} expects unknown check "${checkId}"`);
      assert.equal(stats.target, resolved.target, `Fixture ${fixture.id} target mismatch for "${checkId}"`);
      if (verdict === 'pass') {
        stats.pass += 1;
        if (isMultiFile) stats.multiFilePass += 1;
      } else {
        stats.fail += 1;
        if (isMultiFile) stats.multiFileFail += 1;
      }
    }
  }

  const gaps: string[] = [];
  for (const [criterion, stats] of coverage.entries()) {
    if (stats.target === 'production_code') {
      if (stats.pass < 1 || stats.fail < 1 || stats.multiFilePass < 1 || stats.multiFileFail < 1) {
        gaps.push(
          `[production_code] ${criterion}: pass=${stats.pass} (multi=${stats.multiFilePass}), fail=${stats.fail} (multi=${stats.multiFileFail})`,
        );
      }
    } else if (stats.pass < 1 || stats.fail < 1) {
      gaps.push(`[${stats.target}] ${criterion}: pass=${stats.pass}, fail=${stats.fail}`);
    }
  }
  assert.deepEqual(gaps, [], `Missing pass/fail fixture coverage for criteria:\n${gaps.join('\n')}`);
});

test('loadFixtures enforces real-file fixture.json + files/ layout and rejects inline files, missing/empty files/, flat JSON, duplicates, symlinks, and unsafe paths', (t) => {
  const root = makeTempDir(t, 'fixture-loader-validation-');

  // 1. Inline "files" in fixture.json is rejected.
  const inlineDir = join(root, 'inline-files');
  mkdirSync(join(inlineDir, 'readability/bad-inline/files'), { recursive: true });
  writeFileSync(join(inlineDir, 'readability/bad-inline/files/a.ts'), 'export const a = 1;\n');
  writeFileSync(join(inlineDir, 'readability/bad-inline/fixture.json'), JSON.stringify({
    id: 'bad-inline',
    description: 'Inline files should be rejected',
    rubric: 'readability',
    files: { 'a.ts': ['export const a = 1;'] },
    expect: { direct_readability: 'pass' },
  }));
  assert.throws(() => loadFixtures(inlineDir), /inline "files" in fixture\.json is not supported/);

  // 2. Missing files/ directory is rejected.
  const missingFilesDir = join(root, 'missing-files');
  mkdirSync(join(missingFilesDir, 'readability/no-files'), { recursive: true });
  writeFileSync(join(missingFilesDir, 'readability/no-files/fixture.json'), JSON.stringify({
    id: 'no-files',
    description: 'Missing files dir',
    rubric: 'readability',
    expect: { direct_readability: 'pass' },
  }));
  assert.throws(() => loadFixtures(missingFilesDir), /missing required "files\/" directory/);

  // 3. Empty files/ directory is rejected.
  const emptyFilesDir = join(root, 'empty-files');
  mkdirSync(join(emptyFilesDir, 'readability/empty/files'), { recursive: true });
  writeFileSync(join(emptyFilesDir, 'readability/empty/fixture.json'), JSON.stringify({
    id: 'empty-files',
    description: 'Empty files dir',
    rubric: 'readability',
    expect: { direct_readability: 'pass' },
  }));
  assert.throws(() => loadFixtures(emptyFilesDir), /"files\/" directory must contain at least one file/);

  // 4. Legacy flat *.json directly in fixtures root is rejected.
  const flatDir = join(root, 'flat-json');
  mkdirSync(flatDir, { recursive: true });
  writeFileSync(join(flatDir, 'legacy.json'), '{}');
  assert.throws(() => loadFixtures(flatDir), /Legacy flat fixture JSON/);

  // 5. Duplicate IDs across different groups are rejected.
  const dupDir = join(root, 'dup-ids');
  writeRealFixture(
    dupDir,
    'readability/dup-one',
    { id: 'same-id', description: 'First', rubric: 'readability', expect: { direct_readability: 'pass' } },
    { 'a.ts': 'export const a = 1;\n' },
  );
  writeRealFixture(
    dupDir,
    'solid/dup-two',
    { id: 'same-id', description: 'Second', rubric: 'solid', expect: { open_closed: 'pass' } },
    { 'b.ts': 'export const b = 2;\n' },
  );
  assert.throws(() => loadFixtures(dupDir), /Duplicate fixture id: same-id/);

  // 6. Symlink inside files/ is rejected.
  const symDir = join(root, 'symlink-fixture');
  const outsideFile = join(root, 'outside.ts');
  writeFileSync(outsideFile, 'export const secret = 1;\n');
  const symFx = writeRealFixture(
    symDir,
    'readability/sym-bad',
    { id: 'sym-bad', description: 'Symlink escape', rubric: 'readability', expect: { direct_readability: 'pass' } },
    { 'a.ts': 'export const a = 1;\n' },
  );
  symlinkSync(outsideFile, join(symFx, 'files/escape.ts'));
  assert.throws(() => loadFixtures(symDir), /symlink not allowed/);

  // 7. Unsafe POSIX paths & unsafe root_name are rejected.
  assert.throws(() => assertSafeRelativePosixPath('../escape.ts', 'test'), /safe relative POSIX path/);
  assert.throws(() => assertSafeRelativePosixPath('/abs.ts', 'test'), /safe relative POSIX path/);
  assert.throws(() => assertSafeRelativePosixPath('a\\b.ts', 'test'), /safe relative POSIX path/);

  const badRootDir = join(root, 'bad-root-name');
  writeRealFixture(
    badRootDir,
    'project-structure/bad-root',
    {
      id: 'bad-root',
      description: 'Traversal root_name',
      mode: 'structure',
      root_name: '../escape',
      rubric: 'project-structure',
      expect: { no_junk_drawer_directories: 'pass' },
    },
    { 'a.ts': 'export const a = 1;\n' },
  );
  assert.throws(() => loadFixtures(badRootDir), /must be a single safe directory name/);
});

test('pnpm test:rubrics --dry-run validates all 154 checked-in fixtures, rubrics, CLI filters, and 52-criterion criteria_matrix offline', () => {
  const fixtures = loadFixtures();
  assert.ok(fixtures.length >= 154, `Expected at least 154 fixtures across all 59 criteria, found ${fixtures.length}`);

  const env = { ...process.env };
  delete env.OPENROUTER_API_KEY;
  const proc = spawnSync(process.execPath, [HARNESS_CLI, '--dry-run', '--json'], {
    env,
    encoding: 'utf8',
  });
  assert.ifError(proc.error);
  assert.equal(proc.status, 0, proc.stderr || proc.stdout);

  const report = JSON.parse(proc.stdout) as RubricHarnessReport;
  assert.equal(report.status, 'dry_run');
  assert.equal(report.dry_run, true);
  assert.equal(report.modes, 'both');
  assert.equal(report.models.file, DEFAULT_FILE_MODE_DECISION_MODEL);
  assert.equal(report.models.module, DEFAULT_DECISION_MODEL);
  assert.equal(report.fixtures_total, fixtures.length);
  assert.equal(report.fixtures_passed, fixtures.length);
  assert.equal(report.criteria_matrix.length, 52, 'Expected 39 production_code + 13 test_code dual-mode criteria');

  // Verify --rule works for both production_code and test_code rules offline.
  const filtered = spawnSync(
    process.execPath,
    [
      HARNESS_CLI,
      '--dry-run',
      '--json',
      '--rule',
      'open_closed',
      '--rule',
      'independent_requirement_coverage',
      '--file-model',
      'liquid/d1.2-ultra',
      '--module-model',
      'liquid/d1.2-ultra',
      '--modes',
      'both',
    ],
    { env, encoding: 'utf8' },
  );
  assert.ifError(filtered.error);
  assert.equal(filtered.status, 0, filtered.stderr || filtered.stdout);
  const filteredReport = JSON.parse(filtered.stdout) as RubricHarnessReport;
  assert.equal(filteredReport.models.file, 'liquid/d1.2-ultra');
  assert.equal(filteredReport.models.module, 'liquid/d1.2-ultra');
  assert.ok(filteredReport.fixtures_total >= 4);
  assert.ok(filteredReport.fixtures.some((f) => f.target === 'production_code'));
  assert.ok(filteredReport.fixtures.some((f) => f.target === 'test_code'));

  // Conflicting --model + --file-model is rejected.
  const conflict = spawnSync(
    process.execPath,
    [HARNESS_CLI, '--dry-run', '--model', 'liquid/d1.2-ultra', '--file-model', 'typesafe/jev-1.14'],
    { env, encoding: 'utf8' },
  );
  assert.notEqual(conflict.status, 0);
  assert.match(conflict.stderr, /Cannot combine --model with --file-model or --module-model/);
});

test('runRubricHarness runs dual file+module modes narrowed to expected checks, ignores scope filter in file mode, and enforces scope gating', async (t) => {
  const root = makeTempDir(t, 'rubric-harness-dual-');
  const fixturesDir = join(root, 'fixtures');
  mkdirSync(fixturesDir, { recursive: true });
  withFakeApiKey(t);

  // Fixture 1: file-scoped check (direct_readability) in a 2-file module (rubric readability also has named_domain_expressions).
  writeRealFixture(
    fixturesDir,
    'readability/file-rule-good',
    {
      id: 'file-rule-good',
      description: 'Clean 2-file fixture for file-scoped check',
      rubric: 'readability',
      expect: { direct_readability: 'pass' },
    },
    {
      'a.ts': 'export const isPositive = (n: number) => n > 0;\n',
      'b.ts': 'export const isEven = (n: number) => n % 2 === 0;\n',
    },
  );

  // Fixture 2: module-scoped check (liskov_substitution) in a 2-file module (rubric solid has 5 checks total).
  writeRealFixture(
    fixturesDir,
    'solid/module-rule-bad',
    {
      id: 'module-rule-bad',
      description: '2-file fixture for module-scoped check',
      rubric: 'solid',
      expect: { liskov_substitution: 'fail' },
    },
    {
      'base.ts': 'export interface Store { delete(id: string): void; }\n',
      'readonly.ts': "import type { Store } from './base'; export class ReadOnlyStore implements Store { delete() { throw new Error('unsupported'); } }\n",
    },
  );

  interface CapturedReq {
    model: string;
    fileCount: number;
    questionIds: string[];
  }
  const captured: CapturedReq[] = [];

  // Case 1: file-scoped check passes in both modes; module-scoped check passes in module mode even though file mode disagrees (informational).
  const report = await runRubricHarness({
    fixturesDir,
    repeats: 2,
    concurrency: 1,
    transport: (async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as {
        model: string;
        state: { production_files: Record<string, string> };
        questions: Record<string, unknown>;
      };
      const fileCount = Object.keys(body.state.production_files).length;
      const questionIds = Object.keys(body.questions);
      captured.push({ model: body.model, fileCount, questionIds });

      const answers = Object.fromEntries(questionIds.map((id) => {
        if (id === 'direct_readability') {
          const p = fileCount === 1 ? 0.91 : 0.96;
          return [id, { type: 'choice', choice: 'pass', probabilities: { pass: p, fail: Number((1 - p).toFixed(4)) }, confidence: 0.9 }];
        }
        // For liskov_substitution (module-scoped, expected fail): file mode wrongly says pass (0.88), module mode rightly says fail (0.12).
        const p = fileCount === 1 ? 0.88 : 0.12;
        return [id, {
          type: 'choice',
          choice: p >= 0.5 ? 'pass' : 'fail',
          probabilities: { pass: p, fail: Number((1 - p).toFixed(4)) },
          confidence: 0.9,
        }];
      }));
      return Response.json({ model: `${body.model}-mock`, answers });
    }) as typeof fetch,
  });

  // Verify narrowing: every request asked ONLY for the fixture's single expected check ID.
  assert.ok(captured.length > 0);
  for (const req of captured) {
    assert.equal(req.questionIds.length, 1, `Expected narrowed 1-question request, got ${req.questionIds.join(',')}`);
  }
  // Verify file mode ran for module-scoped liskov_substitution too (2 files x 2 repeats = 4 single-file calls) with jev-1.14!
  const lspFileReqs = captured.filter((r) => r.questionIds[0] === 'liskov_substitution' && r.fileCount === 1);
  const lspModuleReqs = captured.filter((r) => r.questionIds[0] === 'liskov_substitution' && r.fileCount === 2);
  assert.equal(lspFileReqs.length, 4);
  assert.equal(lspModuleReqs.length, 2);
  assert.ok(lspFileReqs.every((r) => r.model === DEFAULT_FILE_MODE_DECISION_MODEL));
  assert.ok(lspModuleReqs.every((r) => r.model === DEFAULT_DECISION_MODEL));

  // Verify gating: overall report PASSED because module-scoped liskov_substitution passed in module mode (file mode is informational).
  assert.equal(report.status, 'passed');
  assert.equal(report.fixtures_passed, 2);
  assert.equal(report.checks_passed, 2);

  const lspCheck = report.fixtures.find((f) => f.id === 'module-rule-bad')!.checks[0];
  assert.equal(lspCheck.declared_scope, 'module');
  assert.equal(lspCheck.passed, true);
  assert.equal(lspCheck.file?.enforced, false);
  assert.equal(lspCheck.file?.passed, false);
  assert.equal(lspCheck.module?.enforced, true);
  assert.equal(lspCheck.module?.passed, true);

  // Case 2: file-scoped check fails when file mode passes on repeat 1 and flips to fail on repeat 2 (even if module mode passes).
  let fileCall = 0;
  const fileFailReport = await runRubricHarness({
    fixturesDir,
    fixtureFilter: ['file-rule-good'],
    repeats: 2,
    concurrency: 1,
    transport: (async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { state: { production_files: Record<string, string> }; questions: Record<string, unknown> };
      const isFileMode = Object.keys(body.state.production_files).length === 1;
      if (isFileMode) fileCall += 1;
      const failNow = isFileMode && fileCall === 4;
      const p = failNow ? 0.25 : 0.95;
      return Response.json({
        model: 'mock',
        answers: {
          direct_readability: {
            type: 'choice',
            choice: failNow ? 'fail' : 'pass',
            probabilities: { pass: p, fail: Number((1 - p).toFixed(4)) },
            confidence: 0.9,
          },
        },
      });
    }) as typeof fetch,
  });
  assert.equal(fileFailReport.status, 'failed');
  assert.equal(fileFailReport.fixtures[0].checks[0].file?.passed, false);
  assert.equal(fileFailReport.fixtures[0].checks[0].module?.passed, true);
  assert.equal(fileFailReport.fixtures[0].checks[0].passed, false);

  // Case 3: file-scoped check ALSO fails when file mode passes but module mode fails.
  const moduleFailOnFileRule = await runRubricHarness({
    fixturesDir,
    fixtureFilter: ['file-rule-good'],
    repeats: 1,
    transport: (async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { state: { production_files: Record<string, string> } };
      const isFileMode = Object.keys(body.state.production_files).length === 1;
      const p = isFileMode ? 0.95 : 0.35;
      return Response.json({
        model: 'mock',
        answers: {
          direct_readability: {
            type: 'choice',
            choice: isFileMode ? 'pass' : 'fail',
            probabilities: { pass: p, fail: Number((1 - p).toFixed(4)) },
            confidence: 0.9,
          },
        },
      });
    }) as typeof fetch,
  });
  assert.equal(moduleFailOnFileRule.status, 'failed');
  assert.equal(moduleFailOnFileRule.fixtures[0].checks[0].file?.passed, true);
  assert.equal(moduleFailOnFileRule.fixtures[0].checks[0].module?.passed, false);
  assert.equal(moduleFailOnFileRule.fixtures[0].checks[0].passed, false);

  // Case 4: obsolete "mode": "file" in fixture.json is rejected cleanly.
  const legacyDir = join(root, 'legacy-fixtures');
  writeRealFixture(
    legacyDir,
    'readability/legacy-mode',
    {
      id: 'legacy-mode',
      description: 'Legacy mode field',
      mode: 'file',
      rubric: 'readability',
      expect: { direct_readability: 'pass' },
    },
    { 'a.ts': 'export const a = 1;\n' },
  );
  await assert.rejects(
    runRubricHarness({ fixturesDir: legacyDir, dryRun: true }),
    /"mode": "file" is obsolete/,
  );
});

test('runRubricHarness evaluates test_code fixtures in dual file+module modes with test_files, production_files_context, and requirement payload', async (t) => {
  const root = makeTempDir(t, 'rubric-harness-test-code-');
  const fixturesDir = join(root, 'fixtures');
  mkdirSync(fixturesDir, { recursive: true });
  withFakeApiKey(t);

  writeRealFixture(
    fixturesDir,
    'testing-core/req-cov-good',
    {
      id: 'req-cov-good',
      description: 'Good test_code fixture with requirements.md and context/',
      rubric: 'testing-core',
      expect: { independent_requirement_coverage: 'pass' },
    },
    {
      'a.test.ts': 'import assert from "node:assert/strict"; assert.equal(1 + 1, 2);\n',
      'b.test.ts': 'import assert from "node:assert/strict"; assert.equal(2 + 2, 4);\n',
    },
    {
      context: { 'calc.ts': 'export const add = (a: number, b: number) => a + b;\n' },
      requirementsMd: '# Spec\nAdd two integers.\n',
    },
  );

  writeRealFixture(
    fixturesDir,
    'testing-core/req-cov-bad',
    {
      id: 'req-cov-bad',
      description: 'Bad test_code fixture with requirements.md and context/',
      rubric: 'testing-core',
      expect: { independent_requirement_coverage: 'fail' },
    },
    {
      'a.test.ts': 'import { add } from "../context/calc"; const x = add(1, 2); if (x !== x) throw new Error();\n',
      'b.test.ts': 'export const emptyProbe = true;\n',
    },
    {
      context: { 'calc.ts': 'export const add = (a: number, b: number) => a + b;\n' },
      requirementsMd: '# Spec\nAdd two integers.\n',
    },
  );

  interface CapturedTestReq {
    model: string;
    hasProductionFiles: boolean;
    testFileCount: number;
    contextKeys: string[];
    requirement?: string;
    instructions: string;
  }
  const captured: CapturedTestReq[] = [];

  const report = await runRubricHarness({
    fixturesDir,
    repeats: 1,
    concurrency: 1,
    transport: (async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as {
        model: string;
        state: {
          requirement?: string;
          production_files?: Record<string, string>;
          test_files?: Record<string, string>;
          production_files_context?: Record<string, string>;
        };
        questions: Record<string, { instructions: string }>;
      };
      const testFiles = body.state.test_files ?? {};
      const joined = Object.values(testFiles).join('\n');
      const isBad = joined.includes('emptyProbe') || joined.includes('x !== x');
      const isFileMode = Object.keys(testFiles).length === 1;
      captured.push({
        model: body.model,
        hasProductionFiles: body.state.production_files !== undefined,
        testFileCount: Object.keys(testFiles).length,
        contextKeys: Object.keys(body.state.production_files_context ?? {}),
        requirement: body.state.requirement,
        instructions: body.questions.independent_requirement_coverage.instructions,
      });

      // Module mode discriminates cleanly; file mode says pass on both (informational since scope is module).
      const passProb = !isBad ? 0.93 : isFileMode ? 0.85 : 0.14;
      return Response.json({
        model: `${body.model}-mock`,
        answers: {
          independent_requirement_coverage: {
            type: 'choice',
            choice: passProb >= 0.5 ? 'pass' : 'fail',
            probabilities: { pass: passProb, fail: Number((1 - passProb).toFixed(4)) },
            confidence: 0.9,
          },
        },
      });
    }) as typeof fetch,
  });

  assert.equal(report.status, 'passed');
  assert.equal(report.fixtures_total, 2);
  assert.equal(report.fixtures_passed, 2);
  assert.ok(captured.length === 6, `Expected 4 file-mode + 2 module-mode requests, got ${captured.length}`);
  for (const req of captured) {
    assert.equal(req.hasProductionFiles, false, 'test_code requests must send state.test_files, not state.production_files');
    assert.deepEqual(req.contextKeys, ['calc.ts']);
    assert.match(req.requirement ?? '', /Add two integers/);
    assert.match(req.instructions, /`test_files`/);
    assert.match(req.instructions, /`production_files_context`/);
  }

  // test_code criteria appear in Scope Signal Matrix and rendered Test Code Fixtures table.
  assert.equal(report.criteria_matrix.length, 1);
  assert.equal(report.criteria_matrix[0].check_id, 'independent_requirement_coverage');
  assert.equal(report.criteria_matrix[0].declared_scope, 'module');
  assert.equal(report.criteria_matrix[0].classification, 'module-only');

  const rendered = formatReportTable(report);
  assert.match(rendered, /Test Code Fixtures:/);
  assert.match(rendered, /req-cov-good/);
  assert.match(rendered, /independent_requirement_coverage.*module-only/);

  // Reject context/ directory on non-test_code fixtures.
  const badCtxDir = join(root, 'bad-context-target');
  writeRealFixture(
    badCtxDir,
    'readability/prod-with-ctx',
    { id: 'prod-with-ctx', description: 'Invalid context dir on production_code', rubric: 'readability', expect: { direct_readability: 'pass' } },
    { 'a.ts': 'export const a = 1;\n' },
    { context: { 'b.ts': 'export const b = 2;\n' } },
  );
  await assert.rejects(
    runRubricHarness({ fixturesDir: badCtxDir, dryRun: true }),
    /"context\/" directory is only supported for test_code fixtures/,
  );
});

test('Scope Signal Matrix classifies both, module-only, file-only, and neither, and marks promote_hint for module-scoped both', async (t) => {
  const root = makeTempDir(t, 'rubric-matrix-test-');
  const fixturesDir = join(root, 'fixtures');
  mkdirSync(fixturesDir, { recursive: true });
  withFakeApiKey(t);

  const pairs: Array<{ id: string; rubric: string; check: string }> = [
    { id: 'inv', rubric: 'domain-modelling', check: 'domain_invariants' },
    { id: 'lsp', rubric: 'solid', check: 'liskov_substitution' },
    { id: 'isp', rubric: 'solid', check: 'interface_segregation' },
    { id: 'dip', rubric: 'solid', check: 'dependency_inversion' },
  ];
  for (const { id, rubric, check } of pairs) {
    for (const kind of ['good', 'bad'] as const) {
      writeRealFixture(
        fixturesDir,
        `${rubric}/${id}-${kind}`,
        {
          id: `${id}-${kind}`,
          description: `${check} ${kind}`,
          rubric,
          expect: { [check]: kind === 'good' ? 'pass' : 'fail' },
        },
        {
          'a.ts': `export const marker = '${id}-${kind}-a';\n`,
          'b.ts': `export const other = '${id}-${kind}-b';\n`,
        },
      );
    }
  }

  // Outcomes by check:
  // - domain_invariants (declared module): both file and module discriminate -> 'both' + promote_hint=true
  // - liskov_substitution (declared module): module discriminates, file misses bad -> 'module-only'
  // - interface_segregation (declared module): file discriminates, module misses bad -> 'file-only'
  // - dependency_inversion (declared module): neither discriminates -> 'neither'
  const report = await runRubricHarness({
    fixturesDir,
    repeats: 1,
    transport: (async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as {
        state: { production_files: Record<string, string> };
        questions: Record<string, unknown>;
      };
      const fileEntries = Object.entries(body.state.production_files);
      const isFileMode = fileEntries.length === 1;
      const content = fileEntries.map(([, v]) => v).join('\n');
      const isBad = content.includes('-bad-');
      const checkId = Object.keys(body.questions)[0];

      let passProb = 0.95;
      if (isBad) {
        if (checkId === 'domain_invariants') passProb = 0.10;
        else if (checkId === 'liskov_substitution') passProb = isFileMode ? 0.92 : 0.12;
        else if (checkId === 'interface_segregation') passProb = isFileMode ? 0.15 : 0.91;
        else if (checkId === 'dependency_inversion') passProb = 0.89;
      }

      return Response.json({
        model: 'mock',
        answers: {
          [checkId]: {
            type: 'choice',
            choice: passProb >= 0.5 ? 'pass' : 'fail',
            probabilities: { pass: passProb, fail: Number((1 - passProb).toFixed(4)) },
            confidence: 0.9,
          },
        },
      });
    }) as typeof fetch,
  });

  const byCheck = new Map(report.criteria_matrix.map((row) => [row.check_id, row]));
  assert.equal(byCheck.get('domain_invariants')?.classification, 'both');
  assert.equal(byCheck.get('domain_invariants')?.promote_hint, true);
  assert.equal(byCheck.get('liskov_substitution')?.classification, 'module-only');
  assert.equal(byCheck.get('liskov_substitution')?.promote_hint, false);
  assert.equal(byCheck.get('interface_segregation')?.classification, 'file-only');
  assert.equal(byCheck.get('dependency_inversion')?.classification, 'neither');

  const rendered = formatReportTable(report);
  assert.match(rendered, /File \(Score\)/);
  assert.match(rendered, /Module \(Score\)/);
  assert.match(rendered, /Scope Signal Matrix:/);
  assert.match(rendered, /domain_invariants.*both \(promote\?\)/);
  assert.match(rendered, /liskov_substitution.*module-only/);
  assert.match(rendered, /interface_segregation.*file-only/);
  assert.match(rendered, /dependency_inversion.*neither/);
  assert.equal(byCheck.get('domain_invariants')?.pass_threshold, 80);
  assert.equal(byCheck.get('domain_invariants')?.file.good_min_score, 95);
  assert.equal(byCheck.get('domain_invariants')?.file.bad_max_score, 10);
});

test('applies_to schema validation enforces valid extensions/runtime_imports and fixture applicability', async (t) => {
  const { parseApplicability, resolveRubrics } = await import('../skills/judge-code/scripts/rubrics.mts');
  const root = makeTempDir(t, 'applies-to-validation-');

  // Valid shapes
  assert.equal(parseApplicability(undefined, 'test', 'production_code'), undefined);
  assert.deepEqual(
    parseApplicability({ extensions: ['.TSX', '.tsx'], runtime_imports: ['react', 'react-dom', 'react'] }, 'react', 'production_code'),
    { extensions: ['.tsx'], runtime_imports: ['react', 'react-dom'] },
  );

  // Invalid shapes fail closed
  assert.throws(() => parseApplicability({}, 'bad', 'production_code'), /at least one of extensions or runtime_imports/);
  assert.throws(() => parseApplicability({ unknown: true }, 'bad', 'production_code'), /Unknown key/);
  assert.throws(() => parseApplicability({ extensions: ['tsx'] }, 'bad', 'production_code'), /Expected leading dot/);
  assert.throws(() => parseApplicability({ extensions: [] }, 'bad', 'production_code'), /nonempty array/);
  assert.throws(() => parseApplicability({ runtime_imports: [''] }, 'bad', 'production_code'), /nonempty string/);
  assert.throws(() => parseApplicability({ extensions: ['.tsx'] }, 'bad', 'project_structure'), /not supported for project_structure/);

  // Authoritative react.json resolves with expected applies_to metadata
  const resolvedReact = resolveRubrics({
    mode: 'code',
    rubrics: [join(AUTHORITATIVE_RUBRICS_DIR, 'react.json')],
    hasRequirements: false,
    hasConventions: false,
  });
  assert.deepEqual(resolvedReact.appliesTo?.react_effect_lifecycle, {
    extensions: ['.tsx'],
    runtime_imports: ['react', 'react-dom'],
  });

  // Fixture whose files do not satisfy react applicability is rejected offline
  const fixturesDir = join(root, 'fixtures');
  writeRealFixture(
    fixturesDir,
    'react/non-react-bad',
    {
      id: 'non-react-bad',
      description: 'Non-React fixture targeting react rubric should fail validation',
      rubric: 'react',
      expect: { react_effect_lifecycle: 'pass' },
    },
    { 'plain.ts': 'export const value = 1;\n' },
  );
  await assert.rejects(
    runRubricHarness({ fixturesDir, dryRun: true }),
    /does not match rubric applicability/,
  );
});

test('runRubricHarness reads project_structure manifests directly from files/ preserving root_name parity', async (t) => {
  const root = makeTempDir(t, 'rubric-harness-structure-');
  const fixturesDir = join(root, 'fixtures');
  mkdirSync(fixturesDir, { recursive: true });
  withFakeApiKey(t);

  writeRealFixture(
    fixturesDir,
    'project-structure/struct-good',
    {
      id: 'struct-good',
      description: 'Modular feature tree for structure harness check (mode inferred from project-structure rubric)',
      root_name: 'src',
      rubric: 'project-structure',
      expect: {
        no_junk_drawer_directories: 'pass',
        descriptive_file_roles: 'pass',
      },
    },
    {
      'features/profile/types.ts': 'export interface Profile { id: string; }\n',
      'features/profile/service.ts': [
        "import type { Profile } from './types';",
        'export function loadProfile(id: string): Profile { return { id }; }',
        '',
      ].join('\n'),
      'features/profile/service.test.ts': [
        "import { loadProfile } from './service';",
        "export const sample = loadProfile('p-1');",
        '',
      ].join('\n'),
    },
  );

  let capturedManifest: Record<string, unknown> | null = null;
  let capturedQuestions: string[] = [];
  const report = await runRubricHarness({
    fixturesDir,
    repeats: 1,
    transport: (async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      capturedManifest = body.state.project_structure;
      capturedQuestions = Object.keys(body.questions);
      const answers = Object.fromEntries(capturedQuestions.map((id) => [id, {
        type: 'choice',
        choice: 'pass',
        probabilities: { pass: 0.94, fail: 0.06 },
        confidence: 0.9,
      }]));
      return Response.json({ model: 'liquid/d1.2-ultra-mock', answers });
    }) as typeof fetch,
  });

  assert.equal(report.status, 'passed');
  assert.equal(report.fixtures[0].target, 'project_structure');
  assert.deepEqual(capturedQuestions.sort(), ['descriptive_file_roles', 'no_junk_drawer_directories']);
  assert.ok(capturedManifest);
  assert.equal(capturedManifest.root_name, 'src');
  assert.equal(capturedManifest.total_files, 3);
  const manifestFiles = capturedManifest.files as Record<string, { kind: string; local_imports?: string[] }>;
  assert.equal(manifestFiles['features/profile/service.ts'].kind, 'source');
  assert.deepEqual(manifestFiles['features/profile/service.ts'].local_imports, ['./types']);
  assert.deepEqual(manifestFiles['features/profile/service.test.ts'], { kind: 'test' });
});

test('evals/code-change/rubrics/ has been removed in favor of authoritative rubrics/', () => {
  const legacyDir = fileURLToPath(new URL('../evals/code-change/rubrics', import.meta.url));
  assert.equal(existsSync(legacyDir), false, 'Legacy evals/code-change/rubrics/ directory must not exist');
  const rootRubrics = readFileSync(join(AUTHORITATIVE_RUBRICS_DIR, 'testing-core.json'), 'utf8');
  assert.match(rootRubrics, /"target":\s*"test_code"/);
});
