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
const out = process.argv[process.argv.indexOf('--out') + 1];
const isFileMode = process.argv.includes('--mode') && process.argv[process.argv.indexOf('--mode') + 1] === 'file';
let calls = 0;

globalThis.fetch = async (endpoint, init) => {
  calls += 1;
  if (!isFileMode) assert.equal(calls, 1);
  assert.equal(endpoint, 'https://openrouter.ai/api/alpha/decisions');
  assert.equal(init.redirect, 'error');
  assert.equal(init.headers.Authorization, 'Bearer fixture-api-key');
  if (!isFileMode) assert.equal(init.body, readFileSync(join(out, 'request.json'), 'utf8'));

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
  const singleFile = isFileMode && fileNames.length === 1 ? fileNames[0] : null;
  if (mode === 'partial-400' && singleFile === 'Room.kt') {
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
    } else if (singleFile === 'Booking.kt') {
      if (id === 'no_long_functions') { passProb = 0.15; choice = 'fail'; }
      else if (id === 'no_primitive_obsession') { passProb = 0.45; choice = 'fail'; }
    } else if (singleFile === 'Room.kt') {
      if (id === 'no_long_functions') { passProb = 0.65; choice = 'pass'; }
    } else if (!isFileMode) {
      const fail = ['direct_readability', 'modular_organization'].includes(id);
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
  } else if (!isFileMode) {
    assert.equal(calls, 1);
  } else {
    assert.ok(calls >= 1);
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

  function run(mode: string, args: string[], extraEnv: Record<string, string> = {}) {
    const env = { ...process.env, JUDGE_TEST_MODE: mode };
    delete env.OPENROUTER_API_KEY;
    if (!['preview', 'reject'].includes(mode)) env.OPENROUTER_API_KEY = 'fixture-api-key';
    Object.assign(env, extraEnv);
    return spawnSync(process.execPath, ['--import', mock, join(installed, 'scripts/judge-code.mts'), ...args], {
      cwd: project,
      env,
      encoding: 'utf8',
    });
  }

  return { source, root, project, installed, run };
}

test('list-rubrics prints bundled slugs, versioned IDs, check IDs, per-check scopes, and custom thresholds', (t) => {
  const { run } = setup(t);
  const proc = run('preview', ['--list-rubrics']);
  assert.equal(proc.status, 0, proc.stderr);
  assert.match(proc.stdout, /api-design \(api-design-v3\): no_rigid_enums_for_editorial_labels \[file\], cohesive_resource_boundaries \[module\]/);
  assert.match(proc.stdout, /domain-modelling \(domain-modelling-v3\): immutable_state \[file\], domain_invariants \[module\], boundary_separation \[module\]/);
  assert.match(proc.stdout, /fowler-smells \(fowler-smells-v1\): no_duplicated_code \[module\], no_long_functions \[file\].*no_primitive_obsession \[file, >=0\.60\]/);
  assert.match(proc.stdout, /integration-readiness \(integration-readiness-v3\): no_prod_fixture_or_demo_contamination \[file\], clean_api_contract_boundary \[module\]/);
  assert.match(proc.stdout, /integration-readiness-structure \(integration-readiness-structure-v1\) \[structure\]: no_bundled_stub_or_demo_modules \[structure\]/);
  assert.match(proc.stdout, /module-design \(module-design-v2\): modular_organization \[module\], no_unnecessary_abstraction \[module\]/);
  assert.match(proc.stdout, /readability \(readability-v2\): direct_readability \[file\], named_domain_expressions \[file, >=0\.60\]/);
  assert.match(proc.stdout, /solid \(solid-v3\): single_responsibility \[module\], open_closed \[module\], liskov_substitution \[module\], interface_segregation \[module\], dependency_inversion \[module\]/);
});

test('per-criterion scope is validated, defaulted for custom rubrics, exposed on ResolvedRubric, and stripped from request payloads', async (t) => {
  const { run, root, project } = setup(t);
  const { resolveRubrics } = await import('../scripts/rubrics.mts');

  // Bundled rubrics expose accurate per-check scopes and strip scope from questions.
  const resolved = resolveRubrics({
    rubrics: ['fowler-smells', 'readability', 'domain-modelling', 'solid'],
    exclude: ['no_duplicated_code'],
    hasRequirements: false,
    hasConventions: true,
  });
  assert.equal(resolved.scopes.no_long_functions, 'file');
  assert.equal(resolved.scopes.no_repeated_switches, 'module');
  assert.equal(resolved.scopes.direct_readability, 'file');
  assert.equal(resolved.scopes.boundary_separation, 'module');
  assert.equal(resolved.scopes.single_responsibility, 'module');
  assert.equal(resolved.scopes.dependency_inversion, 'module');
  assert.equal(resolved.scopes.follows_repo_conventions, 'module');
  assert.equal('no_duplicated_code' in resolved.scopes, false);
  for (const question of Object.values(resolved.questions)) {
    assert.deepEqual(Object.keys(question).sort(), ['criteria', 'instructions', 'type']);
  }

  // Custom production_code rubric defaults omitted scope to "module" and preserves explicit "file".
  const customProd = join(project, 'custom-prod.json');
  writeFileSync(customProd, JSON.stringify({
    rubric: 'custom-prod-v1',
    questions: {
      defaulted_check: {
        type: 'choice',
        instructions: 'Defaulted scope?',
        criteria: { pass: 'Yes', fail: 'No' },
      },
      explicit_file_check: {
        type: 'choice',
        scope: 'file',
        instructions: 'File scope?',
        criteria: { pass: 'Yes', fail: 'No' },
      },
    },
  }));
  const customResolved = resolveRubrics({
    rubrics: [customProd],
    hasRequirements: false,
    hasConventions: false,
  });
  assert.deepEqual(customResolved.scopes, {
    defaulted_check: 'module',
    explicit_file_check: 'file',
  });

  // Dry-run request.json never leaks scope into question payloads.
  const out = join(root, 'scope-strip');
  const proc = run('preview', ['--source', 'booking', '--rubric', 'fowler-smells', '--out', out, '--dry-run']);
  assert.equal(proc.status, 0, proc.stderr);
  const request = JSON.parse(readFileSync(join(out, 'request.json'), 'utf8'));
  for (const question of Object.values(request.questions) as Array<Record<string, unknown>>) {
    assert.deepEqual(Object.keys(question).sort(), ['criteria', 'instructions', 'type']);
  }

  // Invalid scope values on production_code and file/module scopes on project_structure are rejected.
  const badProd = join(project, 'bad-prod-scope.json');
  writeFileSync(badProd, JSON.stringify({
    rubric: 'bad-prod-v1',
    questions: {
      bad_check: { type: 'choice', scope: 'structure', instructions: 'Bad?', criteria: { pass: 'Yes', fail: 'No' } },
    },
  }));
  assert.throws(
    () => resolveRubrics({ rubrics: [badProd], hasRequirements: false, hasConventions: false }),
    /Invalid scope for bad_check/,
  );

  for (const badScope of ['file', 'module', 'bogus']) {
    const badStruct = join(project, `bad-struct-${badScope}.json`);
    writeFileSync(badStruct, JSON.stringify({
      rubric: `bad-struct-${badScope}-v1`,
      target: 'project_structure',
      questions: {
        bad_struct_check: { type: 'choice', scope: badScope, instructions: 'Bad?', criteria: { pass: 'Yes', fail: 'No' } },
      },
    }));
    assert.throws(
      () => resolveRubrics({ rubrics: [badStruct], hasRequirements: false, hasConventions: false }),
      /Invalid scope for bad_struct_check/,
    );
  }
});

test('dry-run works without --requirements, accepts short names, and includes env.ts and password.ts', (t) => {
  const { run, root } = setup(t);
  const out = join(root, 'preview');
  const proc = run('preview', [
    '--source', 'booking',
    '--rubric', 'readability',
    '--rubric', 'module-design-v2',
    '--out', out,
    '--dry-run',
  ]);
  assert.equal(proc.status, 0, proc.stderr);
  const result = JSON.parse(proc.stdout);
  const requestPath = join(out, 'request.json');
  const request = JSON.parse(readFileSync(requestPath, 'utf8'));

  assert.equal(result.status, 'dry_run');
  assert.equal(result.rubric, 'readability-v2+module-design-v2');
  assert.equal(result.file_count, 4);
  assert.equal(result.quality, null);
  assert.equal('deterministic' in result, false);
  assert.equal('target' in result, false);
  assert.equal('requirement' in request.state, false);
  assert.equal('conventions' in request.state, false);
  assert.deepEqual(
    Object.keys(request.state.production_files),
    ['Booking.kt', 'env.ts', 'password.ts', 'Room.kt'].sort((a, b) => a.localeCompare(b)),
  );
  assert.equal(existsSync(join(out, 'response.txt')), false);
  if (process.platform !== 'win32') {
    assert.equal(statSync(out).mode & 0o077, 0);
    assert.equal(statSync(requestPath).mode & 0o077, 0);
  }
});

test('supports --all, --exclude, --conventions precedence, and repo-local JSON rubrics', (t) => {
  const { run, root, project } = setup(t);
  const customRubricPath = join(project, 'repo-rules.json');
  writeFileSync(customRubricPath, JSON.stringify({
    rubric: 'team-api-v1',
    questions: {
      uses_problem_details: {
        type: 'choice',
        instructions: 'Do HTTP error responses use RFC 7807 Problem Details?',
        criteria: {
          pass: 'Errors map to Problem Details payloads or no HTTP handlers are present.',
          fail: 'HTTP handlers emit ad-hoc error payloads.',
        },
      },
    },
  }));

  const out = join(root, 'combined');
  const proc = run('preview', [
    '--source', 'booking',
    '--requirements', 'requirements.md',
    '--conventions', 'conventions.md',
    '--all',
    '--rubric', customRubricPath,
    '--exclude', 'immutable_state',
    '--out', out,
    '--dry-run',
  ]);
  assert.equal(proc.status, 0, proc.stderr);

  const result = JSON.parse(proc.stdout);
  const request = JSON.parse(readFileSync(join(out, 'request.json'), 'utf8'));

  assert.equal(request.state.requirement, 'Book a room.\n');
  assert.equal(request.state.conventions, 'Use mutable JPA entities when annotated with @Entity.\n');
  assert.equal('immutable_state' in request.questions, false);
  assert.ok('uses_problem_details' in request.questions);
  assert.ok('follows_repo_conventions' in request.questions);
  assert.match(request.questions.direct_readability.instructions, /state\.conventions takes precedence/);
  assert.doesNotMatch(request.questions.follows_repo_conventions.instructions, /state\.conventions takes precedence/);
  assert.deepEqual(result.excluded_checks, ['immutable_state']);
  assert.ok(result.rubric.includes('team-api-v1'));
  assert.ok(result.rubric.includes('repo-conventions'));
  assert.deepEqual(result.rubric_groups.conventions, ['follows_repo_conventions']);
  assert.deepEqual(result.rubric_groups['api-design'], [
    'no_rigid_enums_for_editorial_labels',
    'cohesive_resource_boundaries',
    'single_canonical_representation',
    'clean_server_owned_contracts_and_opaque_ids',
    'minimal_standard_http_surface',
  ]);
  assert.ok(!result.rubric_groups['domain-modelling'].includes('immutable_state'));
});

test('conventions can be used for precedence only by excluding follows_repo_conventions', (t) => {
  const { run, root } = setup(t);
  const out = join(root, 'precedence-only');
  const proc = run('preview', [
    '--source', 'booking',
    '--rubric', 'readability',
    '--conventions', 'conventions.md',
    '--exclude', 'follows_repo_conventions',
    '--out', out,
    '--dry-run',
  ]);
  assert.equal(proc.status, 0, proc.stderr);
  const result = JSON.parse(proc.stdout);
  const request = JSON.parse(readFileSync(join(out, 'request.json'), 'utf8'));
  assert.equal('follows_repo_conventions' in request.questions, false);
  assert.equal(result.rubric, 'readability-v2');
  assert.equal(request.state.conventions, 'Use mutable JPA entities when annotated with @Entity.\n');
  assert.match(request.questions.direct_readability.instructions, /state\.conventions takes precedence/);
});

test('live scoring makes a single Decisions call and records errors with credential redaction', (t) => {
  const { run, root, source } = setup(t);
  const before = readFileSync(join(source, 'Booking.kt'), 'utf8');

  const scoredOut = join(root, 'scored');
  const scored = run('scored', [
    '--source', 'booking',
    '--rubric', 'readability',
    '--rubric', 'module-design',
    '--out', scoredOut,
  ]);
  assert.equal(scored.status, 0, scored.stderr);
  const result = JSON.parse(scored.stdout);
  assert.deepEqual(result, JSON.parse(readFileSync(join(scoredOut, 'result.json'), 'utf8')));
  assert.equal(result.status, 'scored');
  assert.equal(result.returned_model, 'decisions-mock');
  assert.equal(result.pass_threshold, 0.8);
  assert.equal(result.quality.pass_rate, 0.25);
  assert.equal(result.quality.checks.direct_readability.choice, 'fail');
  assert.equal(result.quality.checks.direct_readability.model_choice, 'fail');
  assert.equal(result.quality.checks.no_unnecessary_abstraction.choice, 'fail');
  assert.equal(result.quality.checks.no_unnecessary_abstraction.model_choice, 'pass');
  assert.equal(result.quality.checks.no_unnecessary_abstraction.pass_probability, 0.65);
  assert.equal(result.quality.checks.named_domain_expressions.choice, 'pass');
  assert.equal(result.quality.checks.named_domain_expressions.model_choice, 'pass');
  assert.equal(existsSync(join(scoredOut, 'evidence.json')), false);

  const errOut = join(root, 'key-echo');
  const errProc = run('key-echo', [
    '--source', 'booking',
    '--rubric', 'readability',
    '--out', errOut,
  ]);
  assert.equal(errProc.status, 2);
  const errResult = JSON.parse(errProc.stdout);
  assert.equal(errResult.status, 'error');
  assert.match(errResult.error, /credential material/);
  const savedResp = readFileSync(join(errOut, 'response.txt'), 'utf8');
  assert.ok(!savedResp.includes('fixture-api-key'));
  assert.ok(savedResp.includes('[redacted]'));

  assert.equal(readFileSync(join(source, 'Booking.kt'), 'utf8'), before);
});

test('ancestor directories named test/build/env do not block scoring', (t) => {
  const { run, root } = setup(t, 'build/test/dev-env/password-service');
  const out = join(root, 'ancestor-ok');
  const proc = run('preview', [
    '--source', 'booking',
    '--requirements', 'requirements.md',
    '--rubric', 'readability',
    '--out', out,
    '--dry-run',
  ]);
  assert.equal(proc.status, 0, proc.stderr);
  const result = JSON.parse(proc.stdout);
  assert.equal(result.status, 'dry_run');
  assert.equal(result.file_count, 4);
});

test('rejects invalid inputs, bad exclusions, mismatched versions, and heuristic credentials unless overridden', (t) => {
  const { source, run, root, project } = setup(t);
  const out = join(root, 'reject');
  const requirementsLink = join(project, 'link.md');
  symlinkSync(join(project, 'requirements.md'), requirementsLink);
  const alias = join(project, 'alias');
  symlinkSync(source, alias);

  for (const [args, error] of [
    [['--source', 'booking', '--rubric', 'solid-v999', '--out', out, '--dry-run'], /version unavailable/],
    [['--source', 'booking', '--rubric', 'readability', '--exclude', 'nope', '--out', out, '--dry-run'], /Unknown check ID/],
    [['--source', 'booking', '--rubric', 'module-design', '--exclude', 'modular_organization', '--exclude', 'no_unnecessary_abstraction', '--out', out, '--dry-run'], /No rubric checks remain/],
    [['--source', 'booking/BookingTest.kt', '--rubric', 'readability', '--out', out, '--dry-run'], /No supported production/],
    [['--source', 'booking/Link.kt', '--rubric', 'readability', '--out', out, '--dry-run'], /regular source file or directory/],
    [['--source', 'booking', '--requirements', requirementsLink, '--rubric', 'readability', '--out', out, '--dry-run'], /regular Markdown or text/],
    [['--source', 'booking', '--rubric', 'readability', '--out', join(alias, 'nested', 'scores'), '--dry-run'], /outside the selected source directory/],
  ] as const) {
    const proc = run('reject', [...args]);
    assert.equal(proc.status, 1, proc.stderr);
    assert.match(proc.stderr, error);
    assert.equal(existsSync(out), false);
    assert.equal(existsSync(join(source, 'nested')), false);
  }

  const benignLiteral = 'X-API-Key';
  writeFileSync(join(source, 'Headers.kt'), `const val apiKey = "${benignLiteral}"\n`);
  const blocked = run('reject', ['--source', 'booking', '--rubric', 'readability', '--out', out, '--dry-run']);
  assert.equal(blocked.status, 1);
  assert.match(blocked.stderr, /Possible credential.*--allow-credentials/);
  assert.ok(!blocked.stderr.includes(benignLiteral));
  assert.equal(existsSync(out), false);

  const allowedOut = join(root, 'allowed');
  const allowed = run('preview', [
    '--source', 'booking',
    '--rubric', 'readability',
    '--out', allowedOut,
    '--allow-credentials',
    '--dry-run',
  ]);
  assert.equal(allowed.status, 0, allowed.stderr);

  // Even with --allow-credentials, an embedded live OPENROUTER_API_KEY is still rejected.
  writeFileSync(join(source, 'Leaked.kt'), 'const val k = "fixture-api-key"\n');
  const leaked = run('reject', [
    '--source', 'booking',
    '--rubric', 'readability',
    '--out', join(root, 'leaked'),
    '--allow-credentials',
    '--dry-run',
  ], { OPENROUTER_API_KEY: 'fixture-api-key' });
  assert.equal(leaked.status, 1);
  assert.match(leaked.stderr, /OPENROUTER_API_KEY appears/);
  assert.ok(!leaked.stderr.includes('fixture-api-key'));
});

test('structure mode builds a compact manifest including .server/.client, exports, imports, and rejects mixed rubrics', (t) => {
  const { run, root, project } = setup(t);
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

  // --mode structure defaults to all bundled structure rubrics
  const out = join(root, 'structure-preview');
  const proc = run('preview', [
    '--source', 'onboarding',
    '--mode', 'structure',
    '--out', out,
    '--dry-run',
  ]);
  assert.equal(proc.status, 0, proc.stderr);
  const result = JSON.parse(proc.stdout);
  const request = JSON.parse(readFileSync(join(out, 'request.json'), 'utf8'));

  assert.equal(result.mode, 'structure');
  assert.equal(result.rubric, 'integration-readiness-structure-v1+project-structure-v1');
  assert.deepEqual(result.rubric_groups['integration-readiness-structure'], [
    'no_bundled_stub_or_demo_modules',
    'no_parallel_shadow_directories',
  ]);
  assert.equal(result.file_count, 6);
  assert.equal('production_files' in request.state, false);
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
  assert.equal(manifest.files['.server/decisions.test.ts'].kind, 'test');
  assert.deepEqual(manifest.other_files, ['.server/data.json']);

  // Code mode also includes .server/ files
  const codeOut = join(root, 'dot-server-code');
  const codeProc = run('preview', [
    '--source', 'onboarding',
    '--rubric', 'readability',
    '--out', codeOut,
    '--dry-run',
  ]);
  assert.equal(codeProc.status, 0, codeProc.stderr);
  const codeReq = JSON.parse(readFileSync(join(codeOut, 'request.json'), 'utf8'));
  assert.ok('.server/decisions.ts' in codeReq.state.production_files);
  assert.equal('.server/decisions.test.ts' in codeReq.state.production_files, false);

  // Mixing production_code and project_structure rubrics is rejected
  const mixProc = run('reject', [
    '--source', 'onboarding',
    '--rubric', 'readability',
    '--rubric', 'project-structure',
    '--out', join(root, 'mix'),
    '--dry-run',
  ]);
  assert.equal(mixProc.status, 1);
  assert.match(mixProc.stderr, /Cannot mix production_code and project_structure/);

  // --rubric project-structure infers structure mode without --mode and extracts Kotlin metadata
  const kotlinDir = join(project, 'kt-module');
  mkdirSync(join(kotlinDir, 'domain'), { recursive: true });
  writeFileSync(
    join(kotlinDir, 'domain/Booking.kt'),
    'package com.example.booking.domain\nimport com.example.shared.Money\nimport org.springframework.stereotype.Service\nimport java.time.Instant\ndata class Booking(val id: String)\nfun createBooking() = Booking("1")\n',
  );
  writeFileSync(
    join(kotlinDir, 'domain/BookingTest.kt'),
    'package com.example.booking.domain\nclass BookingTest\n',
  );
  const ktOut = join(root, 'kt-struct');
  const ktProc = run('preview', [
    '--source', 'kt-module',
    '--rubric', 'project-structure',
    '--out', ktOut,
    '--dry-run',
  ]);
  assert.equal(ktProc.status, 0, ktProc.stderr);
  const ktReq = JSON.parse(readFileSync(join(ktOut, 'request.json'), 'utf8'));
  const bookingMeta = ktReq.state.project_structure.files['domain/Booking.kt'];
  assert.equal(bookingMeta.package, 'com.example.booking.domain');
  assert.deepEqual(bookingMeta.exports, ['Booking', 'createBooking']);
  assert.deepEqual(bookingMeta.local_imports, ['shared.Money']);
  assert.deepEqual(bookingMeta.external_imports, ['org.springframework.stereotype']);
  assert.equal(ktReq.state.project_structure.files['domain/BookingTest.kt'].kind, 'test');

  // Single file --source is rejected in structure mode
  const singleFile = run('reject', [
    '--source', 'kt-module/domain/Booking.kt',
    '--mode', 'structure',
    '--out', join(root, 'single-struct'),
    '--dry-run',
  ]);
  assert.equal(singleFile.status, 1);
  assert.match(singleFile.stderr, /regular directory/);

  // --list-rubrics tags structure rubrics as [structure]
  const listed = run('preview', ['--list-rubrics']);
  assert.equal(listed.status, 0, listed.stderr);
  assert.match(listed.stdout, /project-structure \(project-structure-v1\) \[structure\]: no_junk_drawer_directories/);
  assert.match(listed.stdout, /integration-readiness-structure \(integration-readiness-structure-v1\) \[structure\]: no_bundled_stub_or_demo_modules/);

  // Selecting integration-readiness-structure alone infers structure mode; mixing with integration-readiness is rejected
  const irStructOut = join(root, 'ir-struct');
  const irStructProc = run('preview', [
    '--source', 'onboarding',
    '--rubric', 'integration-readiness-structure',
    '--out', irStructOut,
    '--dry-run',
  ]);
  assert.equal(irStructProc.status, 0, irStructProc.stderr);
  const irStructRes = JSON.parse(irStructProc.stdout);
  assert.equal(irStructRes.mode, 'structure');
  assert.equal(irStructRes.rubric, 'integration-readiness-structure-v1');

  const irMixProc = run('reject', [
    '--source', 'onboarding',
    '--rubric', 'integration-readiness',
    '--rubric', 'integration-readiness-structure',
    '--out', join(root, 'ir-mix'),
    '--dry-run',
  ]);
  assert.equal(irMixProc.status, 1);
  assert.match(irMixProc.stderr, /Cannot mix production_code and project_structure/);
});

test('codex and claude backends adapt structured outputs into unified result.json without OPENROUTER_API_KEY', (t) => {
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

  const codexOut = join(root, 'codex-scored');
  const codexProc = run('preview', [
    '--source', 'booking',
    '--rubric', 'readability',
    '--backend', 'codex',
    '--out', codexOut,
  ], stubEnv);
  assert.equal(codexProc.status, 0, codexProc.stderr);
  const codexRes = JSON.parse(codexProc.stdout);
  assert.equal(codexRes.status, 'scored');
  assert.equal(codexRes.backend, 'codex');
  assert.equal(codexRes.pass_threshold, null);
  assert.equal(codexRes.requested_model, 'gpt-6-luna');
  assert.equal(codexRes.returned_model, 'gpt-6-luna');
  assert.equal(codexRes.quality.pass_rate, 0.5);
  assert.deepEqual(codexRes.quality.checks.direct_readability, {
    choice: 'pass',
    model_choice: 'pass',
    pass_probability: null,
    confidence: null,
    note: 'Clear domain names.',
  });
  assert.deepEqual(codexRes.quality.checks.named_domain_expressions, {
    choice: 'fail',
    model_choice: 'borderline',
    pass_probability: null,
    confidence: null,
    note: 'Mixed concern in one check.',
  });

  const claudeOut = join(root, 'claude-scored');
  const claudeProc = run('preview', [
    '--source', 'booking',
    '--rubric', 'readability',
    '--backend', 'claude',
    '--out', claudeOut,
  ], stubEnv);
  assert.equal(claudeProc.status, 0, claudeProc.stderr);
  const claudeRes = JSON.parse(claudeProc.stdout);
  assert.equal(claudeRes.status, 'scored');
  assert.equal(claudeRes.backend, 'claude');
  assert.equal(claudeRes.requested_model, 'haiku');
  assert.equal(claudeRes.returned_model, 'claude-haiku-test');
  assert.equal(claudeRes.pass_threshold, null);
  assert.equal(claudeRes.quality.pass_rate, 0.5);
  assert.equal(claudeRes.quality.checks.named_domain_expressions.choice, 'fail');
  assert.equal(claudeRes.quality.checks.named_domain_expressions.model_choice, 'fail');

  const modelOnCodex = run('reject', [
    '--source', 'booking',
    '--rubric', 'readability',
    '--backend', 'codex',
    '--model', 'gpt-6.2-sol',
    '--out', join(root, 'codex-model'),
    '--dry-run',
  ]);
  assert.equal(modelOnCodex.status, 1);
  assert.match(modelOnCodex.stderr, /only supported with --backend openrouter/);

  const badBackend = run('reject', [
    '--source', 'booking',
    '--rubric', 'readability',
    '--backend', 'unknown',
    '--out', join(root, 'bad-backend'),
    '--dry-run',
  ]);
  assert.equal(badBackend.status, 1);
  assert.match(badBackend.stderr, /Invalid --backend/);
});

test('file mode filters to file-scoped checks, records skipped_module_checks, and rejects empty-after-filter rubrics', (t) => {
  const { run, root } = setup(t);

  // fowler-smells + conventions: keeps 5 file checks, skips 4 module checks + module-scoped follows_repo_conventions,
  // while still sending state.conventions precedence in every per-file request.json.
  const out = join(root, 'file-dry');
  const proc = run('preview', [
    '--source', 'booking',
    '--mode', 'file',
    '--rubric', 'fowler-smells',
    '--conventions', 'conventions.md',
    '--out', out,
    '--dry-run',
  ]);
  assert.equal(proc.status, 0, proc.stderr);
  const result = JSON.parse(proc.stdout);
  assert.equal(result.status, 'dry_run');
  assert.equal(result.mode, 'file');
  assert.equal(result.file_count, 4);
  assert.equal(typeof result.elapsed_ms, 'number');
  assert.deepEqual(result.rubric_groups['fowler-smells'], [
    'no_long_functions',
    'no_long_parameter_lists_or_data_clumps',
    'no_message_chains',
    'no_primitive_obsession',
    'no_comment_deodorant_or_dead_code',
  ]);
  assert.equal('conventions' in result.rubric_groups, false);
  assert.deepEqual(result.skipped_module_checks, [
    'no_duplicated_code',
    'no_feature_envy_or_data_class_anemia',
    'no_repeated_switches',
    'no_speculative_or_middle_man',
    'follows_repo_conventions',
  ]);
  assert.deepEqual(result.check_thresholds, { no_primitive_obsession: 0.6 });
  assert.equal(result.file_results.length, 4);
  assert.deepEqual(
    result.file_results.map((entry: { file: string }) => entry.file),
    ['Booking.kt', 'env.ts', 'password.ts', 'Room.kt'].sort((a, b) => a.localeCompare(b)),
  );
  assert.equal(existsSync(join(out, 'request.json')), false);
  for (const entry of result.file_results) {
    const reqPath = join(out, entry.result_dir, 'request.json');
    const resPath = join(out, entry.result_dir, 'result.json');
    assert.ok(existsSync(reqPath));
    assert.ok(existsSync(resPath));
    assert.equal(existsSync(join(out, entry.result_dir, 'response.txt')), false);
    const req = JSON.parse(readFileSync(reqPath, 'utf8'));
    assert.deepEqual(Object.keys(req.state.production_files), [entry.file]);
    assert.equal(req.state.conventions, 'Use mutable JPA entities when annotated with @Entity.\n');
    assert.match(req.questions.no_long_functions.instructions, /state\.conventions takes precedence/);
    assert.equal(Object.keys(req.questions).length, 5);
    if (process.platform !== 'win32') {
      assert.equal(statSync(join(out, entry.result_dir)).mode & 0o077, 0);
      assert.equal(statSync(reqPath).mode & 0o077, 0);
    }
  }

  // module-design and solid have only module-scoped checks -> error clearly in --mode file.
  for (const [rubricName, expectedSkipped] of [
    ['module-design', /modular_organization/],
    ['solid', /single_responsibility.*dependency_inversion/],
  ] as const) {
    const emptyErr = run('reject', [
      '--source', 'booking',
      '--mode', 'file',
      '--rubric', rubricName,
      '--out', join(root, `empty-file-mode-${rubricName}`),
      '--dry-run',
    ]);
    assert.equal(emptyErr.status, 1);
    assert.match(emptyErr.stderr, /No file-scoped checks remain for --mode file/);
    assert.match(emptyErr.stderr, expectedSkipped);
    assert.equal(existsSync(join(root, `empty-file-mode-${rubricName}`)), false);
  }
});

test('file mode allows >128 KiB multi-file directories while rejecting any single file exceeding 128 KiB', (t) => {
  const { run, root, project } = setup(t);
  const largeDir = join(project, 'large-repo');
  mkdirSync(largeDir, { recursive: true });
  const chunk = `${'export const line = "1234567890abcdef";\n'.repeat(1200)}`; // ~48 KiB each
  for (const name of ['a.ts', 'b.ts', 'c.ts', 'd.ts']) {
    writeFileSync(join(largeDir, name), chunk); // ~192 KiB total
  }

  // Whole-module code mode rejects >128 KiB total.
  const codeReject = run('reject', [
    '--source', 'large-repo',
    '--mode', 'code',
    '--rubric', 'readability',
    '--out', join(root, 'large-code'),
    '--dry-run',
  ]);
  assert.equal(codeReject.status, 1);
  assert.match(codeReject.stderr, /exceed 128 KiB/);

  // Per-file mode succeeds cleanly across all 4 files (~192 KiB total).
  const fileOut = join(root, 'large-file-dry');
  const fileOk = run('preview', [
    '--source', 'large-repo',
    '--mode', 'file',
    '--rubric', 'readability',
    '--out', fileOut,
    '--dry-run',
  ]);
  assert.equal(fileOk.status, 0, fileOk.stderr);
  const fileResult = JSON.parse(fileOk.stdout);
  assert.equal(fileResult.file_count, 4);

  // Oversized single file fails fast with its path before creating --out or calling API.
  writeFileSync(join(largeDir, 'huge.ts'), 'x'.repeat(130 * 1024));
  const hugeReject = run('reject', [
    '--source', 'large-repo',
    '--mode', 'file',
    '--rubric', 'readability',
    '--out', join(root, 'huge-out'),
    '--dry-run',
  ]);
  assert.equal(hugeReject.status, 1);
  assert.match(hugeReject.stderr, /huge\.ts/);
  assert.match(hugeReject.stderr, /128 KiB/);
  assert.equal(existsSync(join(root, 'huge-out')), false);
});

test('file mode scores concurrently with OpenRouter, aggregates metrics, formats summary, and honors --fail-on-violation', (t) => {
  const { run, root } = setup(t);

  // Live file-mode run with --format json (default exit 0 even with violations).
  const jsonOut = join(root, 'file-scored-json');
  const jsonProc = run('scored', [
    '--source', 'booking',
    '--mode', 'file',
    '--rubric', 'fowler-smells',
    '--concurrency', '2',
    '--out', jsonOut,
  ]);
  assert.equal(jsonProc.status, 0, jsonProc.stderr);
  const result = JSON.parse(jsonProc.stdout);
  assert.equal(result.status, 'scored');
  assert.equal(result.mode, 'file');
  assert.equal(result.file_count, 4);
  assert.equal(result.returned_model, 'decisions-mock');
  assert.deepEqual(
    result.file_results.map((entry: { file: string }) => entry.file),
    ['Booking.kt', 'env.ts', 'password.ts', 'Room.kt'].sort((a, b) => a.localeCompare(b)),
  );
  // 4 files x 5 file-scoped checks: Booking.kt fails 2 (no_long_functions 0.15, no_primitive_obsession 0.45),
  // Room.kt fails 1 due to threshold (no_long_functions 0.65 < 0.8), env.ts & password.ts pass all 5.
  assert.equal(result.quality.checks.no_long_functions.choice, 'fail');
  assert.equal(result.quality.checks.no_long_functions.files_passed, 2);
  assert.equal(result.quality.checks.no_long_functions.files_total, 4);
  assert.equal(result.quality.checks.no_long_functions.files_raw_failed, 1);
  assert.equal(result.quality.checks.no_long_functions.files_threshold_failed, 1);
  assert.equal(result.quality.checks.no_long_functions.min_pass_probability, 0.15);
  assert.equal(result.quality.checks.no_primitive_obsession.choice, 'fail');
  assert.equal(result.quality.checks.no_primitive_obsession.files_passed, 3);
  assert.equal(result.quality.checks.no_primitive_obsession.files_raw_failed, 1);
  assert.equal('files_threshold_failed' in result.quality.checks.no_primitive_obsession, false);
  assert.equal(result.quality.checks.no_primitive_obsession.min_pass_probability, 0.45);
  assert.equal(result.quality.checks.no_message_chains.choice, 'pass');
  assert.equal(result.quality.checks.no_message_chains.files_passed, 4);
  assert.equal(result.quality.all_files_pass_rate, 3 / 5);
  assert.ok(Math.abs(result.quality.pass_rate - (17 / 20)) < 1e-9);
  for (const entry of result.file_results) {
    assert.ok(existsSync(join(jsonOut, entry.result_dir, 'response.txt')));
    assert.ok(existsSync(join(jsonOut, entry.result_dir, 'result.json')));
  }

  // --format summary + --fail-on-violation exits 1 on violations and prints worst-first failing files.
  const summaryOut = join(root, 'file-scored-summary');
  const summaryProc = run('scored', [
    '--source', 'booking',
    '--mode', 'file',
    '--rubric', 'fowler-smells',
    '--format', 'summary',
    '--fail-on-violation',
    '--out', summaryOut,
  ]);
  assert.equal(summaryProc.status, 1, summaryProc.stderr);
  assert.match(summaryProc.stdout, /judge-code \(file\)/);
  assert.match(summaryProc.stdout, /Findings: 3 across 2 of 4 files \(2 raw FAIL, 1 threshold borderline\)/);
  assert.doesNotMatch(summaryProc.stdout, /%/);
  assert.match(summaryProc.stdout, /Findings by rule \(2 of 5 rules\):/);
  assert.match(summaryProc.stdout, /FAIL\s+no_long_functions\s+2\/4 files\s+\(1 raw FAIL, 1 threshold borderline; min P\(pass\)=0\.15; threshold 0\.80\)/);
  assert.match(summaryProc.stdout, /FAIL\s+no_primitive_obsession\s+1\/4 files\s+\(1 raw FAIL; min P\(pass\)=0\.45; threshold 0\.60\)/);
  assert.match(summaryProc.stdout, /Clean rules \(3\):.*no_message_chains/);
  const longFnIdx = summaryProc.stdout.indexOf('FAIL  no_long_functions');
  const primIdx = summaryProc.stdout.indexOf('FAIL  no_primitive_obsession');
  assert.ok(longFnIdx !== -1 && primIdx !== -1 && longFnIdx < primIdx, 'rules with more findings must appear first');
  assert.match(summaryProc.stdout, /Hotspot files \(2 of 4 files\):/);
  assert.match(summaryProc.stdout, /Booking\.kt \(2 findings\): no_long_functions \[raw FAIL: P\(pass\)=0\.15 < 0\.80\], no_primitive_obsession \[raw FAIL: P\(pass\)=0\.45 < 0\.60\]/);
  assert.match(summaryProc.stdout, /Room\.kt \(1 finding\): no_long_functions \[threshold borderline, raw PASS: P\(pass\)=0\.65 < 0\.80\]/);
  assert.match(summaryProc.stdout, /Skipped module checks \(4\): no_duplicated_code/);
  const bookingIdx = summaryProc.stdout.indexOf('Booking.kt (2 findings)');
  const roomIdx = summaryProc.stdout.indexOf('Room.kt (1 finding)');
  assert.ok(bookingIdx !== -1 && roomIdx !== -1 && bookingIdx < roomIdx, 'worst failing file must appear first');

  // --fail-on-violation exits 0 when every check passes.
  const passOut = join(root, 'file-pass');
  const passProc = run('pass', [
    '--source', 'booking',
    '--mode', 'file',
    '--rubric', 'fowler-smells',
    '--fail-on-violation',
    '--out', passOut,
  ]);
  assert.equal(passProc.status, 0, passProc.stderr);

  // Invalid --concurrency and --format are rejected.
  for (const [flag, val, pat] of [
    ['--concurrency', '0', /Invalid --concurrency/],
    ['--concurrency', 'abc', /Invalid --concurrency/],
    ['--format', 'yaml', /Invalid --format/],
    ['--mode', 'bogus', /Invalid --mode/],
  ] as const) {
    const bad = run('reject', ['--source', 'booking', '--rubric', 'readability', flag, val, '--out', join(root, 'bad-arg'), '--dry-run']);
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, pat);
  }
});

test('decisions.mts retries 429/5xx with backoff and Retry-After, tracks concurrency bounds, and fails fast on 4xx', async (t) => {
  const { root } = setup(t);
  const { parseRetryAfterMs, runDecisionJudge } = await import('../scripts/decisions.mts');
  const { resolveRubrics } = await import('../scripts/rubrics.mts');

  const prevKey = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = 'unit-test-key';
  t.after(() => {
    if (prevKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = prevKey;
  });

  // parseRetryAfterMs unit checks
  const nowMs = Date.parse('2026-11-25T00:00:00Z');
  assert.equal(parseRetryAfterMs('5', nowMs), 5_000);
  assert.equal(parseRetryAfterMs('180', nowMs, 60_000), 60_000);
  assert.equal(parseRetryAfterMs('Wed, 25 Nov 2026 00:00:12 GMT', nowMs), 12_000);
  assert.equal(parseRetryAfterMs('invalid', nowMs), null);

  const rubric = resolveRubrics({
    mode: 'file',
    rubrics: ['readability'],
    hasRequirements: false,
    hasConventions: false,
  });

  // Retry recovery across 429 -> 502 -> 503 (with Retry-After) -> 200.
  const sleeps: number[] = [];
  let retryCalls = 0;
  const recovered = await runDecisionJudge(
    {
      mode: 'code',
      files: { 'a.ts': 'export const a = 1;\n' },
      rubric,
      model: 'liquid/d1.2-ultra',
      out: join(root, 'retry-recover'),
    },
    async () => {
      retryCalls += 1;
      if (retryCalls === 1) return new Response('rate limited', { status: 429 });
      if (retryCalls === 2) return new Response('bad gateway', { status: 502 });
      if (retryCalls === 3) return new Response('unavailable', { status: 503, headers: { 'Retry-After': '7' } });
      return Response.json({
        model: 'mock-retry',
        answers: {
          direct_readability: { type: 'choice', choice: 'pass', probabilities: { pass: 0.9, fail: 0.1 }, confidence: 0.8 },
          named_domain_expressions: { type: 'choice', choice: 'pass', probabilities: { pass: 0.95, fail: 0.05 }, confidence: 0.9 },
        },
      });
    },
    {
      sleep: async (ms) => { sleeps.push(ms); },
      random: () => 0.5,
      onRetry: () => {},
    },
  );
  assert.equal(retryCalls, 4);
  assert.deepEqual(sleeps, [4_000, 8_000, 7_000]);
  assert.equal(recovered.status, 'scored');
  assert.equal(recovered.retries, 3);

  // Non-retryable HTTP 400 fails immediately with zero retries.
  let nonRetryCalls = 0;
  const badReq = await runDecisionJudge(
    {
      mode: 'code',
      files: { 'a.ts': 'export const a = 1;\n' },
      rubric,
      model: 'liquid/d1.2-ultra',
      out: join(root, 'retry-400'),
    },
    async () => {
      nonRetryCalls += 1;
      return new Response('bad request', { status: 400 });
    },
    {
      sleep: async () => { throw new Error('must not sleep on 400'); },
      onRetry: () => {},
    },
  );
  assert.equal(nonRetryCalls, 1);
  assert.equal(badReq.status, 'error');
  assert.match(badReq.error!, /HTTP 400/);

  // Exhausting retries on 429 records error after maxRetries + 1 attempts.
  let exhaustCalls = 0;
  const exhausted = await runDecisionJudge(
    {
      mode: 'code',
      files: { 'a.ts': 'export const a = 1;\n' },
      rubric,
      model: 'liquid/d1.2-ultra',
      out: join(root, 'retry-exhaust'),
    },
    async () => {
      exhaustCalls += 1;
      return new Response('still rate limited', { status: 429 });
    },
    {
      maxRetries: 2,
      sleep: async () => {},
      onRetry: () => {},
    },
  );
  assert.equal(exhaustCalls, 3);
  assert.equal(exhausted.status, 'error');
  assert.match(exhausted.error!, /HTTP 429 after 3 attempts/);

  // Bounded concurrency in --mode file: 5 files with concurrency 2 never exceeds 2 in-flight and preserves sorted order.
  let inFlight = 0;
  let peakInFlight = 0;
  const concurrent = await runDecisionJudge(
    {
      mode: 'file',
      files: {
        'z.ts': 'export const z = 1;\n',
        'a.ts': 'export const a = 1;\n',
        'm.ts': 'export const m = 1;\n',
        'b.ts': 'export const b = 1;\n',
        'c.ts': 'export const c = 1;\n',
      },
      rubric,
      model: 'liquid/d1.2-ultra',
      concurrency: 2,
      out: join(root, 'concurrent-file'),
    },
    async (_url, init) => {
      inFlight += 1;
      peakInFlight = Math.max(peakInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 15));
      inFlight -= 1;
      const body = JSON.parse(String(init?.body));
      const file = Object.keys(body.state.production_files)[0];
      const passProb = file === 'm.ts' ? 0.4 : 0.9;
      return Response.json({
        model: 'mock-concurrent',
        answers: {
          direct_readability: { type: 'choice', choice: passProb >= 0.5 ? 'pass' : 'fail', probabilities: { pass: passProb, fail: Number((1 - passProb).toFixed(4)) }, confidence: 0.8 },
          named_domain_expressions: { type: 'choice', choice: 'pass', probabilities: { pass: 0.95, fail: 0.05 }, confidence: 0.9 },
        },
      });
    },
  );
  assert.equal(peakInFlight, 2);
  assert.equal(concurrent.status, 'scored');
  assert.deepEqual(concurrent.file_results!.map((f) => f.file), ['a.ts', 'b.ts', 'c.ts', 'm.ts', 'z.ts']);
  assert.equal(concurrent.quality!.checks.direct_readability.files_passed, 4);
  assert.equal(concurrent.quality!.checks.direct_readability.min_pass_probability, 0.4);
  assert.equal(concurrent.quality!.all_files_pass_rate, 0.5);
});

test('file mode works with codex and claude CLI backends concurrently', (t) => {
  const { run, root } = setup(t);
  const fakeBin = join(root, 'fake-bin-file');
  mkdirSync(fakeBin, { recursive: true });

  const codexStub = join(fakeBin, 'codex');
  writeFileSync(codexStub, `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const outIdx = args.indexOf('-o');
const schemaIdx = args.indexOf('--output-schema');
const stdin = fs.readFileSync(0, 'utf8');
const schema = JSON.parse(fs.readFileSync(args[schemaIdx + 1], 'utf8'));
const ids = schema.properties.checks.items.properties.id.enum;
const isBooking = stdin.includes('Booking.kt');
const payload = {
  checks: ids.map((id) => ({
    id,
    note: isBooking && id === 'direct_readability' ? 'Opaque names.' : 'Clean.',
    choice: isBooking && id === 'direct_readability' ? 'fail' : 'pass',
  })),
};
fs.writeFileSync(args[outIdx + 1], JSON.stringify(payload));
`);
  chmodSync(codexStub, 0o755);

  const claudeStub = join(fakeBin, 'claude');
  writeFileSync(claudeStub, `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const schemaIdx = args.indexOf('--json-schema');
const schema = JSON.parse(args[schemaIdx + 1]);
const ids = schema.properties.checks.items.properties.id.enum;
console.log(JSON.stringify({
  modelUsage: { 'claude-haiku-file': { inputTokens: 10 } },
  structured_output: {
    checks: ids.map((id) => ({ id, note: 'All good.', choice: 'pass' })),
  },
}));
`);
  chmodSync(claudeStub, 0o755);

  const stubEnv = { PATH: `${fakeBin}:${process.env.PATH ?? ''}` };

  const codexOut = join(root, 'codex-file');
  const codexProc = run('preview', [
    '--source', 'booking',
    '--mode', 'file',
    '--rubric', 'readability',
    '--backend', 'codex',
    '--concurrency', '2',
    '--fail-on-violation',
    '--out', codexOut,
  ], stubEnv);
  assert.equal(codexProc.status, 1, codexProc.stderr);
  const codexRes = JSON.parse(codexProc.stdout);
  assert.equal(codexRes.status, 'scored');
  assert.equal(codexRes.mode, 'file');
  assert.equal(codexRes.backend, 'codex');
  assert.equal(codexRes.quality.checks.direct_readability.choice, 'fail');
  assert.equal(codexRes.quality.checks.direct_readability.files_passed, 3);
  assert.equal(codexRes.quality.checks.direct_readability.files_total, 4);
  assert.equal(codexRes.quality.checks.direct_readability.pass_probability, null);
  assert.equal(codexRes.quality.checks.direct_readability.min_pass_probability, null);

  const claudeOut = join(root, 'claude-file');
  const claudeProc = run('preview', [
    '--source', 'booking',
    '--mode', 'file',
    '--rubric', 'readability',
    '--backend', 'claude',
    '--concurrency', '2',
    '--format', 'summary',
    '--fail-on-violation',
    '--out', claudeOut,
  ], stubEnv);
  assert.equal(claudeProc.status, 0, claudeProc.stderr);
  assert.match(claudeProc.stdout, /Findings: 0 across 4 files/);
  assert.match(claudeProc.stdout, /Clean rules \(2\): direct_readability, named_domain_expressions/);
});

test('formatSummary does not round failing sub-threshold probabilities up to the pass threshold', async () => {
  const { formatSummary } = await import('../scripts/format.mts');
  const summary = formatSummary({
    status: 'scored',
    backend: 'openrouter',
    mode: 'file',
    file_count: 1,
    elapsed_ms: 120,
    requested_model: 'liquid/d1.2-ultra',
    returned_model: 'liquid/d1.2-ultra',
    rubric: 'readability-v2',
    rubric_groups: { readability: ['direct_readability'] },
    pass_threshold: 0.8,
    quality: {
      pass_rate: 0,
      all_files_pass_rate: 0,
      checks: {
        direct_readability: {
          choice: 'fail',
          files_passed: 0,
          files_total: 1,
          pass_probability: 0.7961,
          min_pass_probability: 0.7961,
          confidence: 0.59,
        },
      },
    },
    file_results: [
      {
        file: 'edge.ts',
        status: 'scored',
        returned_model: 'liquid/d1.2-ultra',
        elapsed_ms: 120,
        pass_rate: 0,
        result_dir: 'files/01-edge.ts',
        checks: {
          direct_readability: {
            choice: 'fail',
            model_choice: 'pass',
            pass_probability: 0.7961,
            confidence: 0.59,
          },
        },
      },
    ],
  }, '/tmp/out');
  assert.match(summary, /min P\(pass\)=0\.796/);
  assert.match(summary, /direct_readability \[threshold borderline, raw PASS: P\(pass\)=0\.796 < 0\.80\]/);
  assert.doesNotMatch(summary, /P\(pass\)=0\.80/);
});

test('OpenRouter default model is typesafe/jev-1.14 in file mode and liquid/d1.2-ultra in code/structure modes', (t) => {
  const { run, root } = setup(t);

  // --help documents both per-mode defaults
  const helpProc = run('preview', ['--help']);
  assert.equal(helpProc.status, 0, helpProc.stderr);
  assert.match(helpProc.stdout, /liquid\/d1\.2-ultra for code\/structure, typesafe\/jev-1\.14 for file/);

  // --mode file defaults to typesafe/jev-1.14
  const fileOut = join(root, 'default-model-file');
  const fileProc = run('preview', ['--source', 'booking', '--mode', 'file', '--rubric', 'readability', '--out', fileOut, '--dry-run']);
  assert.equal(fileProc.status, 0, fileProc.stderr);
  const fileRes = JSON.parse(fileProc.stdout);
  assert.equal(fileRes.requested_model, 'typesafe/jev-1.14');
  const firstReq = JSON.parse(readFileSync(join(fileOut, fileRes.file_results[0].result_dir, 'request.json'), 'utf8'));
  assert.equal(firstReq.model, 'typesafe/jev-1.14');

  // Explicit --model overrides the --mode file default
  const overrideOut = join(root, 'override-model-file');
  const overrideProc = run('preview', [
    '--source', 'booking',
    '--mode', 'file',
    '--rubric', 'readability',
    '--model', 'liquid/d1.2-ultra',
    '--out', overrideOut,
    '--dry-run',
  ]);
  assert.equal(overrideProc.status, 0, overrideProc.stderr);
  const overrideRes = JSON.parse(overrideProc.stdout);
  assert.equal(overrideRes.requested_model, 'liquid/d1.2-ultra');
  const overrideReq = JSON.parse(readFileSync(join(overrideOut, overrideRes.file_results[0].result_dir, 'request.json'), 'utf8'));
  assert.equal(overrideReq.model, 'liquid/d1.2-ultra');

  // --mode code and --mode structure keep liquid/d1.2-ultra as default
  const codeOut = join(root, 'default-model-code');
  const codeProc = run('preview', ['--source', 'booking', '--mode', 'code', '--rubric', 'readability', '--out', codeOut, '--dry-run']);
  assert.equal(codeProc.status, 0, codeProc.stderr);
  assert.equal(JSON.parse(codeProc.stdout).requested_model, 'liquid/d1.2-ultra');
  assert.equal(JSON.parse(readFileSync(join(codeOut, 'request.json'), 'utf8')).model, 'liquid/d1.2-ultra');

  const structOut = join(root, 'default-model-struct');
  const structProc = run('preview', ['--source', 'booking', '--mode', 'structure', '--out', structOut, '--dry-run']);
  assert.equal(structProc.status, 0, structProc.stderr);
  assert.equal(JSON.parse(structProc.stdout).requested_model, 'liquid/d1.2-ultra');
  assert.equal(JSON.parse(readFileSync(join(structOut, 'request.json'), 'utf8')).model, 'liquid/d1.2-ultra');

  // --model remains rejected for --backend codex and --backend claude (including in --mode file)
  for (const backend of ['codex', 'claude'] as const) {
    const rejected = run('reject', [
      '--source', 'booking',
      '--mode', 'file',
      '--rubric', 'readability',
      '--backend', backend,
      '--model', 'typesafe/jev-1.14',
      '--out', join(root, `reject-model-${backend}`),
      '--dry-run',
    ]);
    assert.equal(rejected.status, 1);
    assert.match(rejected.stderr, /only supported with --backend openrouter/);
  }
});

test('per-criterion pass_threshold is validated, defaulted to 0.8, exposed on ResolvedRubric, and stripped from request payloads', async (t) => {
  const { run, root, project } = setup(t);
  const { PASS_THRESHOLD, parsePassThreshold, resolveRubrics } = await import('../scripts/rubrics.mts');

  // Bundled rubrics default to PASS_THRESHOLD (0.8) except calibrated overrides (no_primitive_obsession 0.6, named_domain_expressions 0.6).
  const bundled = resolveRubrics({
    rubrics: ['fowler-smells', 'readability'],
    exclude: ['no_duplicated_code'],
    hasRequirements: false,
    hasConventions: true,
  });
  assert.equal(PASS_THRESHOLD, 0.8);
  assert.equal(bundled.thresholds.no_long_functions, 0.8);
  assert.equal(bundled.thresholds.no_primitive_obsession, 0.6);
  assert.equal(bundled.thresholds.direct_readability, 0.8);
  assert.equal(bundled.thresholds.named_domain_expressions, 0.6);
  assert.equal(bundled.thresholds.follows_repo_conventions, 0.8);
  assert.equal('no_duplicated_code' in bundled.thresholds, false);

  // Custom production_code rubric supports optional pass_threshold overrides and defaults omitted values to 0.8.
  const customProd = join(project, 'custom-thresholds.json');
  writeFileSync(customProd, JSON.stringify({
    rubric: 'custom-thresholds-v1',
    questions: {
      lenient_check: {
        type: 'choice',
        scope: 'file',
        pass_threshold: 0.7,
        instructions: 'Lenient check?',
        criteria: { pass: 'Yes', fail: 'No' },
      },
      default_check: {
        type: 'choice',
        scope: 'file',
        instructions: 'Default check?',
        criteria: { pass: 'Yes', fail: 'No' },
      },
      strict_module_check: {
        type: 'choice',
        scope: 'module',
        pass_threshold: 1,
        instructions: 'Strict module check?',
        criteria: { pass: 'Yes', fail: 'No' },
      },
      explicit_default_check: {
        type: 'choice',
        scope: 'file',
        pass_threshold: 0.8,
        instructions: 'Explicit default check?',
        criteria: { pass: 'Yes', fail: 'No' },
      },
    },
  }));

  const resolvedCode = resolveRubrics({
    mode: 'code',
    rubrics: [customProd],
    hasRequirements: false,
    hasConventions: false,
  });
  assert.deepEqual(resolvedCode.thresholds, {
    lenient_check: 0.7,
    default_check: 0.8,
    strict_module_check: 1,
    explicit_default_check: 0.8,
  });
  for (const question of Object.values(resolvedCode.questions)) {
    assert.deepEqual(Object.keys(question).sort(), ['criteria', 'instructions', 'type']);
  }

  // File mode drops module-scoped checks from thresholds too.
  const resolvedFile = resolveRubrics({
    mode: 'file',
    rubrics: [customProd],
    hasRequirements: false,
    hasConventions: false,
  });
  assert.deepEqual(resolvedFile.thresholds, {
    lenient_check: 0.7,
    default_check: 0.8,
    explicit_default_check: 0.8,
  });
  assert.equal('strict_module_check' in resolvedFile.thresholds, false);

  // Dry-run request.json never leaks pass_threshold in code or file modes, while result.json records overrides.
  const codeOut = join(root, 'threshold-strip-code');
  const codeProc = run('preview', ['--source', 'booking', '--rubric', customProd, '--out', codeOut, '--dry-run']);
  assert.equal(codeProc.status, 0, codeProc.stderr);
  const codeRes = JSON.parse(codeProc.stdout);
  assert.equal(codeRes.pass_threshold, 0.8);
  assert.deepEqual(codeRes.check_thresholds, { lenient_check: 0.7, strict_module_check: 1 });
  const codeReq = JSON.parse(readFileSync(join(codeOut, 'request.json'), 'utf8'));
  for (const question of Object.values(codeReq.questions) as Array<Record<string, unknown>>) {
    assert.deepEqual(Object.keys(question).sort(), ['criteria', 'instructions', 'type']);
  }

  const fileOut = join(root, 'threshold-strip-file');
  const fileProc = run('preview', ['--source', 'booking', '--mode', 'file', '--rubric', customProd, '--out', fileOut, '--dry-run']);
  assert.equal(fileProc.status, 0, fileProc.stderr);
  const fileRes = JSON.parse(fileProc.stdout);
  assert.equal(fileRes.pass_threshold, 0.8);
  assert.deepEqual(fileRes.check_thresholds, { lenient_check: 0.7 });
  const perFileReq = JSON.parse(readFileSync(join(fileOut, fileRes.file_results[0].result_dir, 'request.json'), 'utf8'));
  for (const question of Object.values(perFileReq.questions) as Array<Record<string, unknown>>) {
    assert.deepEqual(Object.keys(question).sort(), ['criteria', 'instructions', 'type']);
  }

  // Excluding the only overridden check omits check_thresholds from result.json.
  const noOverrideOut = join(root, 'threshold-excluded');
  const noOverrideProc = run('preview', [
    '--source', 'booking',
    '--mode', 'file',
    '--rubric', customProd,
    '--exclude', 'lenient_check',
    '--out', noOverrideOut,
    '--dry-run',
  ]);
  assert.equal(noOverrideProc.status, 0, noOverrideProc.stderr);
  const noOverrideRes = JSON.parse(noOverrideProc.stdout);
  assert.equal(noOverrideRes.pass_threshold, 0.8);
  assert.equal('check_thresholds' in noOverrideRes, false);

  // Structure rubrics also support optional pass_threshold and strip it from request.json.
  const customStruct = join(project, 'custom-struct-thresholds.json');
  writeFileSync(customStruct, JSON.stringify({
    rubric: 'custom-struct-thresholds-v1',
    target: 'project_structure',
    questions: {
      struct_lenient: {
        type: 'choice',
        pass_threshold: 0.65,
        instructions: 'Lenient structure check?',
        criteria: { pass: 'Yes', fail: 'No' },
      },
      struct_default: {
        type: 'choice',
        instructions: 'Default structure check?',
        criteria: { pass: 'Yes', fail: 'No' },
      },
    },
  }));
  const structOut = join(root, 'threshold-strip-struct');
  const structProc = run('preview', ['--source', 'booking', '--rubric', customStruct, '--out', structOut, '--dry-run']);
  assert.equal(structProc.status, 0, structProc.stderr);
  const structRes = JSON.parse(structProc.stdout);
  assert.equal(structRes.mode, 'structure');
  assert.equal(structRes.pass_threshold, 0.8);
  assert.deepEqual(structRes.check_thresholds, { struct_lenient: 0.65 });
  const structReq = JSON.parse(readFileSync(join(structOut, 'request.json'), 'utf8'));
  for (const question of Object.values(structReq.questions) as Array<Record<string, unknown>>) {
    assert.deepEqual(Object.keys(question).sort(), ['criteria', 'instructions', 'type']);
  }

  // Invalid pass_threshold values (0, < 0, > 1, non-numbers, NaN, Infinity) are rejected.
  for (const badThreshold of [0, -0.1, -1, 1.01, 2, '0.7', null, true, {}, []]) {
    const badPath = join(project, `bad-threshold-${Math.random().toString(36).slice(2)}.json`);
    writeFileSync(badPath, JSON.stringify({
      rubric: 'bad-threshold-v1',
      questions: {
        bad_check: {
          type: 'choice',
          pass_threshold: badThreshold,
          instructions: 'Bad?',
          criteria: { pass: 'Yes', fail: 'No' },
        },
      },
    }));
    assert.throws(
      () => resolveRubrics({ rubrics: [badPath], hasRequirements: false, hasConventions: false }),
      /Invalid pass_threshold for bad_check/,
    );
  }
  for (const nonFinite of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    assert.throws(() => parsePassThreshold(nonFinite, 'bad_check'), /Invalid pass_threshold for bad_check/);
  }
  assert.equal(parsePassThreshold(undefined, 'ok_check'), 0.8);
  assert.equal(parsePassThreshold(0.001, 'ok_check'), 0.001);
  assert.equal(parsePassThreshold(1, 'ok_check'), 1);
});

test('OpenRouter scoring applies mixed per-criterion thresholds in code, file, and structure modes while CLI backends stay unchanged', async (t) => {
  const { run, root, project } = setup(t);
  const { runDecisionJudge } = await import('../scripts/decisions.mts');
  const { resolveRubrics } = await import('../scripts/rubrics.mts');
  const { readStructureInputs } = await import('../scripts/structure.mts');

  const prevKey = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = 'unit-test-key';
  t.after(() => {
    if (prevKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = prevKey;
  });

  const mixedRubricPath = join(project, 'mixed-thresholds.json');
  writeFileSync(mixedRubricPath, JSON.stringify({
    rubric: 'mixed-thresholds-v1',
    questions: {
      lenient_check: {
        type: 'choice',
        scope: 'file',
        pass_threshold: 0.7,
        instructions: 'Lenient?',
        criteria: { pass: 'Yes', fail: 'No' },
      },
      default_check: {
        type: 'choice',
        scope: 'file',
        instructions: 'Default?',
        criteria: { pass: 'Yes', fail: 'No' },
      },
      strict_check: {
        type: 'choice',
        scope: 'file',
        pass_threshold: 0.9,
        instructions: 'Strict?',
        criteria: { pass: 'Yes', fail: 'No' },
      },
    },
  }));

  const makeAnswer = (passProb: number) => ({
    type: 'choice',
    choice: passProb >= 0.5 ? 'pass' : 'fail',
    probabilities: { pass: passProb, fail: Number((1 - passProb).toFixed(4)) },
    confidence: Number(Math.abs(2 * passProb - 1).toFixed(4)),
  });

  // Code mode: same P(pass) = 0.72 passes 0.70 check and fails 0.80 check; 0.85 fails 0.90 check.
  const codeRubric = resolveRubrics({
    mode: 'code',
    rubrics: [mixedRubricPath],
    hasRequirements: false,
    hasConventions: false,
  });
  const codeOut = join(root, 'mixed-code');
  const codeResult = await runDecisionJudge(
    {
      mode: 'code',
      files: { 'a.ts': 'export const a = 1;\n' },
      rubric: codeRubric,
      model: 'liquid/d1.2-ultra',
      out: codeOut,
    },
    async (_url, init) => {
      const payload = JSON.parse(String(init?.body));
      for (const question of Object.values(payload.questions) as Array<Record<string, unknown>>) {
        assert.equal('pass_threshold' in question, false);
      }
      return Response.json({
        model: 'mock-code',
        answers: {
          lenient_check: makeAnswer(0.72),
          default_check: makeAnswer(0.72),
          strict_check: makeAnswer(0.85),
        },
      });
    },
  );
  assert.equal(codeResult.status, 'scored');
  assert.equal(codeResult.pass_threshold, 0.8);
  assert.deepEqual(codeResult.check_thresholds, { lenient_check: 0.7, strict_check: 0.9 });
  assert.equal(codeResult.quality!.checks.lenient_check.choice, 'pass');
  assert.equal(codeResult.quality!.checks.lenient_check.pass_threshold, 0.7);
  assert.equal(codeResult.quality!.checks.default_check.choice, 'fail');
  assert.equal('pass_threshold' in codeResult.quality!.checks.default_check, false);
  assert.equal(codeResult.quality!.checks.strict_check.choice, 'fail');
  assert.equal(codeResult.quality!.checks.strict_check.pass_threshold, 0.9);
  assert.ok(Math.abs(codeResult.quality!.pass_rate - (1 / 3)) < 1e-9);

  // File mode: per-file choices and aggregates honor each check's threshold.
  const fileRubric = resolveRubrics({
    mode: 'file',
    rubrics: [mixedRubricPath],
    hasRequirements: false,
    hasConventions: false,
  });
  const fileOut = join(root, 'mixed-file');
  const fileResult = await runDecisionJudge(
    {
      mode: 'file',
      files: {
        'a.ts': 'export const a = 1;\n',
        'b.ts': 'export const b = 2;\n',
      },
      rubric: fileRubric,
      model: 'typesafe/jev-1.14',
      concurrency: 2,
      out: fileOut,
    },
    async (_url, init) => {
      const payload = JSON.parse(String(init?.body));
      for (const question of Object.values(payload.questions) as Array<Record<string, unknown>>) {
        assert.equal('pass_threshold' in question, false);
      }
      const file = Object.keys(payload.state.production_files)[0];
      if (file === 'a.ts') {
        return Response.json({
          model: 'mock-file',
          answers: {
            lenient_check: makeAnswer(0.72), // >= 0.70 -> pass
            default_check: makeAnswer(0.72), // < 0.80 -> fail
            strict_check: makeAnswer(0.95), // >= 0.90 -> pass
          },
        });
      }
      return Response.json({
        model: 'mock-file',
        answers: {
          lenient_check: makeAnswer(0.7), // exact threshold -> pass
          default_check: makeAnswer(0.85), // >= 0.80 -> pass
          strict_check: makeAnswer(0.85), // < 0.90 -> fail
        },
      });
    },
  );
  assert.equal(fileResult.status, 'scored');
  assert.equal(fileResult.pass_threshold, 0.8);
  assert.deepEqual(fileResult.check_thresholds, { lenient_check: 0.7, strict_check: 0.9 });
  assert.equal(fileResult.quality!.checks.lenient_check.choice, 'pass');
  assert.equal(fileResult.quality!.checks.lenient_check.files_passed, 2);
  assert.equal(fileResult.quality!.checks.lenient_check.pass_threshold, 0.7);
  assert.equal(fileResult.quality!.checks.default_check.choice, 'fail');
  assert.equal(fileResult.quality!.checks.default_check.files_passed, 1);
  assert.equal('pass_threshold' in fileResult.quality!.checks.default_check, false);
  assert.equal(fileResult.quality!.checks.strict_check.choice, 'fail');
  assert.equal(fileResult.quality!.checks.strict_check.files_passed, 1);
  assert.equal(fileResult.quality!.checks.strict_check.pass_threshold, 0.9);
  assert.equal(fileResult.file_results![0].checks!.lenient_check.choice, 'pass');
  assert.equal(fileResult.file_results![0].checks!.lenient_check.pass_threshold, 0.7);
  assert.equal(fileResult.file_results![0].checks!.default_check.choice, 'fail');
  assert.equal(fileResult.file_results![1].checks!.lenient_check.choice, 'pass');
  assert.equal(fileResult.file_results![1].checks!.strict_check.choice, 'fail');
  assert.equal(fileResult.file_results![1].checks!.strict_check.pass_threshold, 0.9);

  // Structure mode: per-criterion threshold is also applied in structure scoring.
  const structRubricPath = join(project, 'mixed-struct.json');
  writeFileSync(structRubricPath, JSON.stringify({
    rubric: 'mixed-struct-v1',
    target: 'project_structure',
    questions: {
      struct_lenient: {
        type: 'choice',
        pass_threshold: 0.7,
        instructions: 'Struct lenient?',
        criteria: { pass: 'Yes', fail: 'No' },
      },
      struct_default: {
        type: 'choice',
        instructions: 'Struct default?',
        criteria: { pass: 'Yes', fail: 'No' },
      },
    },
  }));
  const structRubric = resolveRubrics({
    mode: 'structure',
    rubrics: [structRubricPath],
    hasRequirements: false,
    hasConventions: false,
  });
  const structInputs = readStructureInputs({
    source: join(project, 'booking'),
    out: join(root, 'mixed-struct'),
  });
  const structResult = await runDecisionJudge(
    {
      mode: 'structure',
      structure: structInputs.manifest,
      rubric: structRubric,
      model: 'liquid/d1.2-ultra',
      out: structInputs.out,
    },
    async () => Response.json({
      model: 'mock-struct',
      answers: {
        struct_lenient: makeAnswer(0.72),
        struct_default: makeAnswer(0.72),
      },
    }),
  );
  assert.equal(structResult.status, 'scored');
  assert.equal(structResult.mode, 'structure');
  assert.deepEqual(structResult.check_thresholds, { struct_lenient: 0.7 });
  assert.equal(structResult.quality!.checks.struct_lenient.choice, 'pass');
  assert.equal(structResult.quality!.checks.struct_lenient.pass_threshold, 0.7);
  assert.equal(structResult.quality!.checks.struct_default.choice, 'fail');

  // CLI backend ignores per-criterion probability thresholds and keeps pass/borderline/fail unchanged.
  const fakeBin = join(root, 'fake-bin-thresholds');
  mkdirSync(fakeBin, { recursive: true });
  const codexStub = join(fakeBin, 'codex');
  writeFileSync(codexStub, `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const outIdx = args.indexOf('-o');
const schemaIdx = args.indexOf('--output-schema');
const schema = JSON.parse(fs.readFileSync(args[schemaIdx + 1], 'utf8'));
const ids = schema.properties.checks.items.properties.id.enum;
fs.writeFileSync(args[outIdx + 1], JSON.stringify({
  checks: ids.map((id) => ({
    id,
    note: 'CLI check.',
    choice: id === 'lenient_check' ? 'borderline' : 'pass',
  })),
}));
`);
  chmodSync(codexStub, 0o755);
  const cliProc = run('preview', [
    '--source', 'booking',
    '--rubric', mixedRubricPath,
    '--backend', 'codex',
    '--out', join(root, 'mixed-codex'),
  ], { PATH: `${fakeBin}:${process.env.PATH ?? ''}` });
  assert.equal(cliProc.status, 0, cliProc.stderr);
  const cliRes = JSON.parse(cliProc.stdout);
  assert.equal(cliRes.pass_threshold, null);
  assert.equal('check_thresholds' in cliRes, false);
  assert.equal(cliRes.quality.checks.lenient_check.choice, 'fail');
  assert.equal(cliRes.quality.checks.lenient_check.model_choice, 'borderline');
  assert.equal('pass_threshold' in cliRes.quality.checks.lenient_check, false);
});

test('formatSummary displays per-criterion thresholds in code, file, and dry-run modes and guards rounding per check', async () => {
  const { formatSummary } = await import('../scripts/format.mts');

  // Code mode with mixed thresholds + sub-threshold rounding guard against custom 0.70 threshold.
  const codeSummary = formatSummary({
    status: 'scored',
    backend: 'openrouter',
    mode: 'code',
    file_count: 1,
    requested_model: 'liquid/d1.2-ultra',
    returned_model: 'liquid/d1.2-ultra',
    rubric: 'mixed-v1',
    rubric_groups: { mixed: ['lenient_pass', 'lenient_edge_fail', 'default_fail'] },
    pass_threshold: 0.8,
    check_thresholds: { lenient_pass: 0.7, lenient_edge_fail: 0.7 },
    quality: {
      pass_rate: 1 / 3,
      checks: {
        lenient_pass: {
          choice: 'pass',
          model_choice: 'pass',
          pass_probability: 0.7961,
          confidence: 0.59,
          pass_threshold: 0.7,
        },
        lenient_edge_fail: {
          choice: 'fail',
          model_choice: 'pass',
          pass_probability: 0.6961,
          confidence: 0.39,
          pass_threshold: 0.7,
        },
        default_fail: {
          choice: 'fail',
          model_choice: 'pass',
          pass_probability: 0.72,
          confidence: 0.44,
        },
      },
    },
  }, '/tmp/out');
  assert.match(codeSummary, /Findings: 2 across 1 file \(2 threshold borderline\) — 3 rules checked/);
  assert.match(codeSummary, /FAIL\s+lenient_edge_fail\s+threshold borderline \(raw PASS: P\(pass\)=0\.696 < 0\.70\)/);
  assert.match(codeSummary, /FAIL\s+default_fail\s+threshold borderline \(raw PASS: P\(pass\)=0\.72 < 0\.80\)/);
  assert.match(codeSummary, /Clean rules \(1\): lenient_pass \(P\(pass\)=0\.80, threshold 0\.70\)/);

  // File mode with mixed thresholds shows per-check thresholds in the table and failing-file detail.
  const fileSummary = formatSummary({
    status: 'scored',
    backend: 'openrouter',
    mode: 'file',
    file_count: 1,
    elapsed_ms: 100,
    requested_model: 'typesafe/jev-1.14',
    returned_model: 'typesafe/jev-1.14',
    rubric: 'mixed-v1',
    rubric_groups: { mixed: ['lenient_check', 'default_check', 'strict_check'] },
    pass_threshold: 0.8,
    check_thresholds: { lenient_check: 0.7, strict_check: 0.9 },
    quality: {
      pass_rate: 1 / 3,
      all_files_pass_rate: 1 / 3,
      checks: {
        lenient_check: {
          choice: 'pass',
          files_passed: 1,
          files_total: 1,
          pass_probability: 0.72,
          min_pass_probability: 0.72,
          confidence: 0.44,
          pass_threshold: 0.7,
        },
        default_check: {
          choice: 'fail',
          files_passed: 0,
          files_total: 1,
          pass_probability: 0.72,
          min_pass_probability: 0.72,
          confidence: 0.44,
        },
        strict_check: {
          choice: 'fail',
          files_passed: 0,
          files_total: 1,
          pass_probability: 0.8961,
          min_pass_probability: 0.8961,
          confidence: 0.79,
          pass_threshold: 0.9,
        },
      },
    },
    file_results: [
      {
        file: 'edge.ts',
        status: 'scored',
        returned_model: 'typesafe/jev-1.14',
        elapsed_ms: 100,
        pass_rate: 1 / 3,
        result_dir: 'files/01-edge.ts',
        checks: {
          lenient_check: { choice: 'pass', model_choice: 'pass', pass_probability: 0.72, confidence: 0.44, pass_threshold: 0.7 },
          default_check: { choice: 'fail', model_choice: 'pass', pass_probability: 0.72, confidence: 0.44 },
          strict_check: { choice: 'fail', model_choice: 'pass', pass_probability: 0.8961, confidence: 0.79, pass_threshold: 0.9 },
        },
      },
    ],
  }, '/tmp/out');
  assert.match(fileSummary, /Findings: 2 across 1 of 1 file \(2 threshold borderline\)/);
  assert.match(fileSummary, /FAIL\s+default_check\s+1\/1 file\s+\(1 threshold borderline; min P\(pass\)=0\.72; threshold 0\.80\)/);
  assert.match(fileSummary, /FAIL\s+strict_check\s+1\/1 file\s+\(1 threshold borderline; min P\(pass\)=0\.896; threshold 0\.90\)/);
  assert.match(fileSummary, /Clean rules \(1\): lenient_check \(min P\(pass\)=0\.72, threshold 0\.70\)/);
  assert.match(
    fileSummary,
    /edge\.ts \(2 findings\): default_check \[threshold borderline, raw PASS: P\(pass\)=0\.72 < 0\.80\], strict_check \[threshold borderline, raw PASS: P\(pass\)=0\.896 < 0\.90\]/,
  );

  // Dry-run summary highlights overridden check thresholds and leaves default checks plain.
  const drySummary = formatSummary({
    status: 'dry_run',
    backend: 'openrouter',
    mode: 'code',
    file_count: 2,
    requested_model: 'liquid/d1.2-ultra',
    returned_model: null,
    rubric: 'mixed-v1',
    rubric_groups: { mixed: ['lenient_check', 'default_check'] },
    pass_threshold: 0.8,
    check_thresholds: { lenient_check: 0.7 },
    quality: null,
  }, '/tmp/out');
  assert.match(drySummary, /Checks \(2\): lenient_check \(>=0\.70\), default_check/);

  // Without custom overrides, code summary omits threshold suffixes to stay concise.
  const defaultSummary = formatSummary({
    status: 'scored',
    backend: 'openrouter',
    mode: 'code',
    file_count: 1,
    requested_model: 'liquid/d1.2-ultra',
    returned_model: 'liquid/d1.2-ultra',
    rubric: 'readability-v2',
    rubric_groups: { readability: ['direct_readability'] },
    pass_threshold: 0.8,
    quality: {
      pass_rate: 1,
      checks: {
        direct_readability: { choice: 'pass', model_choice: 'pass', pass_probability: 0.91, confidence: 0.82 },
      },
    },
  }, '/tmp/out');
  assert.match(defaultSummary, /Findings: 0 across 1 file — 1 rule checked/);
  assert.match(defaultSummary, /Clean rules \(1\): direct_readability \(P\(pass\)=0\.91\)$|Clean rules \(1\): direct_readability \(P\(pass\)=0\.91\)\n/);
  assert.doesNotMatch(defaultSummary, /threshold/);
});

test('universal cross-language test/support classification is unified across file and structure modes without repo-specific hardcoding', async (t) => {
  const { run, root, project } = setup(t);
  const { isTestOrSupportPath } = await import('../scripts/inputs.mts');

  // Universal cross-language test/support directories and filenames
  for (const testPath of [
    'test/helper.ts',
    'tests/Fixture.kt',
    'testing/fakes.ts',
    'pkg/testing/ClockFake.kt',
    '__tests__/widget.tsx',
    '__mocks__/api.ts',
    '__fixtures__/payload.ts',
    'testFixtures/BookingBuilder.kt',
    'fixtures/seed.ts',
    'androidTest/MainScreenTest.kt',
    'booking.test.ts',
    'booking.spec.tsx',
    'client.mock.ts',
    'handler_test.go',
    'handler_test.ts',
    'service_spec.rb',
    'BookingTest.kt',
    'BookingTests.kt',
    'BookingSpec.kt',
    'BookingTest.ts',
    'conftest.py',
    'pkg/conftest.py',
    'test_booking.py',
  ]) {
    assert.equal(isTestOrSupportPath(testPath), true, `Expected ${testPath} to be classified as test/support`);
  }

  // Production filenames and repo-specific helper names must NOT be hardcoded as test/support
  for (const prodPath of [
    'Booking.kt',
    'latest.ts',
    'contest.ts',
    'manifest.ts',
    'SpecParser.ts',
    'TestRunner.kt',
    '.server/decisions.ts',
    '.client/widget.tsx',
    'booking-test-support.ts',
    'app/lib/repo-test-support.kt',
  ]) {
    assert.equal(isTestOrSupportPath(prodPath), false, `Expected ${prodPath} to be classified as production`);
  }

  // End-to-end parity between --mode file and --mode structure
  const multi = join(project, 'unified-roles');
  const sampleFiles: Record<string, string> = {
    'latest.ts': 'export const latest = 1;\n',
    'booking-test-support.ts': 'export const helper = true;\n',
    '.server/loader.ts': 'export const load = () => 1;\n',
    '.client/view.tsx': 'export const View = () => null;\n',
    'testing/fakes.ts': 'export const fake = 1;\n',
    'testFixtures/Builder.kt': 'package demo\nclass Builder\n',
    '__mocks__/db.ts': 'export const db = {};\n',
    'handler_test.ts': 'export const t = 1;\n',
    'BookingTest.ts': 'export const bt = 1;\n',
    'client.mock.ts': 'export const mockClient = {};\n',
  };
  for (const [rel, content] of Object.entries(sampleFiles)) {
    const full = join(multi, rel);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, content);
  }

  const fileOut = join(root, 'unified-file');
  const fileProc = run('preview', [
    '--source', 'unified-roles',
    '--mode', 'file',
    '--rubric', 'readability',
    '--out', fileOut,
    '--dry-run',
  ]);
  assert.equal(fileProc.status, 0, fileProc.stderr);
  const fileRes = JSON.parse(fileProc.stdout);
  assert.deepEqual(
    fileRes.file_results.map((entry: { file: string }) => entry.file),
    ['.client/view.tsx', '.server/loader.ts', 'booking-test-support.ts', 'latest.ts'].sort((a, b) => a.localeCompare(b)),
  );

  const structOut = join(root, 'unified-structure');
  const structProc = run('preview', [
    '--source', 'unified-roles',
    '--mode', 'structure',
    '--out', structOut,
    '--dry-run',
  ]);
  assert.equal(structProc.status, 0, structProc.stderr);
  const structReq = JSON.parse(readFileSync(join(structOut, 'request.json'), 'utf8'));
  const manifestFiles = structReq.state.project_structure.files as Record<string, { kind: string }>;
  assert.equal(manifestFiles['latest.ts'].kind, 'source');
  assert.equal(manifestFiles['booking-test-support.ts'].kind, 'source');
  assert.equal(manifestFiles['.server/loader.ts'].kind, 'source');
  assert.equal(manifestFiles['.client/view.tsx'].kind, 'source');
  assert.equal(manifestFiles['testing/fakes.ts'].kind, 'test');
  assert.equal(manifestFiles['testFixtures/Builder.kt'].kind, 'test');
  assert.equal(manifestFiles['__mocks__/db.ts'].kind, 'test');
  assert.equal(manifestFiles['handler_test.ts'].kind, 'test');
  assert.equal(manifestFiles['BookingTest.ts'].kind, 'test');
  assert.equal(manifestFiles['client.mock.ts'].kind, 'test');
});

test('repeatable --ignore globs filter files and directories across code, file, and structure modes while preserving .server/.client and --out guards', async (t) => {
  const { run, root, project } = setup(t);
  const { compileIgnoreMatcher } = await import('../scripts/inputs.mts');

  // Unit tests for compileIgnoreMatcher
  const matcher = compileIgnoreMatcher([
    '*-test-support.*',
    'legacy/**',
    '**/gen/**',
    '**/*.pb.{ts,kt}',
    'scratch/',
  ]);
  assert.equal(matcher.isIgnoredFile('booking-test-support.ts'), true);
  assert.equal(matcher.isIgnoredFile('app/lib/booking-test-support.kt'), true);
  assert.equal(matcher.isIgnoredFile('app/lib/booking.ts'), false);
  assert.equal(matcher.isIgnoredDir('legacy'), true);
  assert.equal(matcher.isIgnoredFile('legacy/old.ts'), true);
  assert.equal(matcher.isIgnoredFile('legacy/sub/older.ts'), true);
  assert.equal(matcher.isIgnoredDir('app/legacy'), false);
  assert.equal(matcher.isIgnoredDir('gen'), true);
  assert.equal(matcher.isIgnoredDir('a/b/gen'), true);
  assert.equal(matcher.isIgnoredFile('a/b/gen/foo.ts'), true);
  assert.equal(matcher.isIgnoredFile('api/v1/schema.pb.ts'), true);
  assert.equal(matcher.isIgnoredFile('schema.pb.kt'), true);
  assert.equal(matcher.isIgnoredFile('api/v1/schema.ts'), false);
  assert.equal(matcher.isIgnoredDir('scratch'), true);
  assert.equal(matcher.isIgnoredDir('nested/scratch'), true);
  assert.equal(matcher.isIgnoredFile('nested/scratch/tmp.ts'), true);
  assert.equal(matcher.isIgnoredFile('scratch'), false); // trailing slash is dir-only
  assert.throws(() => compileIgnoreMatcher(['   ']), /Invalid --ignore pattern/);
  assert.throws(() => compileIgnoreMatcher(['./']), /Invalid --ignore pattern/);

  // Create fixture tree with repo-specific helpers, generated dir, .server/.client, and oversized ignored file
  const repo = join(project, 'ignore-demo');
  const tree: Record<string, string> = {
    'core.ts': 'export const core = 1;\n',
    'booking-test-support.ts': 'export const testOnlyHelper = 1;\n',
    'api/schema.pb.ts': 'export const proto = 1;\n',
    'legacy/huge-ignored.ts': 'x'.repeat(140 * 1024), // >128 KiB, must not fail when ignored!
    '.server/decisions.ts': 'export const decide = () => true;\n',
    '.server/seed-test-support.ts': 'export const seed = () => {};\n',
    '.client/widget.tsx': 'export const Widget = () => null;\n',
    'notes/data.json': '{"ok":true}\n',
  };
  for (const [rel, content] of Object.entries(tree)) {
    const full = join(repo, rel);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, content);
  }

  // --help documents --ignore and exit codes
  const helpProc = run('preview', ['--help']);
  assert.equal(helpProc.status, 0, helpProc.stderr);
  assert.match(helpProc.stdout, /--ignore GLOB/);
  assert.match(helpProc.stdout, /Exit codes:/);

  // --mode file with repeatable --ignore + --exclude works cleanly and skips oversized ignored directory
  const fileOut = join(root, 'ignore-file');
  const fileProc = run('preview', [
    '--source', 'ignore-demo',
    '--mode', 'file',
    '--rubric', 'readability',
    '--exclude', 'named_domain_expressions',
    '--ignore', '*-test-support.*',
    '--ignore', 'legacy/**',
    '--ignore', '**/*.pb.ts',
    '--out', fileOut,
    '--dry-run',
  ]);
  assert.equal(fileProc.status, 0, fileProc.stderr);
  const fileRes = JSON.parse(fileProc.stdout);
  assert.deepEqual(fileRes.excluded_checks, ['named_domain_expressions']);
  assert.deepEqual(fileRes.ignored_patterns, ['*-test-support.*', 'legacy/**', '**/*.pb.ts']);
  assert.deepEqual(
    fileRes.file_results.map((entry: { file: string }) => entry.file),
    ['.client/widget.tsx', '.server/decisions.ts', 'core.ts'].sort((a, b) => a.localeCompare(b)),
  );

  // --mode code with --ignore and --format summary prints ignored patterns on dry-run
  const codeOut = join(root, 'ignore-code');
  const codeProc = run('preview', [
    '--source', 'ignore-demo',
    '--mode', 'code',
    '--rubric', 'readability',
    '--ignore', '*-test-support.*',
    '--ignore', 'legacy/**',
    '--ignore', '**/*.pb.ts',
    '--format', 'summary',
    '--out', codeOut,
    '--dry-run',
  ]);
  assert.equal(codeProc.status, 0, codeProc.stderr);
  assert.match(codeProc.stdout, /Ignored patterns \(3\): \*-test-support\.\*, legacy\/\*\*, \*\*\/\*\.pb\.ts/);
  const codeReq = JSON.parse(readFileSync(join(codeOut, 'request.json'), 'utf8'));
  assert.deepEqual(
    Object.keys(codeReq.state.production_files),
    ['.client/widget.tsx', '.server/decisions.ts', 'core.ts'].sort((a, b) => a.localeCompare(b)),
  );

  // --mode structure with --ignore omits ignored files and pruned directories from manifest and directory_summary
  const structOut = join(root, 'ignore-struct');
  const structProc = run('preview', [
    '--source', 'ignore-demo',
    '--mode', 'structure',
    '--ignore', '*-test-support.*',
    '--ignore', 'legacy/**',
    '--ignore', 'notes/**',
    '--out', structOut,
    '--dry-run',
  ]);
  assert.equal(structProc.status, 0, structProc.stderr);
  const structReq = JSON.parse(readFileSync(join(structOut, 'request.json'), 'utf8'));
  const manifest = structReq.state.project_structure;
  assert.equal('legacy' in manifest.directory_summary, false);
  assert.equal('notes' in manifest.directory_summary, false);
  assert.ok('.server' in manifest.directory_summary);
  assert.ok('.client' in manifest.directory_summary);
  assert.equal('booking-test-support.ts' in manifest.files, false);
  assert.equal('.server/seed-test-support.ts' in manifest.files, false);
  assert.ok('.server/decisions.ts' in manifest.files);
  assert.ok('.client/widget.tsx' in manifest.files);
  assert.ok('core.ts' in manifest.files);
  assert.equal('other_files' in manifest, false);

  // --out inside --source is still rejected even if --ignore matches the --out path
  const overlapProc = run('reject', [
    '--source', 'ignore-demo',
    '--mode', 'file',
    '--rubric', 'readability',
    '--ignore', 'out-inside/**',
    '--out', join(repo, 'out-inside'),
    '--dry-run',
  ]);
  assert.equal(overlapProc.status, 1);
  assert.match(overlapProc.stderr, /outside the selected source directory/);

  // Empty --ignore pattern is rejected with status 1
  const emptyIgnore = run('reject', [
    '--source', 'ignore-demo',
    '--rubric', 'readability',
    '--ignore', '   ',
    '--out', join(root, 'empty-ignore'),
    '--dry-run',
  ]);
  assert.equal(emptyIgnore.status, 1);
  assert.match(emptyIgnore.stderr, /Invalid --ignore pattern/);
});

test('scoring and transport errors exit with distinct non-zero status 2 across modes and formats', async (t) => {
  const { run, root } = setup(t);
  const { EXIT_OK, EXIT_SCORING_ERROR, EXIT_VIOLATION, exitCodeForResult } = await import('../scripts/judge-code.mts');

  assert.equal(EXIT_OK, 0);
  assert.equal(EXIT_VIOLATION, 1);
  assert.equal(EXIT_SCORING_ERROR, 2);

  // Unit tests for exitCodeForResult
  const baseResult = {
    status: 'scored' as const,
    backend: 'openrouter' as const,
    mode: 'code' as const,
    file_count: 1,
    requested_model: 'liquid/d1.2-ultra',
    returned_model: 'liquid/d1.2-ultra',
    rubric: 'readability-v2',
    rubric_groups: { readability: ['direct_readability'] },
    pass_threshold: 0.8,
    quality: {
      pass_rate: 0,
      checks: {
        direct_readability: { choice: 'fail' as const, model_choice: 'pass' as const, pass_probability: 0.72, confidence: 0.44 },
      },
    },
  };
  assert.equal(exitCodeForResult(baseResult, false), 0);
  assert.equal(exitCodeForResult(baseResult, true), 1);
  assert.equal(exitCodeForResult({ ...baseResult, status: 'error', quality: null, error: 'HTTP 400' }, false), 2);
  assert.equal(exitCodeForResult({ ...baseResult, status: 'error', quality: null, error: 'HTTP 400' }, true), 2);
  assert.equal(
    exitCodeForResult({
      ...baseResult,
      mode: 'file',
      file_results: [
        { file: 'a.ts', status: 'error', returned_model: null, elapsed_ms: 10, pass_rate: null, checks: null, result_dir: 'files/01-a.ts', error: 'HTTP 400' },
      ],
    }, false),
    2,
  );

  // OpenRouter HTTP 400 (Unknown model) in --mode file --format summary exits 2 and surfaces the model error
  const file400Out = join(root, 'file-http-400');
  const file400Proc = run('http-400', [
    '--source', 'booking',
    '--mode', 'file',
    '--rubric', 'readability',
    '--model', 'typesafe/jev-1.14.0',
    '--format', 'summary',
    '--out', file400Out,
  ]);
  assert.equal(file400Proc.status, 2, file400Proc.stderr);
  assert.match(file400Proc.stdout, /ERROR:.*HTTP 400: Unknown model: typesafe\/jev-1\.14\.0/);
  assert.match(file400Proc.stdout, /Files: 0 scored, 4 errored \(4 total\)/);
  const file400Saved = JSON.parse(readFileSync(join(file400Out, 'result.json'), 'utf8'));
  assert.equal(file400Saved.status, 'error');

  // Partial file error (3 scored, 1 errored) exits 2 even without --fail-on-violation
  const partialOut = join(root, 'file-partial-400');
  const partialProc = run('partial-400', [
    '--source', 'booking',
    '--mode', 'file',
    '--rubric', 'readability',
    '--format', 'summary',
    '--out', partialOut,
  ]);
  assert.equal(partialProc.status, 2, partialProc.stderr);
  assert.match(partialProc.stdout, /Files: 3 scored, 1 errored \(4 total\)/);
  assert.match(partialProc.stdout, /ERR\s+Room\.kt: OpenRouter returned HTTP 400: Invalid request for file/);

  // OpenRouter HTTP 400 in --mode code --format json exits 2
  const code400Out = join(root, 'code-http-400');
  const code400Proc = run('http-400', [
    '--source', 'booking',
    '--mode', 'code',
    '--rubric', 'readability',
    '--out', code400Out,
  ]);
  assert.equal(code400Proc.status, 2, code400Proc.stderr);
  const code400Res = JSON.parse(code400Proc.stdout);
  assert.equal(code400Res.status, 'error');
  assert.match(code400Res.error, /HTTP 400: Unknown model: typesafe\/jev-1\.14\.0/);

  // CLI backend failure exits 2
  const fakeBin = join(root, 'failing-cli-bin');
  mkdirSync(fakeBin, { recursive: true });
  const failingCodex = join(fakeBin, 'codex');
  writeFileSync(failingCodex, '#!/usr/bin/env node\nconsole.error("auth expired");\nprocess.exit(1);\n');
  chmodSync(failingCodex, 0o755);
  const cliErrProc = run('preview', [
    '--source', 'booking',
    '--rubric', 'readability',
    '--backend', 'codex',
    '--out', join(root, 'cli-err-out'),
  ], { PATH: `${fakeBin}:${process.env.PATH ?? ''}` });
  assert.equal(cliErrProc.status, 2, cliErrProc.stderr);
  assert.equal(JSON.parse(cliErrProc.stdout).status, 'error');
});

test('formatSummary renders linter-style punch-list leading with findings, worst-first rules, and top hotspot files without pass-rate percentages', async () => {
  const { formatSummary } = await import('../scripts/format.mts');

  // Code mode with one PASS, one raw FAIL, and one threshold-flipped borderline (raw PASS with P(pass)=0.72 < 0.80)
  const codeSummary = formatSummary({
    status: 'scored',
    backend: 'openrouter',
    mode: 'code',
    file_count: 3,
    requested_model: 'liquid/d1.2-ultra',
    returned_model: 'liquid/d1.2-ultra',
    rubric: 'readability-v2+module-design-v2',
    rubric_groups: {
      readability: ['direct_readability'],
      'module-design': ['modular_organization', 'no_unnecessary_abstraction'],
    },
    pass_threshold: 0.8,
    quality: {
      pass_rate: 1 / 3,
      checks: {
        direct_readability: { choice: 'pass', model_choice: 'pass', pass_probability: 0.94, confidence: 0.88 },
        no_unnecessary_abstraction: { choice: 'fail', model_choice: 'pass', pass_probability: 0.72, confidence: 0.44 },
        modular_organization: { choice: 'fail', model_choice: 'fail', pass_probability: 0.18, confidence: 0.64 },
      },
    },
  }, '/tmp/out');
  assert.doesNotMatch(codeSummary, /%/);
  assert.match(codeSummary, /Findings: 2 across 3 files \(1 raw FAIL, 1 threshold borderline\) — 3 rules checked/);
  assert.match(codeSummary, /Findings by rule \(2 of 3 rules\):/);
  assert.match(codeSummary, /FAIL\s+modular_organization\s+raw FAIL \(P\(pass\)=0\.18 < 0\.80\)/);
  assert.match(codeSummary, /FAIL\s+no_unnecessary_abstraction\s+threshold borderline \(raw PASS: P\(pass\)=0\.72 < 0\.80\)/);
  assert.match(codeSummary, /Clean rules \(1\): direct_readability \(P\(pass\)=0\.94\)/);
  // Raw FAIL must sort ahead of threshold borderline
  assert.ok(
    codeSummary.indexOf('modular_organization') < codeSummary.indexOf('no_unnecessary_abstraction'),
    'raw FAIL rule should sort before threshold borderline rule',
  );

  // CLI backend distinguishes raw FAIL from borderline
  const cliSummary = formatSummary({
    status: 'scored',
    backend: 'codex',
    mode: 'code',
    file_count: 2,
    requested_model: 'gpt-6-luna',
    returned_model: 'gpt-6-luna',
    rubric: 'readability-v2',
    rubric_groups: { readability: ['direct_readability', 'named_domain_expressions'] },
    pass_threshold: null,
    quality: {
      pass_rate: 0,
      checks: {
        named_domain_expressions: { choice: 'fail', model_choice: 'borderline', pass_probability: null, confidence: null, note: 'Mixed clarity.' },
        direct_readability: { choice: 'fail', model_choice: 'fail', pass_probability: null, confidence: null, note: 'Opaque names.' },
      },
    },
  }, '/tmp/out');
  assert.doesNotMatch(cliSummary, /%/);
  assert.match(cliSummary, /Findings: 2 across 2 files \(1 raw FAIL, 1 borderline\) — 2 rules checked/);
  assert.match(cliSummary, /FAIL\s+direct_readability\s+raw FAIL — Opaque names\./);
  assert.match(cliSummary, /FAIL\s+named_domain_expressions\s+borderline — Mixed clarity\./);

  // File mode leads with findings count & split, worst-first rules, and worst-first hotspot files (no % scoreboard)
  const fileSummary = formatSummary({
    status: 'scored',
    backend: 'openrouter',
    mode: 'file',
    file_count: 3,
    elapsed_ms: 300,
    requested_model: 'typesafe/jev-1.14',
    returned_model: 'typesafe/jev-1.14',
    rubric: 'readability-v2',
    rubric_groups: { readability: ['direct_readability', 'named_domain_expressions', 'no_long_functions'] },
    pass_threshold: 0.8,
    quality: {
      pass_rate: 6 / 9,
      all_files_pass_rate: 1 / 3,
      checks: {
        named_domain_expressions: {
          choice: 'pass',
          files_passed: 3,
          files_total: 3,
          pass_probability: 0.93,
          min_pass_probability: 0.9,
          confidence: 0.86,
        },
        no_long_functions: {
          choice: 'fail',
          files_passed: 2,
          files_total: 3,
          files_threshold_failed: 1,
          pass_probability: 0.84,
          min_pass_probability: 0.72,
          confidence: 0.68,
        },
        direct_readability: {
          choice: 'fail',
          files_passed: 1,
          files_total: 3,
          files_raw_failed: 1,
          files_threshold_failed: 1,
          pass_probability: 0.61,
          min_pass_probability: 0.2,
          confidence: 0.5,
        },
      },
    },
    file_results: [
      {
        file: 'clean.ts',
        status: 'scored',
        returned_model: 'typesafe/jev-1.14',
        elapsed_ms: 100,
        pass_rate: 1,
        result_dir: 'files/01-clean.ts',
        checks: {
          direct_readability: { choice: 'pass', model_choice: 'pass', pass_probability: 0.91, confidence: 0.82 },
          named_domain_expressions: { choice: 'pass', model_choice: 'pass', pass_probability: 0.95, confidence: 0.9 },
          no_long_functions: { choice: 'pass', model_choice: 'pass', pass_probability: 0.92, confidence: 0.84 },
        },
      },
      {
        file: 'threshold-only.ts',
        status: 'scored',
        returned_model: 'typesafe/jev-1.14',
        elapsed_ms: 100,
        pass_rate: 2 / 3,
        result_dir: 'files/02-threshold-only.ts',
        checks: {
          direct_readability: { choice: 'fail', model_choice: 'pass', pass_probability: 0.72, confidence: 0.44 },
          named_domain_expressions: { choice: 'pass', model_choice: 'pass', pass_probability: 0.94, confidence: 0.88 },
          no_long_functions: { choice: 'pass', model_choice: 'pass', pass_probability: 0.88, confidence: 0.76 },
        },
      },
      {
        file: 'worst-hotspot.ts',
        status: 'scored',
        returned_model: 'typesafe/jev-1.14',
        elapsed_ms: 100,
        pass_rate: 1 / 3,
        result_dir: 'files/03-worst-hotspot.ts',
        checks: {
          direct_readability: { choice: 'fail', model_choice: 'fail', pass_probability: 0.2, confidence: 0.6 },
          named_domain_expressions: { choice: 'pass', model_choice: 'pass', pass_probability: 0.9, confidence: 0.8 },
          no_long_functions: { choice: 'fail', model_choice: 'pass', pass_probability: 0.72, confidence: 0.44 },
        },
      },
    ],
  }, '/tmp/out');
  assert.doesNotMatch(fileSummary, /%/);
  assert.match(fileSummary, /Findings: 3 across 2 of 3 files \(1 raw FAIL, 2 threshold borderline\)/);
  assert.match(fileSummary, /Findings by rule \(2 of 3 rules\):/);
  assert.match(fileSummary, /FAIL\s+direct_readability\s+2\/3 files\s+\(1 raw FAIL, 1 threshold borderline; min P\(pass\)=0\.20; threshold 0\.80\)/);
  assert.match(fileSummary, /FAIL\s+no_long_functions\s+1\/3 files\s+\(1 threshold borderline; min P\(pass\)=0\.72; threshold 0\.80\)/);
  assert.match(fileSummary, /Clean rules \(1\): named_domain_expressions/);
  assert.ok(
    fileSummary.indexOf('FAIL  direct_readability') < fileSummary.indexOf('FAIL  no_long_functions'),
    'rules with more findings must sort first',
  );
  assert.match(fileSummary, /Hotspot files \(2 of 3 files\):/);
  assert.match(
    fileSummary,
    /worst-hotspot\.ts \(2 findings\): direct_readability \[raw FAIL: P\(pass\)=0\.20 < 0\.80\], no_long_functions \[threshold borderline, raw PASS: P\(pass\)=0\.72 < 0\.80\]/,
  );
  assert.match(
    fileSummary,
    /threshold-only\.ts \(1 finding\): direct_readability \[threshold borderline, raw PASS: P\(pass\)=0\.72 < 0\.80\]/,
  );
  assert.ok(
    fileSummary.indexOf('worst-hotspot.ts') < fileSummary.indexOf('threshold-only.ts'),
    'worst hotspot file must sort first',
  );

  // Large scans cap displayed hotspot files at top 20 and note remaining count
  const manyFiles = Array.from({ length: 23 }, (_, idx) => ({
    file: `src/file-${String(idx + 1).padStart(2, '0')}.ts`,
    status: 'scored' as const,
    returned_model: 'typesafe/jev-1.14',
    elapsed_ms: 10,
    pass_rate: 0,
    result_dir: `files/${idx + 1}`,
    checks: {
      direct_readability: { choice: 'fail' as const, model_choice: 'fail' as const, pass_probability: 0.1 + idx * 0.01, confidence: 0.6 },
    },
  }));
  const largeSummary = formatSummary({
    status: 'scored',
    backend: 'openrouter',
    mode: 'file',
    file_count: 23,
    elapsed_ms: 500,
    requested_model: 'typesafe/jev-1.14',
    returned_model: 'typesafe/jev-1.14',
    rubric: 'readability-v2',
    rubric_groups: { readability: ['direct_readability'] },
    pass_threshold: 0.8,
    quality: {
      pass_rate: 0,
      all_files_pass_rate: 0,
      checks: {
        direct_readability: {
          choice: 'fail',
          files_passed: 0,
          files_total: 23,
          files_raw_failed: 23,
          pass_probability: 0.2,
          min_pass_probability: 0.1,
          confidence: 0.6,
        },
      },
    },
    file_results: manyFiles,
  }, '/tmp/out');
  assert.match(largeSummary, /Top 20 hotspot files \(23 of 23 files with findings\):/);
  assert.match(largeSummary, /\.\.\. and 3 more files with findings \(see result\.json\)/);
});
