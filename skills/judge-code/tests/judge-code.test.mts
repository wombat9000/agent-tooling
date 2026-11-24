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
    const borderline = id === 'no_unnecessary_abstraction' && mode !== 'pass';
    const passProb = fail ? 0.2 : borderline ? 0.65 : 0.9;
    return [id, {
      type: 'choice',
      choice: fail ? 'fail' : 'pass',
      probabilities: { pass: passProb, fail: Number((1 - passProb).toFixed(4)) },
      confidence: Number(Math.abs(2 * passProb - 1).toFixed(4)),
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

  // --mode structure defaults to project-structure rubric
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
  assert.equal(result.rubric, 'project-structure-v1');
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

  // --list-rubrics tags project-structure as [structure]
  const listed = run('preview', ['--list-rubrics']);
  assert.equal(listed.status, 0, listed.stderr);
  assert.match(listed.stdout, /project-structure \(project-structure-v1\) \[structure\]: no_junk_drawer_directories/);
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
