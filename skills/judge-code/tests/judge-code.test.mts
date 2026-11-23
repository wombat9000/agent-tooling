import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync,
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
let calls = 0;

globalThis.fetch = async (endpoint, init) => {
  calls += 1;
  assert.equal(calls, 1);
  assert.equal(endpoint, 'https://openrouter.ai/api/alpha/decisions');
  assert.equal(init.redirect, 'error');
  assert.equal(init.headers.Authorization, 'Bearer fixture-api-key');
  assert.equal(init.body, readFileSync(join(out, 'request.json'), 'utf8'));

  if (mode === 'http-error') return new Response('rate limit', { status: 429 });
  if (mode === 'key-echo') return new Response('echo fixture-api-key', { status: 500 });

  const json = JSON.parse(init.body);
  const answers = Object.fromEntries(Object.keys(json.questions).map((id) => {
    const fail = ['direct_readability', 'modular_organization'].includes(id) && mode !== 'pass';
    return [id, {
      type: 'choice',
      choice: fail ? 'fail' : 'pass',
      probabilities: { pass: fail ? 0.2 : 0.9, fail: fail ? 0.8 : 0.1 },
      confidence: 0.8,
    }];
  }));
  return Response.json({ model: 'decisions-mock', answers });
};

process.on('exit', () => {
  const expected = ['preview', 'reject'].includes(mode) ? 0 : 1;
  assert.equal(calls, expected);
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

test('list-rubrics prints bundled slugs, versioned IDs, and check IDs', (t) => {
  const { run } = setup(t);
  const proc = run('preview', ['--list-rubrics']);
  assert.equal(proc.status, 0, proc.stderr);
  assert.match(proc.stdout, /domain-modelling \(domain-modelling-v3\): immutable_state/);
  assert.match(proc.stdout, /module-design \(module-design-v2\): modular_organization/);
  assert.match(proc.stdout, /solid \(solid-v3\): single_responsibility/);
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
  assert.equal(result.quality.checks.direct_readability.choice, 'fail');
  assert.equal(result.quality.checks.named_domain_expressions.choice, 'pass');
  assert.equal(existsSync(join(scoredOut, 'evidence.json')), false);

  const errOut = join(root, 'key-echo');
  const errProc = run('key-echo', [
    '--source', 'booking',
    '--rubric', 'readability',
    '--out', errOut,
  ]);
  assert.equal(errProc.status, 1);
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
