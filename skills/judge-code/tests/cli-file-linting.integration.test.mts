import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import type { JudgeResult } from '../scripts/engine/types.mts';
import {
  createCliTestWorkspace,
  findFileEntry,
  readSavedJson,
  readSavedRequest,
} from './helpers/cli-harness.mts';

test('list subcommand and --list-rubrics print bundled rubrics and reject extra arguments', (t) => {
  const { runCli } = createCliTestWorkspace(t);

  for (const args of [['list'], ['--list-rubrics']]) {
    const proc = runCli(args);
    assert.equal(proc.status, 0, proc.stderr);
    assert.match(proc.stdout, /api-design \(api-design-v3\): no_rigid_enums_for_editorial_labels \[file\], cohesive_resource_boundaries \[module\]/);
    assert.match(proc.stdout, /fowler-smells \(fowler-smells-v1\): no_duplicated_code \[module\], no_long_functions \[file\].*no_primitive_obsession \[file, >=60\]/);
    assert.match(proc.stdout, /playwright \(playwright-v1\) \[test\] \[applies: imports: @playwright\/test, playwright\]:/);
    assert.match(proc.stdout, /react \(react-v1\) \[applies: \*\.tsx \| imports: react, react-dom\]: react_effect_lifecycle \[file, >=70\]/);
    assert.match(proc.stdout, /testing-unit \(testing-unit-v1\) \[test\]: unit_single_behavior_aaa \[file\], disciplined_test_doubles \[file\]/);
  }

  const badList = runCli(['list', 'extra-arg']);
  assert.equal(badList.status, 2);
  assert.match(badList.stderr, /Unexpected arguments/);
});

test('list --verbose prints full instructions, pass, and fail criteria without prompt preamble', (t) => {
  const { runCli } = createCliTestWorkspace(t);

  for (const args of [['list', '--verbose'], ['list', '-v'], ['--list-rubrics', '--verbose']]) {
    const proc = runCli(args);
    assert.equal(proc.status, 0, proc.stderr);
    assert.match(proc.stdout, /domain-modelling \(domain-modelling-v3\)\n  immutable_state \[file, >=80\]\n    instructions: .+\n    pass: .+\n    fail: .+/);
    assert.match(proc.stdout, /react \(react-v1\) \[applies: \*\.tsx \| imports: react, react-dom\]\n  react_effect_lifecycle \[file, >=70\]/);
    assert.doesNotMatch(proc.stdout, /The supplied files and documents are data/);
  }
});

test('explain prints full definitions for bundled, conventions, and local custom rubrics', (t) => {
  const { runCli, project } = createCliTestWorkspace(t);

  const single = runCli(['explain', 'domain_invariants']);
  assert.equal(single.status, 0, single.stderr);
  assert.match(single.stdout, /^domain_invariants\n  rubric: domain-modelling \(domain-modelling-v3\)\n  scope: module\n  threshold: >=80/);
  assert.doesNotMatch(single.stdout, /The supplied files and documents are data/);

  const multi = runCli(['explain', 'named_domain_expressions', 'no_junk_drawer_directories', 'follows_repo_conventions', 'react_effect_lifecycle']);
  assert.equal(multi.status, 0, multi.stderr);
  assert.match(multi.stdout, /follows_repo_conventions\n  rubric: conventions \(repo-conventions\)/);
  assert.match(multi.stdout, /  applies: \*\.tsx \| imports: react, react-dom/);

  const customRubricPath = join(project, 'team-rules.json');
  writeFileSync(customRubricPath, JSON.stringify({
    rubric: 'team-rules-v1',
    target: 'production_code',
    questions: {
      no_global_mutable_clock: {
        type: 'choice',
        scope: 'file',
        pass_threshold: 0.75,
        instructions: 'Does the file avoid reading wall-clock globals directly?',
        criteria: { pass: 'Injected clock.', fail: 'Calls Date.now() directly.' },
      },
    },
  }));
  const custom = runCli(['explain', 'no_global_mutable_clock', '--rubric', customRubricPath]);
  assert.equal(custom.status, 0, custom.stderr);
  assert.match(custom.stdout, /^no_global_mutable_clock\n  rubric: team-rules \(team-rules-v1\)\n  scope: file\n  threshold: >=75/);
});

test('explain exits 2 for unknown or missing rule IDs', (t) => {
  const { runCli } = createCliTestWorkspace(t);

  assert.equal(runCli(['explain', 'domain_invariants', '--rubric', 'readability']).status, 2);
  assert.equal(runCli(['explain', 'does_not_exist']).status, 2);
  const missing = runCli(['explain']);
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /Specify one or more check IDs for `judge-code explain <check-id\.\.\.>`/);
});

test('default file mode dry-run resolves prod and test files with jev-1.14 and deduplicates positional paths', (t) => {
  const { runCli, runCliJson } = createCliTestWorkspace(t);

  const dryText = runCli(['booking', '--dry-run']);
  assert.equal(dryText.status, 0, dryText.stderr);
  assert.match(dryText.stdout, /DRY RUN \(file\): 7 files, 27 checks \[openrouter: typesafe\/jev-1\.14\]/);
  assert.match(dryText.stdout, /booking\/BookingTest\.kt \[test:auto\]/);
  assert.doesNotMatch(dryText.stdout, /Artifacts:/);

  const dryJson = runCliJson(['booking', '--dry-run']);
  assert.equal(dryJson.status, 0, dryJson.stderr);
  assert.equal(dryJson.result.requested_model, 'typesafe/jev-1.14');
  assert.equal(dryJson.result.file_count, 7);
  assert.equal(findFileEntry(dryJson.result, 'booking/Booking.kt').result_dir, undefined);
  assert.deepEqual(dryJson.result.check_thresholds, {
    no_primitive_obsession: 60,
    named_domain_expressions: 60,
    single_responsibility: 65,
  });

  const deduped = runCliJson(['booking/Booking.kt', 'booking/Room.kt', 'booking/Booking.kt', '--dry-run']);
  assert.deepEqual(deduped.result.file_results?.map((f) => f.file), ['booking/Booking.kt', 'booking/Room.kt']);
});

test('--out writes private 0700/0600 request and result artifacts outside source directories', (t) => {
  const { runCli, root } = createCliTestWorkspace(t);
  const out = join(root, 'with-out');

  const proc = runCli(['booking/Booking.kt', '--rubric', 'readability', '--requirements', 'requirements.md', '--out', out, '--dry-run']);

  assert.equal(proc.status, 0, proc.stderr);
  assert.match(proc.stdout, /Artifacts: .*result\.json/);
  const saved = readSavedJson<JudgeResult>(join(out, 'result.json'));
  const reqPath = join(out, findFileEntry(saved, 'booking/Booking.kt').result_dir!, 'request.json');
  assert.match(readSavedRequest(reqPath).state.requirement ?? '', /Book a room/);
  if (process.platform !== 'win32') {
    assert.equal(statSync(out).mode & 0o077, 0);
    assert.equal(statSync(reqPath).mode & 0o077, 0);
  }
});

test('model flags switch between --deep and --model and reject conflicts or legacy flags with exit 2', (t) => {
  const { runCli, runCliJson } = createCliTestWorkspace(t);

  assert.equal(runCliJson(['booking', '--deep', '--dry-run']).result.requested_model, 'liquid/d1.2-ultra');
  assert.equal(runCliJson(['booking', '--model', 'openai/gpt-5', '--dry-run']).result.requested_model, 'openai/gpt-5');

  const conflict = runCli(['booking', '--deep', '--model', 'liquid/d1.2-ultra', '--dry-run']);
  assert.equal(conflict.status, 2);
  assert.match(conflict.stderr, /Cannot combine --deep and --model/);

  for (const legacyArgs of [
    ['--source', 'booking', '--dry-run'],
    ['booking', '--mode', 'file', '--dry-run'],
    ['booking', '--all', '--dry-run'],
    ['booking', '--format', 'summary', '--dry-run'],
    ['booking', '--fail-on-violation', '--dry-run'],
  ]) {
    const proc = runCli(legacyArgs);
    assert.equal(proc.status, 2);
    assert.match(proc.stderr, /Unknown option/);
  }
});

test('live file scan prints worst-first punch list with deduplicated Rule criteria legend and supports --quiet', (t) => {
  const { runCli } = createCliTestWorkspace(t);

  const proc = runCli(['booking', '--rubric', 'fowler-smells', '--rubric', 'readability', '--concurrency', '2'], { openRouterStub: 'scored' });
  assert.equal(proc.status, 1, proc.stderr);
  assert.match(proc.stdout, /booking\/Booking\.kt\n\s+error\s+no_long_functions\s+\(score 15\/100, pass >= 80\)\n\s+error\s+no_primitive_obsession\s+\(score 50\/100, pass >= 60\)\n\s+warning\s+direct_readability\s+\(score 74\/100, pass >= 80\)/);
  assert.match(proc.stdout, /booking\/Room\.kt\n\s+warning\s+no_long_functions\s+\(score 65\/100, pass >= 80\)/);
  assert.doesNotMatch(proc.stdout, /env\.ts/);
  assert.match(proc.stdout, /Rules:\n\s+no_long_functions\s+1 error, 1 warning\n\s+no_primitive_obsession\s+1 error\n\s+direct_readability\s+1 warning/);
  const criteriaSection = proc.stdout.slice(proc.stdout.indexOf('Rule criteria:'));
  assert.equal((criteriaSection.match(/no_long_functions \(/g) ?? []).length, 1);
  assert.match(proc.stdout, /✖ 2 errors, 2 warnings across 2 of 4 files \(decisions-mock, /);

  const quietProc = runCli(['booking', '--rubric', 'fowler-smells', '--rubric', 'readability', '--quiet'], { openRouterStub: 'scored' });
  assert.equal(quietProc.status, 1, quietProc.stderr);
  assert.doesNotMatch(quietProc.stdout, /booking\/Room\.kt/);
  assert.doesNotMatch(quietProc.stdout, /direct_readability/);
  assert.match(quietProc.stdout, /✖ 2 errors across 1 of 4 files \(decisions-mock, /);
});

test('warning-only and clean runs enforce exit code budgets and omit Rule criteria when no findings are displayed', (t) => {
  const { runCli } = createCliTestWorkspace(t);
  const args = ['booking', '--rubric', 'fowler-smells', '--rubric', 'readability'];

  assert.equal(runCli(args, { openRouterStub: 'warnings-only' }).status, 0);
  assert.equal(runCli([...args, '--fail-on-warning'], { openRouterStub: 'warnings-only' }).status, 1);
  assert.equal(runCli([...args, '--max-warnings', '2'], { openRouterStub: 'warnings-only' }).status, 0);
  assert.equal(runCli([...args, '--max-warnings', '1'], { openRouterStub: 'warnings-only' }).status, 1);

  const warnQuiet = runCli([...args, '--quiet'], { openRouterStub: 'warnings-only' });
  assert.equal(warnQuiet.status, 0);
  assert.match(warnQuiet.stdout, /✓ 0 errors across 4 files/);
  assert.doesNotMatch(warnQuiet.stdout, /Rule criteria:/);

  const clean = runCli(['booking', '--rubric', 'readability'], { openRouterStub: 'pass' });
  assert.equal(clean.status, 0);
  assert.doesNotMatch(clean.stdout, /Rule criteria:/);

  assert.equal(runCli(['booking', '--max-warnings=-1', '--dry-run']).status, 2);
  assert.equal(runCli(['booking', '--max-warnings', 'abc', '--dry-run']).status, 2);
});

test('live --json emits 0-100 scores and severities without legacy probability or confidence fields', (t) => {
  const { runCliJson } = createCliTestWorkspace(t);

  const { status, stderr, stdout, result } = runCliJson(
    ['booking', '--rubric', 'fowler-smells', '--rubric', 'readability'],
    { openRouterStub: 'scored' },
  );

  assert.equal(status, 1, stderr);
  assert.equal(result.quality?.checks.no_long_functions.severity, 'error');
  assert.equal(result.quality?.checks.no_long_functions.min_score, 15);
  assert.equal(result.quality?.checks.no_long_functions.files_errors, 1);
  assert.equal(result.quality?.checks.no_long_functions.files_warnings, 1);
  assert.equal(result.quality?.checks.no_primitive_obsession.pass_threshold, 60);
  assert.equal(result.quality?.checks.direct_readability.severity, 'warning');
  assert.equal(result.quality?.checks.direct_readability.files_errors, undefined);
  assert.equal(stdout.includes('pass_probability'), false);
  assert.equal(stdout.includes('confidence'), false);
});

test('API errors, partial file failures, and echoed API keys exit 2 and redact credentials', (t) => {
  const { runCli, runCliJson, root } = createCliTestWorkspace(t);

  const err400 = runCli(['booking', '--rubric', 'readability', '--model', 'typesafe/jev-1.14.0'], { openRouterStub: 'http-400' });
  assert.equal(err400.status, 2);
  assert.match(err400.stdout, /ERROR:.*HTTP 400: Unknown model: typesafe\/jev-1\.14\.0/);

  const partialErr = runCli(['booking', '--rubric', 'readability'], { openRouterStub: 'partial-400' });
  assert.equal(partialErr.status, 2);
  assert.match(partialErr.stdout, /Files: 3 scored, 1 errored \(4 total\)/);
  assert.match(partialErr.stdout, /booking\/Room\.kt: OpenRouter returned HTTP 400: Invalid request for file/);

  const keyOut = join(root, 'key-echo');
  const keyProc = runCliJson(['module', 'booking', '--rubric', 'readability', '--out', keyOut], { openRouterStub: 'key-echo' });
  assert.equal(keyProc.status, 2);
  assert.match(keyProc.result.error ?? '', /credential material/);
  const savedResp = readFileSync(join(keyOut, 'response.txt'), 'utf8');
  assert.equal(savedResp.includes('fixture-api-key'), false);
  assert.equal(savedResp.includes('[redacted]'), true);
});

test('per-file 128 KiB budget accepts large directories in file mode while rejecting oversized files or bundles', (t) => {
  const { runCli, runCliJson, project } = createCliTestWorkspace(t);
  const largeDir = join(project, 'large-repo');
  mkdirSync(largeDir, { recursive: true });
  const chunk = 'export const line = "1234567890abcdef";\n'.repeat(1200);
  for (const name of ['a.ts', 'b.ts', 'c.ts', 'd.ts']) {
    writeFileSync(join(largeDir, name), chunk);
  }

  assert.equal(runCli(['module', 'large-repo', '--dry-run']).status, 2);
  assert.equal(runCliJson(['large-repo', '--dry-run']).result.file_count, 4);

  writeFileSync(join(largeDir, 'huge.ts'), 'x'.repeat(130 * 1024));
  const hugeReject = runCli(['large-repo', '--dry-run']);
  assert.equal(hugeReject.status, 2);
  assert.match(hugeReject.stderr, /huge\.ts.*128 KiB/);
});

test('invalid rubrics, unsupported files, symlinks, and overlapping --out directories exit 2', (t) => {
  const { source, runCli, project } = createCliTestWorkspace(t);
  const requirementsLink = join(project, 'link.md');
  symlinkSync(join(project, 'requirements.md'), requirementsLink);
  const alias = join(project, 'alias');
  symlinkSync(source, alias);

  const invalidCases: Array<[string[], RegExp]> = [
    [['booking', '--rubric', 'solid-v999', '--dry-run'], /version unavailable/],
    [['booking', '--rubric', 'readability', '--exclude', 'nope', '--dry-run'], /Unknown check ID/],
    [['booking', '--rubric', 'module-design', '--dry-run'], /No file-scoped checks remain/],
    [['booking/BookingTest.kt', '--rubric', 'readability', '--dry-run'], /No supported production/],
    [['booking/types.d.ts', '--dry-run'], /No supported Kotlin or TypeScript files/],
    [['booking/Link.kt', '--dry-run'], /regular source file or directory/],
    [['booking', '--requirements', requirementsLink, '--dry-run'], /regular Markdown or text/],
    [['booking', '--out', join(alias, 'nested', 'scores'), '--dry-run'], /outside the selected source directory/],
  ];

  for (const [args, errorPattern] of invalidCases) {
    const proc = runCli(args);
    assert.equal(proc.status, 2, `Expected exit 2 for ${args.join(' ')}`);
    assert.match(proc.stderr, errorPattern);
    assert.equal(existsSync(join(source, 'nested')), false);
  }
});

test('credential guard blocks heuristic secrets unless --allow-credentials is passed and never allows embedded OPENROUTER_API_KEY', (t) => {
  const { source, runCli } = createCliTestWorkspace(t);

  writeFileSync(join(source, 'Headers.kt'), 'const val apiKey = "X-API-Key"\n');
  const blocked = runCli(['booking', '--dry-run']);
  assert.equal(blocked.status, 2);
  assert.match(blocked.stderr, /Possible credential.*--allow-credentials/);
  assert.equal(runCli(['booking', '--allow-credentials', '--dry-run']).status, 0);

  writeFileSync(join(source, 'Leaked.kt'), 'const val k = "fixture-api-key"\n');
  const leaked = runCli(['booking', '--allow-credentials', '--dry-run'], {
    extraEnv: { OPENROUTER_API_KEY: 'fixture-api-key' },
  });
  assert.equal(leaked.status, 2);
  assert.match(leaked.stderr, /OPENROUTER_API_KEY appears/);
  assert.equal(leaked.stderr.includes('fixture-api-key'), false);
});

test('synthetic test placeholders pass without --allow-credentials while live-looking test secrets still block', (t) => {
  const { project, runCli } = createCliTestWorkspace(t);
  const testDir = join(project, 'auth-tests');
  mkdirSync(testDir, { recursive: true });
  writeFileSync(
    join(testDir, 'emulator.test.ts'),
    [
      "const cfg = { apiKey: 'local-emulator-api-key', clientSecret: 'dev-only-session-secret-change-me' };",
      "const e2e = { accessToken: 'e2e-api-key', password: 'test-password-001' };",
      'export { cfg, e2e };',
      '',
    ].join('\n'),
  );

  const clean = runCli(['auth-tests', '--dry-run']);
  assert.equal(clean.status, 0, clean.stderr);

  writeFileSync(join(testDir, 'leaked.test.ts'), "export const token = 'AIzaSyD-1234567890abcdef1234567890abcde';\n");
  const blocked = runCli(['auth-tests', '--dry-run']);
  assert.equal(blocked.status, 2);
  assert.match(blocked.stderr, /Possible credential.*--allow-credentials/);
});

test('Playwright custom-fixture specs, file-mode playwright.config.ts linting, and module ancestor config auto-attachment work end-to-end', (t) => {
  const { project, root, runCliJson } = createCliTestWorkspace(t);
  const appDir = join(project, 'apps/portal');
  mkdirSync(join(appDir, 'e2e/specs'), { recursive: true });
  mkdirSync(join(appDir, 'src'), { recursive: true });
  writeFileSync(join(appDir, 'package.json'), '{"name":"portal"}\n');
  writeFileSync(
    join(appDir, 'playwright.config.ts'),
    "import { defineConfig } from '@playwright/test';\nexport default defineConfig({ forbidOnly: !!process.env.CI, use: { baseURL: 'http://127.0.0.1:4173', trace: 'on-first-retry' } });\n",
  );
  writeFileSync(
    join(appDir, 'e2e/fixtures.ts'),
    "import { test as base, expect } from '@playwright/test';\nexport const test = base.extend({});\nexport { expect };\n",
  );
  writeFileSync(
    join(appDir, 'e2e/specs/intake.spec.ts'),
    "import { test, expect } from '../fixtures';\ntest('loads intake', async ({ page }) => { await page.goto('/intake'); await expect(page.getByRole('heading')).toBeVisible(); });\n",
  );
  writeFileSync(
    join(appDir, 'e2e/fake-main-api.ts'),
    "import { createServer } from 'node:http';\nexport const startStub = () => createServer();\n",
  );
  writeFileSync(
    join(appDir, 'src/math.test.ts'),
    "import { describe, it, expect } from 'vitest';\ndescribe('math', () => { it('adds', () => expect(1 + 1).toBe(2)); });\n",
  );
  writeFileSync(
    join(appDir, 'src/Button.spec.tsx'),
    "describe('Button', () => { it('renders with Vitest globals', () => { expect(1).toBe(1); }); });\n",
  );

  // 1. File-mode playwright.config.ts is linted (not skipped) with playwright_suite_and_config_diagnostics
  const configOut = join(root, 'pw-config-file');
  const configDry = runCliJson(['apps/portal/playwright.config.ts', '--out', configOut, '--dry-run']);
  assert.equal(configDry.status, 0, configDry.stderr);
  const configEntry = findFileEntry(configDry.result, 'apps/portal/playwright.config.ts');
  assert.equal(configEntry.status, 'dry_run');
  assert.equal(configEntry.file_role, 'test_support_playwright');
  const configReq = readSavedRequest(join(configOut, configEntry.result_dir!, 'request.json'));
  assert.deepEqual(Object.keys(configReq.questions), ['playwright_suite_and_config_diagnostics']);

  // 1b. Explicit --rule playwright_suite_and_config_diagnostics works on playwright.config.ts and skips non-config specs
  const ruleConfigOut = join(root, 'pw-config-rule');
  const ruleConfigDry = runCliJson([
    'apps/portal/playwright.config.ts',
    '--rule', 'playwright_suite_and_config_diagnostics',
    '--out', ruleConfigOut,
    '--dry-run',
  ]);
  assert.equal(ruleConfigDry.status, 0, ruleConfigDry.stderr);
  const ruleConfigEntry = findFileEntry(ruleConfigDry.result, 'apps/portal/playwright.config.ts');
  assert.equal(ruleConfigEntry.status, 'dry_run');
  assert.equal(ruleConfigEntry.file_role, 'test_support_playwright');
  const ruleConfigReq = readSavedRequest(join(ruleConfigOut, ruleConfigEntry.result_dir!, 'request.json'));
  assert.deepEqual(Object.keys(ruleConfigReq.questions), ['playwright_suite_and_config_diagnostics']);

  const ruleSpecDry = runCliJson([
    'apps/portal/e2e/specs/intake.spec.ts',
    '--rule', 'playwright_suite_and_config_diagnostics',
    '--dry-run',
  ]);
  assert.equal(ruleSpecDry.status, 0, ruleSpecDry.stderr);
  assert.equal(findFileEntry(ruleSpecDry.result, 'apps/portal/e2e/specs/intake.spec.ts').status, 'skipped');
  assert.equal(findFileEntry(ruleSpecDry.result, 'apps/portal/e2e/specs/intake.spec.ts').skip_reason, 'not_applicable');

  // 2. Explicit --rubric playwright on a spec importing ../fixtures keeps playwright-v1 checks
  const explicitDry = runCliJson(['apps/portal/e2e/specs/intake.spec.ts', '--rubric', 'playwright', '--dry-run']);
  assert.equal(explicitDry.status, 0, explicitDry.stderr);
  assert.equal(findFileEntry(explicitDry.result, 'apps/portal/e2e/specs/intake.spec.ts').status, 'dry_run');
  assert.equal('playwright_web_first_and_race_free' in Object.fromEntries(
    Object.values(explicitDry.result.rubric_groups).flat().map((id) => [id, true]),
  ), true);

  // 3. Auto file-mode dry-run classifies ../fixtures spec as test:playwright_auto while plain e2e Node stub and Vitest-globals spec stay test:auto
  const autoFileDry = runCliJson([
    'apps/portal/e2e/specs/intake.spec.ts',
    'apps/portal/e2e/fake-main-api.ts',
    'apps/portal/src/Button.spec.tsx',
    '--dry-run',
  ]);
  assert.equal(autoFileDry.status, 0, autoFileDry.stderr);
  assert.equal(findFileEntry(autoFileDry.result, 'apps/portal/e2e/specs/intake.spec.ts').file_role, 'test:playwright_auto');
  assert.equal(findFileEntry(autoFileDry.result, 'apps/portal/e2e/fake-main-api.ts').file_role, 'test:auto');
  assert.equal(findFileEntry(autoFileDry.result, 'apps/portal/src/Button.spec.tsx').file_role, 'test:auto');

  // 4. Module mode on apps/portal/e2e auto-attaches ancestor apps/portal/playwright.config.ts
  const modOut = join(root, 'pw-mod-e2e');
  const modDry = runCliJson(['module', 'apps/portal/e2e', '--out', modOut, '--dry-run']);
  assert.equal(modDry.status, 0, modDry.stderr);
  const modReq = readSavedRequest(join(modOut, 'request.json'));
  assert.equal('playwright.config.ts' in (modReq.state.test_files ?? {}), true);
  assert.equal('playwright_suite_and_config_diagnostics' in modReq.questions, true);

  // 5. Module mode on apps/portal/src (including Vitest-globals Button.spec.tsx) does NOT attach playwright.config.ts
  const unitOut = join(root, 'pw-mod-unit');
  const unitDry = runCliJson(['module', 'apps/portal/src', '--out', unitOut, '--dry-run']);
  assert.equal(unitDry.status, 0, unitDry.stderr);
  const unitReq = readSavedRequest(join(unitOut, 'request.json'));
  assert.equal(Object.keys(unitReq.state.test_files ?? {}).some((f) => f.includes('playwright.config')), false);
});

test('static asset imports do not crash Stage 0 with ENOTDIR and test-support / test-root paths partition cleanly', (t) => {
  const { project, root, runCliJson } = createCliTestWorkspace(t);

  // 1. Test files importing real .css, .json, and dotted .ts modules run cleanly without ENOTDIR
  const featureDir = join(project, 'app/features/jobs');
  mkdirSync(join(featureDir, '.server'), { recursive: true });
  mkdirSync(join(featureDir, 'data'), { recursive: true });
  writeFileSync(join(featureDir, 'styles.css'), '.jobs { display: grid; }\n');
  writeFileSync(join(featureDir, 'data/regions.json'), '{"de":true}\n');
  writeFileSync(
    join(featureDir, 'api.session.ts'),
    "import { test as base, expect } from '@playwright/test';\nexport const test = base;\nexport { expect };\n",
  );
  writeFileSync(
    join(featureDir, 'workspace.browser.test.tsx'),
    "import './styles.css';\nimport regions from './data/regions.json';\nexport const check = () => regions;\n",
  );
  writeFileSync(
    join(featureDir, 'session.spec.ts'),
    "import './styles.css';\nimport './data/regions.json';\nimport { test, expect } from './api.session';\ntest('session', async ({ page }) => { await expect(page).toHaveTitle(/Jobs/); });\n",
  );
  writeFileSync(join(featureDir, '.server/test-support.ts'), 'export const makeJob = () => ({ id: 1 });\n');
  writeFileSync(join(featureDir, 'overview.test-support.ts'), 'export const makeOverview = () => ({ count: 1 });\n');

  const featureDry = runCliJson(['app/features/jobs', '--dry-run']);
  assert.equal(featureDry.status, 0, featureDry.stderr);
  assert.equal(findFileEntry(featureDry.result, 'app/features/jobs/workspace.browser.test.tsx').status, 'dry_run');
  assert.equal(findFileEntry(featureDry.result, 'app/features/jobs/workspace.browser.test.tsx').file_role, 'test:auto');
  assert.equal(findFileEntry(featureDry.result, 'app/features/jobs/session.spec.ts').file_role, 'test:playwright_auto');
  assert.equal(findFileEntry(featureDry.result, 'app/features/jobs/.server/test-support.ts').file_role, 'test:auto');
  assert.equal(findFileEntry(featureDry.result, 'app/features/jobs/overview.test-support.ts').file_role, 'test:auto');
  assert.equal(findFileEntry(featureDry.result, 'app/features/jobs/api.session.ts').file_role, undefined);

  // 2. Directory target src/test/kotlin preserves test-root context in both file and module modes with zero credential halt
  const ktTestDir = join(project, 'src/test/kotlin/com/app');
  mkdirSync(join(ktTestDir, 'testsupport'), { recursive: true });
  writeFileSync(join(ktTestDir, 'Fake.kt'), 'class Fake\n');
  writeFileSync(join(ktTestDir, 'ServiceIdentityFeatureTestSupport.kt'), 'class ServiceIdentityFeatureTestSupport\n');
  writeFileSync(
    join(ktTestDir, 'testsupport/Fixture.kt'),
    'private const val FIREBASE_API_KEY = "test-api-key"\nprivate const val RESEND_API_KEY = "fixture-api-key"\n',
  );

  const ktFileDry = runCliJson(['src/test/kotlin', '--dry-run']);
  assert.equal(ktFileDry.status, 0, ktFileDry.stderr);
  for (const rel of [
    'src/test/kotlin/com/app/Fake.kt',
    'src/test/kotlin/com/app/ServiceIdentityFeatureTestSupport.kt',
    'src/test/kotlin/com/app/testsupport/Fixture.kt',
  ]) {
    assert.equal(findFileEntry(ktFileDry.result, rel).file_role, 'test:auto');
  }

  const ktModOut = join(root, 'kt-test-mod');
  const ktModDry = runCliJson(['module', 'src/test/kotlin', '--out', ktModOut, '--dry-run']);
  assert.equal(ktModDry.status, 0, ktModDry.stderr);
  const ktModReq = readSavedRequest(join(ktModOut, 'request.json'));
  assert.equal(ktModReq.state.production_files, undefined);
  assert.deepEqual(
    Object.keys(ktModReq.state.test_files ?? {}).sort(),
    ['com/app/Fake.kt', 'com/app/ServiceIdentityFeatureTestSupport.kt', 'com/app/testsupport/Fixture.kt'],
  );

  // 3. Temp ancestor directory named "test" outside repoRoot MUST NOT turn production code into tests
  const nestedProdRepo = join(root, 'test', 'prod-repo');
  mkdirSync(join(nestedProdRepo, 'src'), { recursive: true });
  writeFileSync(join(nestedProdRepo, 'src/app.ts'), 'export const ready = true;\n');
  const prodDry = runCliJson(['src', '--dry-run'], { cwd: nestedProdRepo });
  assert.equal(prodDry.status, 0, prodDry.stderr);
  assert.equal(findFileEntry(prodDry.result, 'src/app.ts').file_role, undefined);
});
