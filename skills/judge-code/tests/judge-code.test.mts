import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';

const SKILL = fileURLToPath(new URL('..', import.meta.url));

const MOCK = `
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const mode = process.env.JUDGE_TEST_MODE;
const outIdx = process.argv.indexOf('--out');
const out = outIdx !== -1 ? process.argv[outIdx + 1] : null;
const firstArg = process.argv[2];
const isModuleCmd = firstArg === 'module';
const isStructureCmd = firstArg === 'structure';
const isFileCmd = !isModuleCmd && !isStructureCmd && firstArg !== 'list' && firstArg !== 'explain';
let calls = 0;

globalThis.fetch = async (endpoint, init) => {
  calls += 1;
  assert.equal(endpoint, 'https://openrouter.ai/api/alpha/decisions');
  assert.equal(init.redirect, 'error');
  assert.equal(init.headers.Authorization, 'Bearer fixture-api-key');

  if (mode === 'http-error') return new Response('rate limit', { status: 429 });
  if (mode === 'http-400') {
    return new Response(
      JSON.stringify({ error: { message: 'Unknown model: typesafe/jev-1.14.0' } }),
      { status: 400, headers: { 'Content-Type': 'application/json' } },
    );
  }
  if (mode === 'key-echo') return new Response('echo fixture-api-key', { status: 500 });

  const json = JSON.parse(init.body);
  const fileNames = Object.keys(json.state.production_files ?? {});
  const singleFile = isFileCmd && fileNames.length === 1 ? fileNames[0] : null;
  if (mode === 'partial-400' && singleFile?.endsWith('Room.kt')) {
    return new Response(
      JSON.stringify({ error: { message: 'Invalid request for file' } }),
      { status: 400, headers: { 'Content-Type': 'application/json' } },
    );
  }

  const answers = Object.fromEntries(Object.keys(json.questions).map((id) => {
    let passProb = 0.92;
    let choice = 'pass';
    if (mode === 'pass') {
      passProb = 0.92;
      choice = 'pass';
    } else if (mode === 'conventions-fail') {
      if (id === 'follows_repo_conventions') {
        passProb = 0.25;
        choice = 'fail';
      }
    } else if (mode === 'warnings-only') {
      if (singleFile?.endsWith('Room.kt') && id === 'no_long_functions') {
        passProb = 0.65;
        choice = 'pass';
      } else if (singleFile?.endsWith('Booking.kt') && id === 'direct_readability') {
        passProb = 0.74;
        choice = 'pass';
      } else if (!isFileCmd && id === 'no_unnecessary_abstraction') {
        passProb = 0.65;
        choice = 'pass';
      }
    } else if (singleFile?.endsWith('Booking.kt')) {
      if (id === 'no_long_functions') { passProb = 0.15; choice = 'fail'; }
      else if (id === 'no_primitive_obsession') { passProb = 0.50; choice = 'pass'; }
      else if (id === 'direct_readability') { passProb = 0.74; choice = 'pass'; }
    } else if (singleFile?.endsWith('Room.kt')) {
      if (id === 'no_long_functions') { passProb = 0.65; choice = 'pass'; }
    } else if (!isFileCmd) {
      const fail = ['direct_readability', 'modular_organization', 'single_responsibility', 'no_junk_drawer_directories'].includes(id);
      const borderline = id === 'no_unnecessary_abstraction';
      passProb = fail ? 0.2 : borderline ? 0.65 : 0.9;
      choice = fail ? 'fail' : 'pass';
    }
    return [id, {
      type: 'choice',
      choice,
      probabilities: { pass: passProb, fail: Number((1 - passProb).toFixed(4)) },
      confidence: Number(Math.abs(2 * passProb - 1).toFixed(4)),
    }];
  }));
  return Response.json({ model: 'decisions-mock', answers });
};

process.on('exit', () => {
  if (['preview', 'reject'].includes(mode)) {
    assert.equal(calls, 0);
  }
});
`;

function setup(t: TestContext, projectSubdir = 'project') {
  const root = mkdtempSync(join(tmpdir(), 'installed-judge-code-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const installed = join(root, 'installed');
  const project = join(root, projectSubdir);
  const source = join(project, 'booking');
  cpSync(SKILL, installed, { recursive: true });
  mkdirSync(source, { recursive: true });

  const fixtures: Record<string, string> = {
    'Booking.kt': 'package booking\nclass Booking(val room: Room)\n',
    'Room.kt': 'package booking\nclass Room\n',
    'env.ts': 'export const PORT = 8080;\n',
    'password.ts': 'export type PasswordHash = string;\n',
    'tests/Fixture.kt': 'excluded',
    '.hidden/Hidden.kt': 'excluded',
    'dist/output.ts': 'excluded',
    'BookingTest.kt': 'excluded',
    'types.d.ts': 'excluded',
    'fixture.spec.tsx': 'excluded',
  };
  for (const [file, text] of Object.entries(fixtures)) {
    const path = join(source, file);
    if (file.includes('/')) mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, text);
  }
  writeFileSync(join(project, 'Outside.kt'), 'excluded');
  symlinkSync(join(project, 'Outside.kt'), join(source, 'Link.kt'));
  writeFileSync(join(project, 'requirements.md'), 'Book a room.\n');
  writeFileSync(join(project, 'conventions.md'), 'Use mutable JPA entities when annotated with @Entity.\n');

  const mock = join(root, 'mock.mjs');
  writeFileSync(mock, MOCK);

  function run(mode: string, args: string[], extraEnv: Record<string, string> = {}, cwd = project) {
    const env = { ...process.env, JUDGE_TEST_MODE: mode };
    delete env.OPENROUTER_API_KEY;
    if (!['preview', 'reject'].includes(mode)) env.OPENROUTER_API_KEY = 'fixture-api-key';
    Object.assign(env, extraEnv);
    return spawnSync(process.execPath, ['--import', mock, join(installed, 'scripts/judge-code.mts'), ...args], {
      cwd,
      env,
      encoding: 'utf8',
    });
  }

  return { source, root, project, installed, run };
}

function runGit(cwd: string, args: string[]): string {
  const proc = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.ifError(proc.error);
  assert.equal(proc.status, 0, `git ${args.join(' ')} failed: ${proc.stderr}`);
  return proc.stdout.trim();
}

test('list subcommand and --list-rubrics print bundled rubrics, versions, check IDs, scopes, and thresholds', (t) => {
  const { run } = setup(t);
  for (const args of [['list'], ['--list-rubrics']]) {
    const proc = run('preview', args);
    assert.equal(proc.status, 0, proc.stderr);
    assert.match(proc.stdout, /api-design \(api-design-v3\): no_rigid_enums_for_editorial_labels \[file\], cohesive_resource_boundaries \[module\]/);
    assert.match(proc.stdout, /domain-modelling \(domain-modelling-v3\): immutable_state \[file\], domain_invariants \[module\], boundary_separation \[module\]/);
    assert.match(proc.stdout, /fowler-smells \(fowler-smells-v1\): no_duplicated_code \[module\], no_long_functions \[file\].*no_primitive_obsession \[file, >=60\]/);
    assert.match(proc.stdout, /integration-readiness \(integration-readiness-v3\): no_prod_fixture_or_demo_contamination \[file\], clean_api_contract_boundary \[file\]/);
    assert.match(proc.stdout, /integration-readiness-structure \(integration-readiness-structure-v1\) \[structure\]: no_bundled_stub_or_demo_modules \[structure\]/);
    assert.match(proc.stdout, /module-design \(module-design-v2\): modular_organization \[module\], no_unnecessary_abstraction \[module\]/);
    assert.match(proc.stdout, /react \(react-v1\) \[applies: \*\.tsx \| imports: react, react-dom\]: react_effect_lifecycle \[file, >=70\]/);
    assert.match(proc.stdout, /readability \(readability-v2\): direct_readability \[file\], named_domain_expressions \[file, >=60\]/);
    assert.match(proc.stdout, /solid \(solid-v3\): single_responsibility \[file, >=65\], open_closed \[file\], liskov_substitution \[module\], interface_segregation \[module\], dependency_inversion \[module\]/);
  }

  const badList = run('reject', ['list', 'extra-arg']);
  assert.equal(badList.status, 2);
  assert.match(badList.stderr, /Unexpected arguments/);
});

test('default file-by-file linter accepts positional paths, runs all file-scoped checks with jev-1.14, needs no --out, and rejects legacy flags', (t) => {
  const { run, root } = setup(t);

  // Default dry-run without --out writes no files and runs all 18 bundled file-scoped checks with typesafe/jev-1.14
  const dryText = run('preview', ['booking', '--dry-run']);
  assert.equal(dryText.status, 0, dryText.stderr);
  assert.match(dryText.stdout, /DRY RUN \(file\): 4 files, 18 checks \[openrouter: typesafe\/jev-1\.14\]/);
  assert.match(dryText.stdout, /booking\/Booking\.kt/);
  assert.doesNotMatch(dryText.stdout, /Artifacts:/);

  // Same call with --json returns full structured JudgeResult without --out
  const dryJson = run('preview', ['booking', '--dry-run', '--json']);
  assert.equal(dryJson.status, 0, dryJson.stderr);
  const res = JSON.parse(dryJson.stdout);
  assert.equal(res.status, 'dry_run');
  assert.equal(res.mode, 'file');
  assert.equal(res.requested_model, 'typesafe/jev-1.14');
  assert.equal(res.file_count, 4);
  assert.deepEqual(
    res.file_results.map((entry: { file: string }) => entry.file),
    ['booking/Booking.kt', 'booking/env.ts', 'booking/password.ts', 'booking/Room.kt'].sort((a, b) => a.localeCompare(b)),
  );
  assert.equal('result_dir' in res.file_results[0], false);
  assert.equal(Object.values(res.rubric_groups).flat().length, 18);
  assert.ok(res.rubric_groups.solid.includes('single_responsibility'));
  assert.ok(res.skipped_module_checks.includes('dependency_inversion'));
  assert.equal(res.pass_threshold, 80);
  assert.deepEqual(res.check_thresholds, {
    no_primitive_obsession: 60,
    named_domain_expressions: 60,
    single_responsibility: 65,
  });

  // Multiple positional paths deduplicate overlapping files
  const multiProc = run('preview', ['booking/Booking.kt', 'booking/Room.kt', 'booking/Booking.kt', '--dry-run', '--json']);
  assert.equal(multiProc.status, 0, multiProc.stderr);
  const multiRes = JSON.parse(multiProc.stdout);
  assert.equal(multiRes.file_count, 2);
  assert.deepEqual(multiRes.file_results.map((f: { file: string }) => f.file), ['booking/Booking.kt', 'booking/Room.kt']);

  // --deep switches file mode to liquid/d1.2-ultra; --model overrides explicitly
  const deepProc = run('preview', ['booking', '--deep', '--dry-run', '--json']);
  assert.equal(deepProc.status, 0, deepProc.stderr);
  assert.equal(JSON.parse(deepProc.stdout).requested_model, 'liquid/d1.2-ultra');

  const modelProc = run('preview', ['booking', '--model', 'openai/gpt-5', '--dry-run', '--json']);
  assert.equal(modelProc.status, 0, modelProc.stderr);
  assert.equal(JSON.parse(modelProc.stdout).requested_model, 'openai/gpt-5');

  // Combining --deep and --model is rejected with exit 2
  const conflict = run('reject', ['booking', '--deep', '--model', 'liquid/d1.2-ultra', '--dry-run']);
  assert.equal(conflict.status, 2);
  assert.match(conflict.stderr, /Cannot combine --deep and --model/);

  // Legacy flags have NO backwards-compatibility aliases and exit 2
  for (const legacyArgs of [
    ['--source', 'booking', '--dry-run'],
    ['booking', '--mode', 'file', '--dry-run'],
    ['booking', '--all', '--dry-run'],
    ['booking', '--format', 'summary', '--dry-run'],
    ['booking', '--fail-on-violation', '--dry-run'],
  ]) {
    const proc = run('reject', legacyArgs);
    assert.equal(proc.status, 2, `Expected legacy args ${legacyArgs.join(' ')} to fail with exit 2`);
    assert.match(proc.stderr, /Unknown option/);
  }

  // Optional --out writes 0700/0600 artifacts and prints Artifacts line
  const out = join(root, 'with-out');
  const outProc = run('preview', ['booking/Booking.kt', '--rubric', 'readability', '--out', out, '--dry-run']);
  assert.equal(outProc.status, 0, outProc.stderr);
  assert.match(outProc.stdout, new RegExp(`Artifacts: .*result\\.json`));
  assert.ok(existsSync(join(out, 'result.json')));
  const saved = JSON.parse(readFileSync(join(out, 'result.json'), 'utf8'));
  const reqPath = join(out, saved.file_results[0].result_dir, 'request.json');
  assert.ok(existsSync(reqPath));
  if (process.platform !== 'win32') {
    assert.equal(statSync(out).mode & 0o077, 0);
    assert.equal(statSync(reqPath).mode & 0o077, 0);
  }
});

test('ESLint-style error vs. warning output, --quiet, and standard linter exit codes 0 / 1 / 2', (t) => {
  const { run, root } = setup(t);

  // Live file-mode run with both errors and warnings -> exits 1, shows worst-first files + rule breakdown + final line
  const proc = run('scored', ['booking', '--rubric', 'fowler-smells', '--rubric', 'readability', '--concurrency', '2']);
  assert.equal(proc.status, 1, proc.stderr);
  // Booking.kt has 2 errors (no_long_functions 15/100, no_primitive_obsession 50/100) + 1 warning (direct_readability 74/100)
  // Room.kt has 0 errors + 1 warning (no_long_functions 65/100)
  // env.ts and password.ts are clean -> omitted from punch list
  assert.match(proc.stdout, /booking\/Booking\.kt\n\s+error\s+no_long_functions\s+\(score 15\/100, pass >= 80\)\n\s+error\s+no_primitive_obsession\s+\(score 50\/100, pass >= 60\)\n\s+warning\s+direct_readability\s+\(score 74\/100, pass >= 80\)/);
  assert.match(proc.stdout, /booking\/Room\.kt\n\s+warning\s+no_long_functions\s+\(score 65\/100, pass >= 80\)/);
  assert.doesNotMatch(proc.stdout, /env\.ts/);
  assert.doesNotMatch(proc.stdout, /password\.ts/);
  assert.match(proc.stdout, /Rules:\n\s+no_long_functions\s+1 error, 1 warning\n\s+no_primitive_obsession\s+1 error\n\s+direct_readability\s+1 warning/);
  assert.match(proc.stdout, /✖ 2 errors, 2 warnings across 2 of 4 files \(decisions-mock, /);
  assert.ok(proc.stdout.indexOf('booking/Booking.kt') < proc.stdout.indexOf('booking/Room.kt'));
  assert.doesNotMatch(proc.stdout, /Artifacts:/);

  // --quiet hides warnings and warning-only files (Room.kt omitted!) while still exiting 1 on errors
  const quietProc = run('scored', ['booking', '--rubric', 'fowler-smells', '--rubric', 'readability', '--quiet']);
  assert.equal(quietProc.status, 1, quietProc.stderr);
  assert.match(quietProc.stdout, /booking\/Booking\.kt/);
  assert.doesNotMatch(quietProc.stdout, /booking\/Room\.kt/);
  assert.doesNotMatch(quietProc.stdout, /warning/);
  assert.match(quietProc.stdout, /✖ 2 errors across 1 of 4 files \(decisions-mock, /);

  // Warnings-only run: exit 0 by default, exit 1 with --fail-on-warning or exceeded --max-warnings, exit 0 within --max-warnings
  const warnDefault = run('warnings-only', ['booking', '--rubric', 'fowler-smells', '--rubric', 'readability']);
  assert.equal(warnDefault.status, 0, warnDefault.stderr);
  assert.match(warnDefault.stdout, /✖ 0 errors, 2 warnings across 2 of 4 files/);

  const warnQuiet = run('warnings-only', ['booking', '--rubric', 'fowler-smells', '--rubric', 'readability', '--quiet']);
  assert.equal(warnQuiet.status, 0, warnQuiet.stderr);
  assert.match(warnQuiet.stdout, /✓ 0 errors across 4 files/);
  assert.doesNotMatch(warnQuiet.stdout, /Booking\.kt/);
  assert.doesNotMatch(warnQuiet.stdout, /Room\.kt/);

  const warnFailFlag = run('warnings-only', ['booking', '--rubric', 'fowler-smells', '--rubric', 'readability', '--fail-on-warning']);
  assert.equal(warnFailFlag.status, 1, warnFailFlag.stderr);

  const warnWithinBudget = run('warnings-only', ['booking', '--rubric', 'fowler-smells', '--rubric', 'readability', '--max-warnings', '2']);
  assert.equal(warnWithinBudget.status, 0, warnWithinBudget.stderr);

  const warnOverBudget = run('warnings-only', ['booking', '--rubric', 'fowler-smells', '--rubric', 'readability', '--max-warnings', '1']);
  assert.equal(warnOverBudget.status, 1, warnOverBudget.stderr);

  // Clean run exits 0 with ✓
  const cleanProc = run('pass', ['booking', '--rubric', 'readability']);
  assert.equal(cleanProc.status, 0, cleanProc.stderr);
  assert.match(cleanProc.stdout, /✓ 0 errors, 0 warnings across 4 files \(decisions-mock, /);

  // --json emits structured JudgeResult with 0-100 score, min_score, severity, and zero confidence/pass_probability fields
  const jsonProc = run('scored', ['booking', '--rubric', 'fowler-smells', '--rubric', 'readability', '--json']);
  assert.equal(jsonProc.status, 1, jsonProc.stderr);
  const jsonRes = JSON.parse(jsonProc.stdout);
  assert.equal(jsonRes.status, 'scored');
  assert.equal(jsonRes.pass_threshold, 80);
  assert.deepEqual(jsonRes.check_thresholds, {
    no_primitive_obsession: 60,
    named_domain_expressions: 60,
  });
  assert.equal(jsonRes.quality.checks.no_long_functions.severity, 'error');
  assert.equal(jsonRes.quality.checks.no_long_functions.min_score, 15);
  assert.equal(jsonRes.quality.checks.no_long_functions.files_errors, 1);
  assert.equal(jsonRes.quality.checks.no_long_functions.files_warnings, 1);
  assert.equal(jsonRes.quality.checks.no_primitive_obsession.severity, 'error');
  assert.equal(jsonRes.quality.checks.no_primitive_obsession.min_score, 50);
  assert.equal(jsonRes.quality.checks.no_primitive_obsession.pass_threshold, 60);
  assert.equal(jsonRes.quality.checks.direct_readability.severity, 'warning');
  assert.equal(jsonRes.quality.checks.direct_readability.min_score, 74);
  assert.equal(jsonRes.quality.checks.direct_readability.files_warnings, 1);
  assert.equal('files_errors' in jsonRes.quality.checks.direct_readability, false);
  // Ensure pass_probability, min_pass_probability, and confidence are completely absent
  assert.equal(jsonProc.stdout.includes('pass_probability'), false);
  assert.equal(jsonProc.stdout.includes('confidence'), false);

  // Scoring/transport errors exit 2
  const err400 = run('http-400', ['booking', '--rubric', 'readability', '--model', 'typesafe/jev-1.14.0']);
  assert.equal(err400.status, 2);
  assert.match(err400.stdout, /ERROR:.*HTTP 400: Unknown model: typesafe\/jev-1\.14\.0/);

  const partialErr = run('partial-400', ['booking', '--rubric', 'readability']);
  assert.equal(partialErr.status, 2);
  assert.match(partialErr.stdout, /Files: 3 scored, 1 errored \(4 total\)/);
  assert.match(partialErr.stdout, /booking\/Room\.kt: OpenRouter returned HTTP 400: Invalid request for file/);

  // Key echo redaction with --out exits 2
  const keyOut = join(root, 'key-echo');
  const keyProc = run('key-echo', ['module', 'booking', '--rubric', 'readability', '--out', keyOut, '--json']);
  assert.equal(keyProc.status, 2);
  assert.match(JSON.parse(keyProc.stdout).error, /credential material/);
  const savedResp = readFileSync(join(keyOut, 'response.txt'), 'utf8');
  assert.ok(!savedResp.includes('fixture-api-key'));
  assert.ok(savedResp.includes('[redacted]'));

  // Invalid --max-warnings exits 2
  const badMaxWarnNeg = run('reject', ['booking', '--max-warnings=-1', '--dry-run']);
  assert.equal(badMaxWarnNeg.status, 2);
  assert.match(badMaxWarnNeg.stderr, /Invalid --max-warnings/);
  const badMaxWarnStr = run('reject', ['booking', '--max-warnings', 'abc', '--dry-run']);
  assert.equal(badMaxWarnStr.status, 2);
  assert.match(badMaxWarnStr.stderr, /Invalid --max-warnings/);
});

test('auto-discovers AGENTS.md, supports CLI --ignore/--exclude, ignores any .judge-code.json, and respects --conventions / --no-conventions', (t) => {
  const { run, root, project, source } = setup(t);

  // Add repo-specific helper file + AGENTS.md + a .judge-code.json file that must be ignored
  writeFileSync(join(source, 'booking-test-support.ts'), 'export const helper = true;\n');
  writeFileSync(join(project, 'AGENTS.md'), '# Project Rules\nUse explicit Result types.\n');
  writeFileSync(join(project, '.judge-code.json'), JSON.stringify({
    ignore: ['Booking.kt'],
    exclude: ['direct_readability'],
    conventions: false,
    modules: [{ name: 'booking-mod', path: 'booking' }],
  }, null, 2));

  // Auto-loads AGENTS.md in file mode and ignores .judge-code.json completely
  const out = join(root, 'auto-agents');
  const proc = run('preview', ['booking', '--out', out, '--dry-run', '--json']);
  assert.equal(proc.status, 0, proc.stderr);
  const res = JSON.parse(proc.stdout);
  assert.equal('ignored_patterns' in res, false);
  assert.equal('excluded_checks' in res, false);
  assert.ok(res.file_results.some((f: { file: string }) => f.file.endsWith('Booking.kt')));
  assert.ok(res.file_results.some((f: { file: string }) => f.file.endsWith('booking-test-support.ts')));
  const firstReq = JSON.parse(readFileSync(join(out, res.file_results[0].result_dir, 'request.json'), 'utf8'));
  assert.match(firstReq.state.conventions, /Use explicit Result types/);
  assert.match(firstReq.questions.direct_readability.instructions, /state\.conventions takes precedence/);

  // Auto-loads AGENTS.md in module mode and adds follows_repo_conventions
  const modOut = join(root, 'mod-agents');
  const modProc = run('preview', ['module', 'booking', '--ignore', '*-test-support.*', '--ignore', 'password.ts', '--out', modOut, '--dry-run', '--json']);
  assert.equal(modProc.status, 0, modProc.stderr);
  const modRes = JSON.parse(modProc.stdout);
  assert.equal(modRes.mode, 'code');
  assert.equal(modRes.target, 'booking');
  const modReq = JSON.parse(readFileSync(join(modOut, 'request.json'), 'utf8'));
  assert.equal('password.ts' in modReq.state.production_files, false);
  assert.equal('booking-test-support.ts' in modReq.state.production_files, false);
  assert.ok('Booking.kt' in modReq.state.production_files);
  assert.ok('follows_repo_conventions' in modReq.questions);

  // CLI --ignore and --exclude customize runs directly
  const custom = run('preview', ['booking', '--ignore', '*-test-support.*', '--ignore', 'env.ts', '--exclude', 'no_comment_deodorant_or_dead_code', '--exclude', 'immutable_state', '--dry-run', '--json']);
  assert.equal(custom.status, 0, custom.stderr);
  const customRes = JSON.parse(custom.stdout);
  assert.deepEqual(customRes.ignored_patterns, ['*-test-support.*', 'env.ts']);
  assert.deepEqual(customRes.excluded_checks, ['no_comment_deodorant_or_dead_code', 'immutable_state']);
  assert.ok(!customRes.file_results.some((f: { file: string }) => f.file.endsWith('env.ts')));
  assert.ok(!customRes.file_results.some((f: { file: string }) => f.file.includes('booking-test-support.ts')));

  // --no-conventions disables auto-loaded AGENTS.md
  const noConvOut = join(root, 'no-conv');
  const noConv = run('preview', ['booking/Booking.kt', '--no-conventions', '--out', noConvOut, '--dry-run', '--json']);
  assert.equal(noConv.status, 0, noConv.stderr);
  const noConvRes = JSON.parse(noConv.stdout);
  const noConvReq = JSON.parse(readFileSync(join(noConvOut, noConvRes.file_results[0].result_dir, 'request.json'), 'utf8'));
  assert.equal('conventions' in noConvReq.state, false);

  // --conventions overrides AGENTS.md; combining --conventions and --no-conventions fails with exit 2
  const overrideOut = join(root, 'override-conv');
  const overrideProc = run('preview', ['booking/Booking.kt', '--conventions', 'conventions.md', '--out', overrideOut, '--dry-run', '--json']);
  assert.equal(overrideProc.status, 0, overrideProc.stderr);
  const overrideRes = JSON.parse(overrideProc.stdout);
  const overrideReq = JSON.parse(readFileSync(join(overrideOut, overrideRes.file_results[0].result_dir, 'request.json'), 'utf8'));
  assert.match(overrideReq.state.conventions, /mutable JPA entities/);

  const conflictConv = run('reject', ['booking', '--conventions', 'conventions.md', '--no-conventions', '--dry-run']);
  assert.equal(conflictConv.status, 2);
  assert.match(conflictConv.stderr, /Cannot combine --conventions and --no-conventions/);

  // --config flag is not supported (rejected with exit 2)
  const cfgFlag = run('reject', ['booking', '--config', '.judge-code.json', '--dry-run']);
  assert.equal(cfgFlag.status, 2);
  assert.match(cfgFlag.stderr, /Unknown option/);

  // `judge-code module` requires explicit path arguments (no .judge-code.json fallback)
  const modMissingArgs = run('reject', ['module', '--dry-run']);
  assert.equal(modMissingArgs.status, 2);
  assert.match(modMissingArgs.stderr, /Specify one or more paths for `judge-code module <path\.\.\.>`/);
});

test('--changed resolves modified, staged, and untracked files vs main or HEAD fallback, supports path filters, and exits 0 when clean', (t) => {
  const { run, root } = setup(t);
  const gitRepo = join(root, 'git-repo');
  mkdirSync(join(gitRepo, 'src/a'), { recursive: true });
  mkdirSync(join(gitRepo, 'src/b'), { recursive: true });
  runGit(gitRepo, ['init', '-b', 'main']);
  runGit(gitRepo, ['config', 'user.email', 'test@example.com']);
  runGit(gitRepo, ['config', 'user.name', 'Test User']);

  writeFileSync(join(gitRepo, 'src/a/one.ts'), 'export const one = 1;\n');
  writeFileSync(join(gitRepo, 'src/b/two.ts'), 'export const two = 2;\n');
  writeFileSync(join(gitRepo, 'README.md'), '# Demo\n');
  runGit(gitRepo, ['add', '.']);
  runGit(gitRepo, ['commit', '-m', 'Initial commit']);

  // Clean working tree -> exits 0 with 0 files and 0 API calls
  const cleanChanged = run('preview', ['--changed', '--json'], {}, gitRepo);
  assert.equal(cleanChanged.status, 0, cleanChanged.stderr);
  const cleanRes = JSON.parse(cleanChanged.stdout);
  assert.equal(cleanRes.status, 'scored');
  assert.equal(cleanRes.file_count, 0);
  assert.deepEqual(cleanRes.file_results, []);

  // Feature branch with committed change + unstaged change + untracked production file + untracked test file
  runGit(gitRepo, ['checkout', '-b', 'feat/demo']);
  writeFileSync(join(gitRepo, 'src/a/one.ts'), 'export const one = 10;\n');
  runGit(gitRepo, ['add', 'src/a/one.ts']);
  runGit(gitRepo, ['commit', '-m', 'Update one']);
  writeFileSync(join(gitRepo, 'src/b/new-file.ts'), 'export const added = true;\n');
  writeFileSync(join(gitRepo, 'src/b/new-file.test.ts'), 'export const t = true;\n');
  writeFileSync(join(gitRepo, 'README.md'), '# Updated\n');

  const branchChanged = run('preview', ['--changed', '--dry-run', '--json'], {}, gitRepo);
  assert.equal(branchChanged.status, 0, branchChanged.stderr);
  const branchRes = JSON.parse(branchChanged.stdout);
  assert.deepEqual(
    branchRes.file_results.map((f: { file: string }) => f.file),
    ['src/a/one.ts', 'src/b/new-file.ts'],
  );

  // Explicit base ref `--changed HEAD` only sees working tree changes (new-file.ts), not committed one.ts
  const headChanged = run('preview', ['--changed', 'HEAD', '--dry-run', '--json'], {}, gitRepo);
  assert.equal(headChanged.status, 0, headChanged.stderr);
  assert.deepEqual(
    JSON.parse(headChanged.stdout).file_results.map((f: { file: string }) => f.file),
    ['src/b/new-file.ts'],
  );

  // `--changed=HEAD` form also works
  const eqChanged = run('preview', ['--changed=HEAD', '--dry-run', '--json'], {}, gitRepo);
  assert.equal(eqChanged.status, 0, eqChanged.stderr);
  assert.deepEqual(
    JSON.parse(eqChanged.stdout).file_results.map((f: { file: string }) => f.file),
    ['src/b/new-file.ts'],
  );

  // Positional path filter narrows `--changed` to that directory
  const filteredChanged = run('preview', ['--changed', 'src/a', '--dry-run', '--json'], {}, gitRepo);
  assert.equal(filteredChanged.status, 0, filteredChanged.stderr);
  assert.deepEqual(
    JSON.parse(filteredChanged.stdout).file_results.map((f: { file: string }) => f.file),
    ['src/a/one.ts'],
  );

  // Fallback to HEAD when no `main` branch exists
  const trunkRepo = join(root, 'trunk-repo');
  mkdirSync(join(trunkRepo, 'src'), { recursive: true });
  runGit(trunkRepo, ['init', '-b', 'trunk']);
  runGit(trunkRepo, ['config', 'user.email', 'test@example.com']);
  runGit(trunkRepo, ['config', 'user.name', 'Test User']);
  writeFileSync(join(trunkRepo, 'src/core.ts'), 'export const x = 1;\n');
  runGit(trunkRepo, ['add', '.']);
  runGit(trunkRepo, ['commit', '-m', 'Initial']);
  writeFileSync(join(trunkRepo, 'src/core.ts'), 'export const x = 2;\n');

  const fallbackProc = run('preview', ['--changed', '--dry-run', '--json'], {}, trunkRepo);
  assert.equal(fallbackProc.status, 0, fallbackProc.stderr);
  assert.deepEqual(
    JSON.parse(fallbackProc.stdout).file_results.map((f: { file: string }) => f.file),
    ['src/core.ts'],
  );

  // Unknown git ref exits 2; non-git dir exits 2; `--changed` on `module` exits 2
  const badRef = run('reject', ['--changed', 'does-not-exist-ref', '--dry-run'], {}, gitRepo);
  assert.equal(badRef.status, 2);
  assert.match(badRef.stderr, /Unknown git base ref/);

  const nonGit = run('reject', ['--changed', '--dry-run']);
  assert.equal(nonGit.status, 2);
  assert.match(nonGit.stderr, /requires a git repository/);

  const changedModule = run('reject', ['module', '--changed', '--dry-run'], {}, gitRepo);
  assert.equal(changedModule.status, 2);
  assert.match(changedModule.stderr, /only supported for file linting/);
});

test('module subcommand runs file + module checks with liquid/d1.2-ultra across single and multi-directory bundles', (t) => {
  const { run, root, project } = setup(t);

  // Single module directory defaults to liquid/d1.2-ultra and includes both file and module checks
  const out = join(root, 'mod-single');
  const proc = run('preview', ['module', 'booking', '--out', out, '--dry-run', '--json']);
  assert.equal(proc.status, 0, proc.stderr);
  const res = JSON.parse(proc.stdout);
  assert.equal(res.mode, 'code');
  assert.equal(res.target, 'booking');
  assert.equal(res.requested_model, 'liquid/d1.2-ultra');
  assert.equal(res.file_count, 4);
  assert.ok(res.rubric_groups.solid.includes('single_responsibility'));
  assert.ok(res.rubric_groups.readability.includes('direct_readability'));

  // Live single-module run formats ESLint-style punch list and exits 1 on errors
  const liveProc = run('scored', ['module', 'booking', '--rubric', 'readability', '--rubric', 'module-design']);
  assert.equal(liveProc.status, 1, liveProc.stderr);
  assert.match(liveProc.stdout, /booking\n\s+error\s+direct_readability\s+\(score 20\/100, pass >= 80\)\n\s+error\s+modular_organization\s+\(score 20\/100, pass >= 80\)\n\s+warning\s+no_unnecessary_abstraction\s+\(score 65\/100, pass >= 80\)/);
  assert.match(liveProc.stdout, /✖ 2 errors, 1 warning across 1 module \(4 files\)/);

  // Multi-directory module scan evaluates each directory concurrently and prints per-module blocks
  const featA = join(project, 'features/auth');
  const featB = join(project, 'features/billing');
  mkdirSync(featA, { recursive: true });
  mkdirSync(featB, { recursive: true });
  writeFileSync(join(featA, 'login.ts'), 'export const login = () => true;\n');
  writeFileSync(join(featB, 'charge.ts'), 'export const charge = () => 1;\n');

  const multiOut = join(root, 'mod-multi');
  const multiProc = run('scored', ['module', 'features/auth', 'features/billing', '--rubric', 'module-design', '--out', multiOut]);
  assert.equal(multiProc.status, 1, multiProc.stderr);
  assert.match(multiProc.stdout, /features\/auth/);
  assert.match(multiProc.stdout, /features\/billing/);
  assert.match(multiProc.stdout, /✖ 2 errors, 2 warnings across 2 of 2 modules/);
  const savedMulti = JSON.parse(readFileSync(join(multiOut, 'result.json'), 'utf8'));
  assert.equal(savedMulti.module_results.length, 2);
  assert.ok(existsSync(join(multiOut, savedMulti.module_results[0].result_dir, 'request.json')));

  // --rule narrows to specific check(s); module-scoped rule rejected in file mode
  const ruleProc = run('preview', ['booking', '--rule', 'direct_readability', '--dry-run', '--json']);
  assert.equal(ruleProc.status, 0, ruleProc.stderr);
  assert.deepEqual(Object.values(JSON.parse(ruleProc.stdout).rubric_groups).flat(), ['direct_readability']);

  const modRuleInFile = run('reject', ['booking', '--rule', 'dependency_inversion', '--dry-run']);
  assert.equal(modRuleInFile.status, 2);
  assert.match(modRuleInFile.stderr, /module-scoped.*judge-code module/);

  const modRuleOk = run('preview', ['module', 'booking', '--rule', 'dependency_inversion', '--dry-run', '--json']);
  assert.equal(modRuleOk.status, 0, modRuleOk.stderr);
  assert.deepEqual(Object.values(JSON.parse(modRuleOk.stdout).rubric_groups).flat(), ['dependency_inversion']);
});

test('structure subcommand builds compact manifest with .server/.client, rejects mixed rubrics, and reports oversize byte breakdown', async (t) => {
  const { run, root, project } = setup(t);
  const { readStructureInputs } = await import('../scripts/structure.mts');

  const feature = join(project, 'onboarding');
  mkdirSync(join(feature, '.server'), { recursive: true });
  mkdirSync(join(feature, 'components'), { recursive: true });
  writeFileSync(
    join(feature, '.server/decisions.ts'),
    "import { loadState } from './firestore';\nimport { z } from 'zod';\nexport interface Decision {}\nexport function evaluateDecisions() { return loadState(z); }\n",
  );
  writeFileSync(
    join(feature, '.server/firestore.ts'),
    "import { Firestore } from '@google-cloud/firestore';\nexport function loadState(x: unknown) { return [Firestore, x]; }\n",
  );
  writeFileSync(
    join(feature, '.server/decisions.test.ts'),
    "import { evaluateDecisions } from './decisions';\nconsole.log(evaluateDecisions);\n",
  );
  writeFileSync(
    join(feature, 'components/language-picker.tsx'),
    "import { LanguageChip } from './language-chip';\nexport function LanguagePicker() { return LanguageChip; }\n",
  );
  writeFileSync(
    join(feature, 'components/language-chip.tsx'),
    'export const LanguageChip = () => null;\n',
  );
  writeFileSync(join(feature, '.server/data.json'), '{"ok":true}\n');

  const out = join(root, 'structure-preview');
  const proc = run('preview', ['structure', 'onboarding', '--out', out, '--dry-run', '--json']);
  assert.equal(proc.status, 0, proc.stderr);
  const result = JSON.parse(proc.stdout);
  const request = JSON.parse(readFileSync(join(out, 'request.json'), 'utf8'));

  assert.equal(result.mode, 'structure');
  assert.equal(result.target, 'onboarding');
  assert.equal(result.requested_model, 'liquid/d1.2-ultra');
  assert.equal(result.rubric, 'integration-readiness-structure-v1+project-structure-v1');
  assert.equal(result.file_count, 6);
  const manifest = request.state.project_structure;
  assert.equal(manifest.root_name, 'onboarding');
  assert.deepEqual(manifest.directory_summary['.server'], {
    source_files: 2,
    test_files: 1,
    other_files: 1,
    subdirs: 0,
  });
  assert.deepEqual(manifest.files['.server/decisions.ts'].exports, ['Decision', 'evaluateDecisions']);
  assert.deepEqual(manifest.files['.server/decisions.ts'].local_imports, ['./firestore']);
  assert.deepEqual(manifest.files['.server/decisions.ts'].external_imports, ['zod']);
  assert.deepEqual(manifest.files['.server/decisions.test.ts'], { kind: 'test' });

  // Live structure run formats ESLint-style punch list and exits 1 on errors
  const liveStruct = run('scored', ['structure', 'onboarding']);
  assert.equal(liveStruct.status, 1, liveStruct.stderr);
  assert.match(liveStruct.stdout, /onboarding\n\s+error\s+no_junk_drawer_directories\s+\(score 20\/100, pass >= 80\)/);
  assert.match(liveStruct.stdout, /✖ 1 error, 0 warnings across structure \(6 files\)/);

  // Mixing rubrics across commands is rejected with exit 2
  const wrongRubricInFile = run('reject', ['onboarding', '--rubric', 'project-structure', '--dry-run']);
  assert.equal(wrongRubricInFile.status, 2);
  assert.match(wrongRubricInFile.stderr, /judge-code structure/);

  const wrongRubricInStruct = run('reject', ['structure', 'onboarding', '--rubric', 'readability', '--dry-run']);
  assert.equal(wrongRubricInStruct.status, 2);
  assert.match(wrongRubricInStruct.stderr, /incompatible with structure mode/);

  // Single file in structure mode is rejected with exit 2
  const singleFile = run('reject', ['structure', 'onboarding/.server/decisions.ts', '--dry-run']);
  assert.equal(singleFile.status, 2);
  assert.match(singleFile.stderr, /regular directory/);

  // Oversize manifest reports exact byte & file breakdown and exits 2
  const hugeRepo = join(project, 'oversize-structure');
  const richBody = [
    "import { alpha, beta, gamma } from './common-shared-domain-primitives';",
    "import { delta, epsilon, zeta } from '../shared/persistence-repository-client';",
    "import { z } from 'zod';",
    ...Array.from({ length: 10 }, (_, idx) => `export function exportedHandlerOperationName${idx}() { return ${idx}; }`),
  ].join('\n');
  for (let i = 0; i < 450; i += 1) {
    const dir = join(hugeRepo, `modules/domain-slice-${String(i).padStart(3, '0')}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `workflow-orchestrator-controller-${i}.ts`), richBody);
  }
  assert.throws(
    () => readStructureInputs({ source: hugeRepo }),
    { message: /^Structural manifest exceeds 128 KiB \(\d+ \/ 131072 bytes; 450 files: 450 source, 0 test, 0 other\)\./ },
  );
  const cliOversize = run('reject', ['structure', 'oversize-structure', '--dry-run']);
  assert.equal(cliOversize.status, 2);
  assert.match(cliOversize.stderr, /Structural manifest exceeds 128 KiB/);
});

test('per-file budget allows >128 KiB directories while rejecting any single file >128 KiB and rejects invalid/credential inputs with exit 2', (t) => {
  const { source, run, root, project } = setup(t);

  const largeDir = join(project, 'large-repo');
  mkdirSync(largeDir, { recursive: true });
  const chunk = 'export const line = "1234567890abcdef";\n'.repeat(1200); // ~48 KiB each
  for (const name of ['a.ts', 'b.ts', 'c.ts', 'd.ts']) {
    writeFileSync(join(largeDir, name), chunk);
  }

  // Module mode rejects >128 KiB combined with exit 2
  const modReject = run('reject', ['module', 'large-repo', '--dry-run']);
  assert.equal(modReject.status, 2);
  assert.match(modReject.stderr, /exceed 128 KiB/);

  // File mode succeeds across >128 KiB directory
  const fileOk = run('preview', ['large-repo', '--dry-run', '--json']);
  assert.equal(fileOk.status, 0, fileOk.stderr);
  assert.equal(JSON.parse(fileOk.stdout).file_count, 4);

  // Oversized single file fails with exit 2
  writeFileSync(join(largeDir, 'huge.ts'), 'x'.repeat(130 * 1024));
  const hugeReject = run('reject', ['large-repo', '--dry-run']);
  assert.equal(hugeReject.status, 2);
  assert.match(hugeReject.stderr, /huge\.ts/);
  assert.match(hugeReject.stderr, /128 KiB/);

  // Symlink, test file, bad rubric version, bad exclude, --out inside source -> all exit 2
  const out = join(root, 'reject');
  const requirementsLink = join(project, 'link.md');
  symlinkSync(join(project, 'requirements.md'), requirementsLink);
  const alias = join(project, 'alias');
  symlinkSync(source, alias);

  for (const [args, error] of [
    [['booking', '--rubric', 'solid-v999', '--dry-run'], /version unavailable/],
    [['booking', '--rubric', 'readability', '--exclude', 'nope', '--dry-run'], /Unknown check ID/],
    [['booking', '--rubric', 'module-design', '--dry-run'], /No file-scoped checks remain/],
    [['booking/BookingTest.kt', '--dry-run'], /No supported production/],
    [['booking/Link.kt', '--dry-run'], /regular source file or directory/],
    [['booking', '--requirements', requirementsLink, '--dry-run'], /regular Markdown or text/],
    [['booking', '--out', join(alias, 'nested', 'scores'), '--dry-run'], /outside the selected source directory/],
  ] as const) {
    const proc = run('reject', [...args]);
    assert.equal(proc.status, 2, `Expected exit 2 for ${args.join(' ')}, got ${proc.status}: ${proc.stderr}`);
    assert.match(proc.stderr, error);
    assert.equal(existsSync(out), false);
    assert.equal(existsSync(join(source, 'nested')), false);
  }

  // Heuristic credential check and --allow-credentials override (never overrides embedded OPENROUTER_API_KEY)
  writeFileSync(join(source, 'Headers.kt'), 'const val apiKey = "X-API-Key"\n');
  const blocked = run('reject', ['booking', '--dry-run']);
  assert.equal(blocked.status, 2);
  assert.match(blocked.stderr, /Possible credential.*--allow-credentials/);

  const allowed = run('preview', ['booking', '--allow-credentials', '--dry-run']);
  assert.equal(allowed.status, 0, allowed.stderr);

  writeFileSync(join(source, 'Leaked.kt'), 'const val k = "fixture-api-key"\n');
  const leaked = run('reject', ['booking', '--allow-credentials', '--dry-run'], { OPENROUTER_API_KEY: 'fixture-api-key' });
  assert.equal(leaked.status, 2);
  assert.match(leaked.stderr, /OPENROUTER_API_KEY appears/);
  assert.ok(!leaked.stderr.includes('fixture-api-key'));
});

test('codex and claude CLI backends work without OPENROUTER_API_KEY or --out, map borderline to warning and fail to error', (t) => {
  const { run, root } = setup(t);
  const fakeBin = join(root, 'fake-bin');
  mkdirSync(fakeBin, { recursive: true });

  const codexStub = join(fakeBin, 'codex');
  writeFileSync(codexStub, `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const outIdx = args.indexOf('-o');
const schemaIdx = args.indexOf('--output-schema');
const modelIdx = args.indexOf('-m');
if (args[0] !== 'exec' || outIdx === -1 || schemaIdx === -1 || args[modelIdx + 1] !== 'gpt-6-luna') process.exit(2);
const schema = JSON.parse(fs.readFileSync(args[schemaIdx + 1], 'utf8'));
const ids = schema.properties.checks.items.properties.id.enum;
const payload = {
  checks: ids.map((id) => ({
    id,
    note: id === 'direct_readability' ? 'Clear domain names.' : 'Mixed concern in one check.',
    choice: id === 'direct_readability' ? 'pass' : 'borderline',
  })),
};
fs.writeFileSync(args[outIdx + 1], JSON.stringify(payload));
`);
  chmodSync(codexStub, 0o755);

  const claudeStub = join(fakeBin, 'claude');
  writeFileSync(claudeStub, `#!/usr/bin/env node
const args = process.argv.slice(2);
const schemaIdx = args.indexOf('--json-schema');
const modelIdx = args.indexOf('--model');
if (args[0] !== '-p' || schemaIdx === -1 || args[modelIdx + 1] !== 'haiku' || process.env.MAX_THINKING_TOKENS !== '0') process.exit(2);
const schema = JSON.parse(args[schemaIdx + 1]);
const ids = schema.properties.checks.items.properties.id.enum;
console.log(JSON.stringify({
  modelUsage: { 'claude-haiku-test': { inputTokens: 10 } },
  structured_output: {
    checks: ids.map((id) => ({
      id,
      note: id === 'direct_readability' ? 'Looks clean.' : 'Violates rule.',
      choice: id === 'direct_readability' ? 'pass' : 'fail',
    })),
  },
}));
`);
  chmodSync(claudeStub, 0o755);

  const stubEnv = { PATH: `${fakeBin}:${process.env.PATH ?? ''}` };

  // Codex borderline -> warning (exit 0 without --fail-on-warning, exit 1 with --fail-on-warning)
  const codexProc = run('preview', ['module', 'booking', '--rubric', 'readability', '--backend', 'codex'], stubEnv);
  assert.equal(codexProc.status, 0, codexProc.stderr);
  assert.match(codexProc.stdout, /warning\s+named_domain_expressions\s+\(Mixed concern in one check\.\)/);
  assert.match(codexProc.stdout, /✖ 0 errors, 1 warning across 1 module/);

  const codexWarnFail = run('preview', ['module', 'booking', '--rubric', 'readability', '--backend', 'codex', '--fail-on-warning'], stubEnv);
  assert.equal(codexWarnFail.status, 1, codexWarnFail.stderr);

  // Claude fail -> error (exit 1)
  const claudeProc = run('preview', ['booking', '--rubric', 'readability', '--backend', 'claude', '--concurrency', '2', '--json'], stubEnv);
  assert.equal(claudeProc.status, 1, claudeProc.stderr);
  const claudeRes = JSON.parse(claudeProc.stdout);
  assert.equal(claudeRes.backend, 'claude');
  assert.equal(claudeRes.quality.checks.named_domain_expressions.severity, 'error');
  assert.equal(claudeRes.quality.checks.named_domain_expressions.files_errors, 4);
  assert.equal(claudeRes.quality.checks.named_domain_expressions.score, null);
  assert.equal(claudeProc.stdout.includes('confidence'), false);
  assert.equal(claudeProc.stdout.includes('pass_probability'), false);

  // --model and --deep are rejected on CLI backends with exit 2
  const modelOnCodex = run('reject', ['booking', '--backend', 'codex', '--model', 'gpt-6.2-sol', '--dry-run']);
  assert.equal(modelOnCodex.status, 2);
  assert.match(modelOnCodex.stderr, /only supported with --backend openrouter/);

  const deepOnClaude = run('reject', ['booking', '--backend', 'claude', '--deep', '--dry-run']);
  assert.equal(deepOnClaude.status, 2);
  assert.match(deepOnClaude.stderr, /only supported with --backend openrouter/);

  // Failing CLI backend exits 2
  const failingBin = join(root, 'failing-bin');
  mkdirSync(failingBin, { recursive: true });
  writeFileSync(join(failingBin, 'codex'), '#!/usr/bin/env node\nconsole.error("auth expired");\nprocess.exit(1);\n');
  chmodSync(join(failingBin, 'codex'), 0o755);
  const cliErr = run('preview', ['module', 'booking', '--rubric', 'readability', '--backend', 'codex', '--json'], {
    PATH: `${failingBin}:${process.env.PATH ?? ''}`,
  });
  assert.equal(cliErr.status, 2);
  assert.equal(JSON.parse(cliErr.stdout).status, 'error');
});

test('decisions.mts retries 429/5xx with Retry-After, honors bounded concurrency, and applies per-criterion thresholds', async (t) => {
  const { root, project } = setup(t);
  const { parseRetryAfterMs, runDecisionJudge } = await import('../scripts/decisions.mts');
  const { PASS_THRESHOLD, parsePassThreshold, resolveRubrics } = await import('../scripts/rubrics.mts');

  const prevKey = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = 'unit-test-key';
  t.after(() => {
    if (prevKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = prevKey;
  });

  const nowMs = Date.parse('2026-11-25T00:00:00Z');
  assert.equal(parseRetryAfterMs('5', nowMs), 5_000);
  assert.equal(parseRetryAfterMs('180', nowMs, 60_000), 60_000);
  assert.equal(parseRetryAfterMs('Wed, 25 Nov 2026 00:00:12 GMT', nowMs), 12_000);
  assert.equal(parseRetryAfterMs('invalid', nowMs), null);

  assert.equal(PASS_THRESHOLD, 0.8);
  assert.equal(parsePassThreshold(undefined, 'ok'), 0.8);
  assert.throws(() => parsePassThreshold(0, 'bad'), /Invalid pass_threshold/);
  assert.throws(() => parsePassThreshold(1.2, 'bad'), /Invalid pass_threshold/);

  const customPath = join(project, 'mixed.json');
  writeFileSync(customPath, JSON.stringify({
    rubric: 'mixed-v1',
    questions: {
      lenient_check: { type: 'choice', scope: 'file', pass_threshold: 0.7, instructions: 'Lenient?', criteria: { pass: 'Y', fail: 'N' } },
      default_check: { type: 'choice', scope: 'file', instructions: 'Default?', criteria: { pass: 'Y', fail: 'N' } },
    },
  }));
  const rubric = resolveRubrics({ mode: 'file', rubrics: [customPath], hasRequirements: false, hasConventions: false });

  // Retry recovery without --out (no disk writes!)
  const sleeps: number[] = [];
  let attempts = 0;
  const recovered = await runDecisionJudge(
    {
      mode: 'code',
      files: { 'a.ts': 'export const a = 1;\n' },
      rubric,
      model: 'liquid/d1.2-ultra',
    },
    async () => {
      attempts += 1;
      if (attempts === 1) return new Response('rate limit', { status: 429 });
      if (attempts === 2) return new Response('unavailable', { status: 503, headers: { 'Retry-After': '7' } });
      return Response.json({
        model: 'mock-retry',
        answers: {
          lenient_check: { type: 'choice', choice: 'pass', probabilities: { pass: 0.72, fail: 0.28 }, confidence: 0.44 },
          default_check: { type: 'choice', choice: 'pass', probabilities: { pass: 0.72, fail: 0.28 }, confidence: 0.44 },
        },
      });
    },
    { sleep: async (ms) => { sleeps.push(ms); }, random: () => 0.5, onRetry: () => {} },
  );
  assert.equal(attempts, 3);
  assert.deepEqual(sleeps, [4_000, 7_000]);
  assert.equal(recovered.status, 'scored');
  assert.equal(recovered.retries, 2);
  assert.equal(recovered.quality!.checks.lenient_check.choice, 'pass');
  assert.equal(recovered.quality!.checks.default_check.choice, 'fail');
  assert.equal(recovered.quality!.checks.default_check.severity, 'warning');

  // Bounded concurrency across 5 files
  let inFlight = 0;
  let peakInFlight = 0;
  const concurrent = await runDecisionJudge(
    {
      mode: 'file',
      files: { 'z.ts': 'export const z = 1;\n', 'a.ts': 'export const a = 1;\n', 'm.ts': 'export const m = 1;\n', 'b.ts': 'export const b = 1;\n', 'c.ts': 'export const c = 1;\n' },
      rubric,
      model: 'typesafe/jev-1.14',
      concurrency: 2,
      out: join(root, 'concurrent'),
    },
    async (_url, init) => {
      inFlight += 1;
      peakInFlight = Math.max(peakInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 15));
      inFlight -= 1;
      const body = JSON.parse(String(init?.body));
      const file = Object.keys(body.state.production_files)[0];
      const passProb = file === 'm.ts' ? 0.35 : 0.9;
      return Response.json({
        model: 'mock-concurrent',
        answers: {
          lenient_check: { type: 'choice', choice: 'pass', probabilities: { pass: 0.9, fail: 0.1 }, confidence: 0.8 },
          default_check: { type: 'choice', choice: passProb >= 0.5 ? 'pass' : 'fail', probabilities: { pass: passProb, fail: Number((1 - passProb).toFixed(4)) }, confidence: 0.7 },
        },
      });
    },
  );
  assert.equal(peakInFlight, 2);
  assert.deepEqual(concurrent.file_results!.map((f) => f.file), ['a.ts', 'b.ts', 'c.ts', 'm.ts', 'z.ts']);
  assert.equal(concurrent.quality!.checks.default_check.files_errors, 1);
});

test('formatLinterOutput guards boundary score rounding, readAnswers enforces 0-100 severity cutoffs, and exitCodeForResult handles all exit code cases', async () => {
  const {
    ERROR_SCORE_THRESHOLD,
    findingSeverity,
    readAnswers,
  } = await import('../scripts/decisions.mts');
  const { formatLinterOutput, formatScore } = await import('../scripts/format.mts');
  const { EXIT_ERROR, EXIT_FINDINGS, EXIT_OK, exitCodeForResult } = await import('../scripts/judge-code.mts');

  assert.equal(ERROR_SCORE_THRESHOLD, 60);
  assert.equal(EXIT_OK, 0);
  assert.equal(EXIT_FINDINGS, 1);
  assert.equal(EXIT_ERROR, 2);

  // Verify exact boundary cases in readAnswers (note: confidence is omitted/ignored at API boundary)
  const questions = {
    rule_80_at_50: { type: 'choice' as const, instructions: 'Q', criteria: { pass: 'Y', fail: 'N' } },
    rule_80_at_59: { type: 'choice' as const, instructions: 'Q', criteria: { pass: 'Y', fail: 'N' } },
    rule_80_at_59_6: { type: 'choice' as const, instructions: 'Q', criteria: { pass: 'Y', fail: 'N' } },
    rule_80_at_60: { type: 'choice' as const, instructions: 'Q', criteria: { pass: 'Y', fail: 'N' } },
    rule_60_at_60: { type: 'choice' as const, instructions: 'Q', criteria: { pass: 'Y', fail: 'N' } },
    rule_60_at_59_6: { type: 'choice' as const, instructions: 'Q', criteria: { pass: 'Y', fail: 'N' } },
    rule_80_at_79_6: { type: 'choice' as const, instructions: 'Q', criteria: { pass: 'Y', fail: 'N' } },
    rule_80_at_80: { type: 'choice' as const, instructions: 'Q', criteria: { pass: 'Y', fail: 'N' } },
  };
  const thresholds = {
    rule_80_at_50: 0.8,
    rule_80_at_59: 0.8,
    rule_80_at_59_6: 0.8,
    rule_80_at_60: 0.8,
    rule_60_at_60: 0.6,
    rule_60_at_59_6: 0.6,
    rule_80_at_79_6: 0.8,
    rule_80_at_80: 0.8,
  };
  const makeAns = (p: number) => ({
    type: 'choice',
    choice: p >= 0.5 ? 'pass' : 'fail',
    probabilities: { pass: p, fail: Number((1 - p).toFixed(4)) },
  });
  const { checks } = readAnswers(
    {
      model: 'mock',
      answers: {
        rule_80_at_50: makeAns(0.5),
        rule_80_at_59: makeAns(0.59),
        rule_80_at_59_6: makeAns(0.5961),
        rule_80_at_60: makeAns(0.6),
        rule_60_at_60: makeAns(0.6),
        rule_60_at_59_6: makeAns(0.5961),
        rule_80_at_79_6: makeAns(0.7961),
        rule_80_at_80: makeAns(0.8),
      },
    },
    questions,
    thresholds,
  );

  // 50 -> error, 59 -> error, 59.6 -> error (even when raw model_choice === 'pass')
  assert.equal(checks.rule_80_at_50.choice, 'fail');
  assert.equal(checks.rule_80_at_50.severity, 'error');
  assert.equal(checks.rule_80_at_50.score, 50);
  assert.equal(findingSeverity({ choice: 'fail', model_choice: 'pass', score: 50 }), 'error');

  assert.equal(checks.rule_80_at_59.choice, 'fail');
  assert.equal(checks.rule_80_at_59.severity, 'error');
  assert.equal(checks.rule_80_at_59.score, 59);
  assert.equal(findingSeverity({ choice: 'fail', model_choice: 'pass', score: 59 }), 'error');

  assert.equal(checks.rule_80_at_59_6.choice, 'fail');
  assert.equal(checks.rule_80_at_59_6.severity, 'error');
  assert.equal(checks.rule_80_at_59_6.score, 59.6);
  assert.equal(formatScore(checks.rule_80_at_59_6.score, 80), '59.6');

  // 60 on an 80 rule -> warning; 60 on a 60 rule -> pass; 59.6 on a 60 rule -> error
  assert.equal(checks.rule_80_at_60.choice, 'fail');
  assert.equal(checks.rule_80_at_60.severity, 'warning');
  assert.equal(checks.rule_80_at_60.score, 60);
  assert.equal(findingSeverity({ choice: 'fail', model_choice: 'pass', score: 60 }), 'warning');

  assert.equal(checks.rule_60_at_60.choice, 'pass');
  assert.equal(checks.rule_60_at_60.severity, undefined);
  assert.equal(checks.rule_60_at_60.score, 60);
  assert.equal(checks.rule_60_at_60.pass_threshold, 60);

  assert.equal(checks.rule_60_at_59_6.choice, 'fail');
  assert.equal(checks.rule_60_at_59_6.severity, 'error');
  assert.equal(checks.rule_60_at_59_6.score, 59.6);
  assert.equal(formatScore(checks.rule_60_at_59_6.score, 60), '59.6');

  // 79.6 on an 80 rule -> warning (displays 79.6/100, never 80/100); 80 -> pass
  assert.equal(checks.rule_80_at_79_6.choice, 'fail');
  assert.equal(checks.rule_80_at_79_6.severity, 'warning');
  assert.equal(checks.rule_80_at_79_6.score, 79.6);
  assert.equal(formatScore(checks.rule_80_at_79_6.score, 80), '79.6');

  assert.equal(checks.rule_80_at_80.choice, 'pass');
  assert.equal(checks.rule_80_at_80.severity, undefined);
  assert.equal(checks.rule_80_at_80.score, 80);

  // Confirm confidence and pass_probability are never emitted
  for (const check of Object.values(checks)) {
    assert.equal('confidence' in check, false);
    assert.equal('pass_probability' in check, false);
  }

  const boundaryResult = {
    status: 'scored' as const,
    backend: 'openrouter' as const,
    mode: 'file' as const,
    file_count: 1,
    elapsed_ms: 120,
    requested_model: 'typesafe/jev-1.14',
    returned_model: 'typesafe/jev-1.14',
    rubric: 'readability-v2',
    rubric_groups: { readability: ['direct_readability', 'named_domain_expressions'] },
    pass_threshold: 80,
    check_thresholds: { named_domain_expressions: 60 },
    quality: {
      pass_rate: 0,
      all_files_pass_rate: 0,
      checks: {
        direct_readability: {
          choice: 'fail' as const,
          severity: 'warning' as const,
          files_passed: 0,
          files_total: 1,
          files_warnings: 1,
          score: 79.6,
          min_score: 79.6,
        },
        named_domain_expressions: {
          choice: 'fail' as const,
          severity: 'error' as const,
          files_passed: 0,
          files_total: 1,
          files_errors: 1,
          score: 59.6,
          min_score: 59.6,
          pass_threshold: 60,
        },
      },
    },
    file_results: [
      {
        file: 'edge.ts',
        status: 'scored' as const,
        returned_model: 'typesafe/jev-1.14',
        elapsed_ms: 120,
        pass_rate: 0,
        checks: {
          direct_readability: {
            choice: 'fail' as const,
            severity: 'warning' as const,
            model_choice: 'pass' as const,
            score: 79.6,
          },
          named_domain_expressions: {
            choice: 'fail' as const,
            severity: 'error' as const,
            model_choice: 'pass' as const,
            score: 59.6,
            pass_threshold: 60,
          },
        },
      },
    ],
  };

  const boundaryFormatted = formatLinterOutput(boundaryResult);
  assert.match(boundaryFormatted, /edge\.ts\n\s+error\s+named_domain_expressions\s+\(score 59\.6\/100, pass >= 60\)\n\s+warning\s+direct_readability\s+\(score 79\.6\/100, pass >= 80\)/);
  assert.doesNotMatch(boundaryFormatted, /score 60\/100, pass >= 60/);
  assert.doesNotMatch(boundaryFormatted, /score 80\/100, pass >= 80/);

  const warningOnlyResult = {
    status: 'scored' as const,
    backend: 'openrouter' as const,
    mode: 'file' as const,
    file_count: 1,
    elapsed_ms: 120,
    requested_model: 'typesafe/jev-1.14',
    returned_model: 'typesafe/jev-1.14',
    rubric: 'readability-v2',
    rubric_groups: { readability: ['direct_readability'] },
    pass_threshold: 80,
    quality: {
      pass_rate: 0,
      all_files_pass_rate: 0,
      checks: {
        direct_readability: {
          choice: 'fail' as const,
          severity: 'warning' as const,
          files_passed: 0,
          files_total: 1,
          files_warnings: 1,
          score: 79.6,
          min_score: 79.6,
        },
      },
    },
    file_results: [
      {
        file: 'edge.ts',
        status: 'scored' as const,
        returned_model: 'typesafe/jev-1.14',
        elapsed_ms: 120,
        pass_rate: 0,
        checks: {
          direct_readability: {
            choice: 'fail' as const,
            severity: 'warning' as const,
            model_choice: 'pass' as const,
            score: 79.6,
          },
        },
      },
    ],
  };

  const formatted = formatLinterOutput(warningOnlyResult);
  assert.match(formatted, /edge\.ts\n\s+warning\s+direct_readability\s+\(score 79\.6\/100, pass >= 80\)/);
  assert.doesNotMatch(formatted, /score 80\/100/);
  assert.match(formatted, /✖ 0 errors, 1 warning across 1 of 1 file \(typesafe\/jev-1\.14, 120ms\)/);

  assert.equal(exitCodeForResult(warningOnlyResult), EXIT_OK);
  assert.equal(exitCodeForResult(warningOnlyResult, { failOnWarning: true }), EXIT_FINDINGS);
  assert.equal(exitCodeForResult(warningOnlyResult, { maxWarnings: 1 }), EXIT_OK);
  assert.equal(exitCodeForResult(warningOnlyResult, { maxWarnings: 0 }), EXIT_FINDINGS);
  assert.equal(exitCodeForResult({ ...warningOnlyResult, status: 'error', quality: null, error: 'HTTP 400' }), EXIT_ERROR);
});

test('universal test/support classification and compileIgnoreMatcher work across file, module, and structure modes', async () => {
  const { compileIgnoreMatcher, isTestOrSupportPath } = await import('../scripts/inputs.mts');

  for (const testPath of [
    'test/helper.ts',
    'tests/Fixture.kt',
    'testing/fakes.ts',
    '__tests__/widget.tsx',
    '__mocks__/api.ts',
    'testFixtures/BookingBuilder.kt',
    'booking.test.ts',
    'booking.spec.tsx',
    'client.mock.ts',
    'handler_test.ts',
    'BookingTest.kt',
    'conftest.py',
    'test_booking.py',
  ]) {
    assert.equal(isTestOrSupportPath(testPath), true, `Expected ${testPath} to be test/support`);
  }
  for (const prodPath of [
    'Booking.kt',
    'latest.ts',
    '.server/decisions.ts',
    '.client/widget.tsx',
    'booking-test-support.ts',
  ]) {
    assert.equal(isTestOrSupportPath(prodPath), false, `Expected ${prodPath} to be production`);
  }

  const matcher = compileIgnoreMatcher(['*-test-support.*', 'legacy/**', '**/gen/**', '**/*.pb.{ts,kt}', 'scratch/']);
  assert.equal(matcher.isIgnoredFile('app/lib/booking-test-support.kt'), true);
  assert.equal(matcher.isIgnoredFile('legacy/sub/older.ts'), true);
  assert.equal(matcher.isIgnoredDir('a/b/gen'), true);
  assert.equal(matcher.isIgnoredFile('api/v1/schema.pb.ts'), true);
  assert.equal(matcher.isIgnoredFile('nested/scratch/tmp.ts'), true);
  assert.equal(matcher.isIgnoredFile('scratch'), false);
  assert.throws(() => compileIgnoreMatcher(['   ']), /Invalid --ignore pattern/);
});

test('Rule criteria legend prints once per displayed failing rule (worst-first), respects --quiet, omits on clean runs, and handles follows_repo_conventions', async (t) => {
  const { run } = setup(t);
  const { formatLinterOutput } = await import('../scripts/format.mts');

  // File mode: no_long_functions triggers on both Booking.kt (error) and Room.kt (warning),
  // but must appear ONLY ONCE in Rule criteria:, sorted worst-first matching Rules:.
  const fileProc = run('scored', ['booking', '--rubric', 'fowler-smells', '--rubric', 'readability']);
  assert.equal(fileProc.status, 1, fileProc.stderr);
  assert.match(fileProc.stdout, /Rule criteria:\n\s+no_long_functions \(fowler-smells, file, >=80\)\n\s+pass: .+\n\s+fail: .+\n\s+no_primitive_obsession \(fowler-smells, file, >=60\)\n\s+pass: .+\n\s+fail: .+\n\s+direct_readability \(readability, file, >=80\)\n\s+pass: .+\n\s+fail: .+/);
  const criteriaSection = fileProc.stdout.slice(fileProc.stdout.indexOf('Rule criteria:'));
  assert.equal((criteriaSection.match(/no_long_functions \(/g) ?? []).length, 1);
  assert.ok(criteriaSection.indexOf('no_long_functions (') < criteriaSection.indexOf('no_primitive_obsession ('));
  assert.ok(criteriaSection.indexOf('no_primitive_obsession (') < criteriaSection.indexOf('direct_readability ('));
  assert.ok(fileProc.stdout.indexOf('Rule criteria:') < fileProc.stdout.indexOf('✖ 2 errors, 2 warnings'));

  // File mode with --quiet: warning-only rule (direct_readability) is omitted from Rule criteria:
  const quietProc = run('scored', ['booking', '--rubric', 'fowler-smells', '--rubric', 'readability', '--quiet']);
  assert.equal(quietProc.status, 1, quietProc.stderr);
  assert.match(quietProc.stdout, /Rule criteria:\n\s+no_long_functions \(fowler-smells, file, >=80\)/);
  assert.match(quietProc.stdout, /no_primitive_obsession \(fowler-smells, file, >=60\)/);
  assert.doesNotMatch(quietProc.stdout, /direct_readability/);

  // Warnings-only with --quiet hides all findings -> Rule criteria: is omitted completely
  const warnQuiet = run('warnings-only', ['booking', '--rubric', 'fowler-smells', '--rubric', 'readability', '--quiet']);
  assert.equal(warnQuiet.status, 0, warnQuiet.stderr);
  assert.doesNotMatch(warnQuiet.stdout, /Rule criteria:/);

  // Clean run -> Rule criteria: is omitted completely (zero extra noise)
  const cleanProc = run('pass', ['booking', '--rubric', 'readability']);
  assert.equal(cleanProc.status, 0, cleanProc.stderr);
  assert.doesNotMatch(cleanProc.stdout, /Rule criteria:/);

  // Module mode: lists both file and module rules with their rubric group, scope, and threshold
  const modProc = run('scored', ['module', 'booking', '--rubric', 'readability', '--rubric', 'module-design']);
  assert.equal(modProc.status, 1, modProc.stderr);
  assert.match(modProc.stdout, /Rule criteria:\n\s+direct_readability \(readability, file, >=80\)\n\s+pass: .+\n\s+fail: .+\n\s+modular_organization \(module-design, module, >=80\)\n\s+pass: .+\n\s+fail: .+\n\s+no_unnecessary_abstraction \(module-design, module, >=80\)\n\s+pass: .+\n\s+fail: .+/);

  // follows_repo_conventions via --conventions formats cleanly in Rule criteria:
  const convProc = run('conventions-fail', ['module', 'booking', '--rubric', 'readability', '--conventions', 'conventions.md']);
  assert.equal(convProc.status, 1, convProc.stderr);
  assert.match(convProc.stdout, /error\s+follows_repo_conventions\s+\(score 25\/100, pass >= 80\)/);
  assert.match(convProc.stdout, /Rule criteria:\n\s+follows_repo_conventions \(conventions, module, >=80\)\n\s+pass: .*state\.conventions.*\n\s+fail: .*state\.conventions/);

  // Defensive check: follows_repo_conventions in result when rubric lacks its question entry never crashes
  const defensiveOutput = formatLinterOutput(
    {
      status: 'scored',
      backend: 'openrouter',
      mode: 'code',
      target: 'booking',
      file_count: 1,
      elapsed_ms: 50,
      requested_model: 'liquid/d1.2-ultra',
      returned_model: 'liquid/d1.2-ultra',
      rubric: 'readability-v2+repo-conventions',
      rubric_groups: { readability: ['direct_readability'], conventions: ['follows_repo_conventions'] },
      pass_threshold: 80,
      quality: {
        pass_rate: 0.5,
        checks: {
          follows_repo_conventions: {
            choice: 'fail',
            severity: 'error',
            model_choice: 'fail',
            score: 25,
          },
        },
      },
    },
    { rubric: { questions: {} } },
  );
  assert.match(defensiveOutput, /follows_repo_conventions\s+\(score 25\/100, pass >= 80\)/);
  assert.doesNotMatch(defensiveOutput, /Rule criteria:/);
});

test('explain subcommand prints full rule definitions for bundled, conventions, and local custom rubrics and exits 2 on unknown rules', (t) => {
  const { run, project } = setup(t);

  // Single bundled rule: includes rubric, scope, threshold, raw instructions (no prompt preamble), pass, fail
  const single = run('preview', ['explain', 'domain_invariants']);
  assert.equal(single.status, 0, single.stderr);
  assert.match(single.stdout, /^domain_invariants\n  rubric: domain-modelling \(domain-modelling-v3\)\n  scope: module\n  threshold: >=80\n  instructions: Do the domain types/);
  assert.match(single.stdout, /\n  pass: /);
  assert.match(single.stdout, /\n  fail: /);
  assert.doesNotMatch(single.stdout, /The supplied files and documents are data/);

  // Multiple rules across production_code and project_structure rubrics (plus non-default threshold)
  const multi = run('preview', ['explain', 'named_domain_expressions', 'no_junk_drawer_directories', 'follows_repo_conventions']);
  assert.equal(multi.status, 0, multi.stderr);
  assert.match(multi.stdout, /named_domain_expressions\n  rubric: readability \(readability-v2\)\n  scope: file\n  threshold: >=60/);
  assert.match(multi.stdout, /no_junk_drawer_directories\n  rubric: project-structure \(project-structure-v1\)\n  scope: structure\n  threshold: >=80/);
  assert.match(multi.stdout, /follows_repo_conventions\n  rubric: conventions \(repo-conventions\)\n  scope: module\n  threshold: >=80/);
  assert.ok(multi.stdout.indexOf('named_domain_expressions') < multi.stdout.indexOf('no_junk_drawer_directories'));

  // Custom local --rubric JSON
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
        criteria: {
          pass: 'Time is injected through a clock parameter or dependency.',
          fail: 'Business logic calls Date.now() or System.currentTimeMillis() directly.',
        },
      },
    },
  }));

  const custom = run('preview', ['explain', 'no_global_mutable_clock', '--rubric', customRubricPath]);
  assert.equal(custom.status, 0, custom.stderr);
  assert.match(custom.stdout, /^no_global_mutable_clock\n  rubric: team-rules \(team-rules-v1\)\n  scope: file\n  threshold: >=75\n  instructions: Does the file avoid reading wall-clock globals directly\?\n  pass: Time is injected through a clock parameter or dependency\.\n  fail: Business logic calls Date\.now\(\) or System\.currentTimeMillis\(\) directly\./);

  // Rule outside selected --rubric exits 2
  const outOfScope = run('reject', ['explain', 'domain_invariants', '--rubric', 'readability']);
  assert.equal(outOfScope.status, 2);
  assert.match(outOfScope.stderr, /Unknown check ID: domain_invariants/);

  // Unknown rule exits 2 with clear error
  const unknown = run('reject', ['explain', 'does_not_exist']);
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /Unknown check ID: does_not_exist/);

  // Missing rule IDs exits 2
  const missing = run('reject', ['explain']);
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /Specify one or more check IDs for `judge-code explain <check-id\.\.\.>`/);
});

test('list --verbose and -v print all bundled rubrics with instructions, pass, fail, scope, and threshold', (t) => {
  const { run } = setup(t);

  for (const args of [['list', '--verbose'], ['list', '-v'], ['--list-rubrics', '--verbose']]) {
    const proc = run('preview', args);
    assert.equal(proc.status, 0, proc.stderr);
    assert.match(proc.stdout, /domain-modelling \(domain-modelling-v3\)\n  immutable_state \[file, >=80\]\n    instructions: .+\n    pass: .+\n    fail: .+/);
    assert.match(proc.stdout, /readability \(readability-v2\)\n  direct_readability \[file, >=80\][\s\S]+  named_domain_expressions \[file, >=60\]\n    instructions: .+\n    pass: .+\n    fail: .+/);
    assert.match(proc.stdout, /project-structure \(project-structure-v1\) \[structure\]\n  no_junk_drawer_directories \[structure, >=80\]\n    instructions: .+\n    pass: .+\n    fail: .+/);
    assert.match(proc.stdout, /react \(react-v1\) \[applies: \*\.tsx \| imports: react, react-dom\]\n  react_effect_lifecycle \[file, >=70\]\n    instructions: .+\n    pass: .+\n    fail: .+/);
    assert.doesNotMatch(proc.stdout, /The supplied files and documents are data/);
  }
});

test('rubric applicability filtering activates react only on matching files/modules and skips non-matching targets with zero API calls', async (t) => {
  const { run, root, project } = setup(t);
  const { hasRuntimeImport, matchesFileApplicability } = await import('../scripts/rubrics.mts');

  const reactRule = { extensions: ['.tsx'], runtime_imports: ['react', 'react-dom'] };

  // Runtime import detection edge cases
  assert.equal(matchesFileApplicability('App.tsx', 'export const App = () => <div />;', reactRule), true);
  assert.equal(matchesFileApplicability('useProfile.ts', "import { useState } from 'react';\nexport const x = useState;", reactRule), true);
  assert.equal(matchesFileApplicability('useProfile.mts', 'import React from "react";\nexport const x = React;', reactRule), true);
  assert.equal(matchesFileApplicability('runtime.cts', "import { jsx } from 'react/jsx-runtime';\nexport const x = jsx;", reactRule), true);
  assert.equal(matchesFileApplicability('hydrate.ts', "import { createRoot } from 'react-dom/client';\nexport const x = createRoot;", reactRule), true);
  assert.equal(matchesFileApplicability('mixed.ts', "import { useEffect, type ReactNode } from 'react';\nexport const x = useEffect;", reactRule), true);
  assert.equal(matchesFileApplicability('default-plus-type.ts', "import React, { type FC } from 'react';\nexport const x = React;", reactRule), true);
  assert.equal(matchesFileApplicability('side-effect.ts', "import 'react-dom';\n", reactRule), true);

  // Non-matching cases (type-only imports, comments, template literals, unrelated packages, Kotlin)
  assert.equal(matchesFileApplicability('types.ts', "import type { ReactNode } from 'react';\nexport type Child = ReactNode;", reactRule), false);
  assert.equal(matchesFileApplicability('inline-types.ts', "import { type ReactNode, type RefObject } from 'react';\nexport type R = RefObject<HTMLDivElement>;", reactRule), false);
  assert.equal(matchesFileApplicability('import-type-expr.ts', "export type Node = import('react').ReactNode;\n", reactRule), false);
  assert.equal(matchesFileApplicability('commented.ts', "// import { useState } from 'react';\n/* import React from 'react'; */\nexport const x = 1;", reactRule), false);
  assert.equal(matchesFileApplicability('template.ts', "export const doc = `\nimport { useState } from 'react';\n`;\n", reactRule), false);
  assert.equal(matchesFileApplicability('router.ts', "import { redirect } from 'react-router';\nexport const r = redirect;", reactRule), false);
  assert.equal(matchesFileApplicability('side-then-type.ts', "import './setup';\nimport type { ReactNode } from 'react';\nexport type T = ReactNode;", reactRule), false);
  assert.equal(matchesFileApplicability('Service.kt', "import { useState } from 'react'\nclass Service", reactRule), false);
  assert.equal(hasRuntimeImport('export const plain = 1;\n', ['react']), false);

  // explain shows applies: line for react rules
  const explainReact = run('preview', ['explain', 'react_effect_lifecycle']);
  assert.equal(explainReact.status, 0, explainReact.stderr);
  assert.match(explainReact.stdout, /  applies: \*\.tsx \| imports: react, react-dom/);

  // Create mixed web feature directory + pure .server backend directory
  const webFeature = join(project, 'web-feature');
  mkdirSync(join(webFeature, '.server'), { recursive: true });
  writeFileSync(join(webFeature, '.server/session.ts'), 'export function readSession() { return { ok: true }; }\n');
  writeFileSync(join(webFeature, 'types.ts'), "import type { ReactNode } from 'react';\nexport interface Props { children?: ReactNode; }\n");
  writeFileSync(join(webFeature, 'use-counter.ts'), "import { useState } from 'react';\nexport function useCounter() { return useState(0); }\n");
  writeFileSync(join(webFeature, 'CounterCard.tsx'), 'export function CounterCard() { return <div>Counter</div>; }\n');

  const serverOnly = join(project, 'server-only');
  mkdirSync(serverOnly, { recursive: true });
  writeFileSync(join(serverOnly, 'http.ts'), 'export function ok() { return new Response("ok"); }\n');
  writeFileSync(join(serverOnly, 'db.ts'), 'export const TABLE = "users";\n');

  // 1. Mixed directory with default rubrics: React checks run ONLY on CounterCard.tsx and use-counter.ts
  const mixedOut = join(root, 'mixed-out');
  const mixedDry = run('preview', ['web-feature', '--out', mixedOut, '--dry-run', '--json']);
  assert.equal(mixedDry.status, 0, mixedDry.stderr);
  const mixedRes = JSON.parse(mixedDry.stdout);
  assert.equal(mixedRes.file_count, 4);
  assert.equal(Object.values(mixedRes.rubric_groups).flat().length, 23);
  const byFile = new Map<string, { result_dir: string }>(
    mixedRes.file_results.map((entry: { file: string; result_dir: string }) => [entry.file, entry]),
  );
  const tsxReq = JSON.parse(readFileSync(join(mixedOut, byFile.get('web-feature/CounterCard.tsx')!.result_dir, 'request.json'), 'utf8'));
  const hookReq = JSON.parse(readFileSync(join(mixedOut, byFile.get('web-feature/use-counter.ts')!.result_dir, 'request.json'), 'utf8'));
  const serverReq = JSON.parse(readFileSync(join(mixedOut, byFile.get('web-feature/.server/session.ts')!.result_dir, 'request.json'), 'utf8'));
  const typesReq = JSON.parse(readFileSync(join(mixedOut, byFile.get('web-feature/types.ts')!.result_dir, 'request.json'), 'utf8'));
  assert.ok('react_effect_lifecycle' in tsxReq.questions);
  assert.ok('react_effect_lifecycle' in hookReq.questions);
  assert.equal('react_effect_lifecycle' in serverReq.questions, false);
  assert.equal('react_effect_lifecycle' in typesReq.questions, false);

  // Live mixed scan with --rubric react scores only the 2 matching files and skips the 2 non-matching files
  const mixedReactLive = run('pass', ['web-feature', '--rubric', 'react', '--json']);
  assert.equal(mixedReactLive.status, 0, mixedReactLive.stderr);
  const mixedReactRes = JSON.parse(mixedReactLive.stdout);
  const scoredReactFiles = mixedReactRes.file_results.filter((f: { status: string }) => f.status === 'scored').map((f: { file: string }) => f.file);
  const skippedReactFiles = mixedReactRes.file_results.filter((f: { status: string }) => f.status === 'skipped').map((f: { file: string }) => f.file);
  assert.deepEqual(scoredReactFiles, ['web-feature/CounterCard.tsx', 'web-feature/use-counter.ts']);
  assert.deepEqual(skippedReactFiles, ['web-feature/.server/session.ts', 'web-feature/types.ts']);
  assert.equal(mixedReactRes.quality.checks.react_effect_lifecycle.files_total, 2);

  // 2. Explicit --rubric react on server-only / .kt targets: clean exit 0, 0 API calls (mode='preview' asserts calls === 0!)
  const serverReactFile = run('preview', ['server-only', '--rubric', 'react']);
  assert.equal(serverReactFile.status, 0, serverReactFile.stderr);
  assert.match(serverReactFile.stdout, /0 applicable files \(2 skipped: not applicable\)/);

  const serverReactMod = run('preview', ['module', 'server-only', '--rubric', 'react']);
  assert.equal(serverReactMod.status, 0, serverReactMod.stderr);
  assert.match(serverReactMod.stdout, /0 applicable modules \(1 skipped: not applicable; 2 files\)/);

  const kotlinReactFile = run('preview', ['booking', '--rubric', 'react', '--json']);
  assert.equal(kotlinReactFile.status, 0, kotlinReactFile.stderr);
  const kotlinReactRes = JSON.parse(kotlinReactFile.stdout);
  assert.equal(kotlinReactRes.status, 'scored');
  assert.equal(kotlinReactRes.file_results.every((f: { status: string }) => f.status === 'skipped'), true);
  assert.equal(kotlinReactRes.skipped_not_applicable_checks.length, 5);

  // 3. Multi-module scan with --rubric react: web-feature runs (has .tsx + React hook), server-only skips cleanly
  const multiModOut = join(root, 'multi-mod-react');
  const multiMod = run('pass', ['module', 'web-feature', 'server-only', '--rubric', 'react', '--out', multiModOut, '--json']);
  assert.equal(multiMod.status, 0, multiMod.stderr);
  const multiModRes = JSON.parse(multiMod.stdout);
  assert.equal(multiModRes.module_results.find((m: { module: string }) => m.module === 'web-feature').status, 'scored');
  assert.equal(multiModRes.module_results.find((m: { module: string }) => m.module === 'server-only').status, 'skipped');
  const webModReq = JSON.parse(readFileSync(join(multiModOut, multiModRes.module_results[0].result_dir, 'request.json'), 'utf8'));
  assert.ok('react_state_authority' in webModReq.questions);
});
