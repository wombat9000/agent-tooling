import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';

const SKILL = fileURLToPath(new URL('../../../skills/judge-code', import.meta.url));
const MOCK = `
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
const mode = process.env.JUDGE_TEST_MODE;
const out = process.argv[process.argv.indexOf('--out') + 1];
let calls = 0;
globalThis.fetch = async (endpoint, init) => {
  const call = ++calls;
  assert.ok(call <= 2);
  assert.equal(init.redirect, 'error');
  assert.equal(init.headers.Authorization, 'Bearer fixture-api-key');
  const json = JSON.parse(init.body);
  if (call === 1) {
    assert.equal(endpoint, 'https://openrouter.ai/api/alpha/decisions');
    assert.equal(init.body, readFileSync(join(out, 'request.json'), 'utf8'));
    assert.equal(json.model, 'liquid/d1.2-ultra');
    assert.deepEqual(Object.keys(json.state.production_files), ['Booking.kt', 'Room.kt']);
    const answers = Object.fromEntries(Object.keys(json.questions).map((id) => {
      const fail = ['direct_readability', 'modular_organization'].includes(id) && mode !== 'pass';
      return [id, {
        type: 'choice', choice: fail ? 'fail' : 'pass',
        probabilities: { pass: fail ? 0.2 : 0.9, fail: fail ? 0.8 : 0.1 },
        confidence: 0.8,
      }];
    }));
    return Response.json({ model: 'decisions-mock', answers });
  }
  assert.equal(endpoint, 'https://openrouter.ai/api/v1/chat/completions');
  assert.equal(init.body, readFileSync(join(out, 'evidence-request.json'), 'utf8'));
  const { failed_checks, production_files } = JSON.parse(json.messages[1].content);
  assert.deepEqual(Object.keys(failed_checks), ['direct_readability', 'modular_organization']);
  assert.equal(production_files['Booking.kt'].split('\\n')[1], '2: class Booking(val room: Room)');
  if (mode === 'error') return new Response('echo fixture-api-key', { status: 429 });
  return Response.json({
    model: 'evidence-mock',
    choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ checks: [
      { id: 'direct_readability', locations: [{ file: 'Booking.kt', start_line: 2, end_line: 2 }], reason: 'Mock reason' },
      { id: 'modular_organization', locations: [{ file: 'Room.kt', start_line: 500, end_line: 501 }], reason: 'Invalid range' },
    ] }) } }],
  });
};
process.on('exit', () => {
  assert.equal(calls, ['preview', 'reject'].includes(mode) ? 0 : ['pass', 'skip'].includes(mode) ? 1 : 2);
});
`;

function setup(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'installed-judge-code-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const installed = join(root, 'installed');
  const project = join(root, 'project');
  const source = join(project, 'booking');
  cpSync(SKILL, installed, { recursive: true });
  mkdirSync(source, { recursive: true });
  const fixtures = {
    'Booking.kt': 'package booking\nclass Booking(val room: Room)\n',
    'Room.kt': 'package booking\nclass Room\n',
    'tests/Fixture.kt': 'excluded',
    '.hidden/Hidden.kt': 'excluded',
    'dist/output.ts': 'excluded',
    'BookingTest.kt': 'excluded',
    'env.ts': 'excluded',
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
  const mock = join(root, 'mock.mjs');
  writeFileSync(mock, MOCK);
  function run(mode: string, out: string, overrides: string[] = []) {
    const env = { ...process.env, JUDGE_TEST_MODE: mode };
    delete env.OPENROUTER_API_KEY;
    if (!['preview', 'reject'].includes(mode)) env.OPENROUTER_API_KEY = 'fixture-api-key';
    return spawnSync(process.execPath, ['--import', mock, join(installed, 'scripts/judge-code.mts'),
      '--source', 'booking', '--requirements', 'requirements.md',
      '--rubric', 'readability-v2', '--rubric', 'module-design-v2', '--out', out, ...overrides],
    { cwd: project, env, encoding: 'utf8' });
  }
  return { source, root, project, run };
}

test('installed judge previews a whole module with the exact versioned criteria and no network', (t) => {
  const { run, root } = setup(t);
  const out = join(root, 'preview');
  const proc = run('preview', out, ['--dry-run']);
  assert.equal(proc.status, 0, proc.stderr);
  const result = JSON.parse(proc.stdout);
  const requestPath = join(out, 'request.json');
  const request = JSON.parse(readFileSync(requestPath, 'utf8'));
  assert.equal(result.status, 'dry_run');
  assert.equal(result.rubric, 'readability-v2+module-design-v2');
  assert.equal(result.quality, null);
  assert.equal(request.state.requirement, 'Book a room.\n');
  assert.equal(request.state.scope, 'whole');
  assert.deepEqual(Object.keys(request.state.production_files), ['Booking.kt', 'Room.kt']);
  assert.ok(request.questions.direct_readability.criteria.fail);
  assert.equal(existsSync(join(out, 'response.txt')), false);
  if (process.platform !== 'win32') {
    assert.equal(statSync(out).mode & 0o077, 0);
    assert.equal(statSync(requestPath).mode & 0o077, 0);
  }
});

test('evidence is optional, grounded in saved locations, and independent of Decisions scores', (t) => {
  const { source, run, root } = setup(t);
  const before = readFileSync(join(source, 'Booking.kt'), 'utf8');
  for (const mode of ['evidence', 'error', 'pass', 'skip']) {
    const out = join(root, mode);
    const proc = run(mode, out, mode === 'skip' ? ['--no-evidence'] : []);
    assert.equal(proc.status, 0, proc.stderr);
    const result = JSON.parse(proc.stdout);
    assert.deepEqual(result, JSON.parse(readFileSync(join(out, 'result.json'), 'utf8')));
    assert.equal(result.status, 'scored');
    assert.deepEqual(result.quality.checks.direct_readability, mode === 'pass'
      ? { choice: 'pass', pass_probability: 0.9, confidence: 0.8 }
      : { choice: 'fail', pass_probability: 0.2, confidence: 0.8 });
    const evidencePath = join(out, 'evidence.json');
    if (mode === 'pass' || mode === 'skip') {
      assert.equal(existsSync(evidencePath), false);
      continue;
    }
    const evidence = JSON.parse(readFileSync(evidencePath, 'utf8'));
    assert.equal(evidence.checks.modular_organization.status, 'unavailable');
    assert.deepEqual(evidence.checks.direct_readability, mode === 'error' ? { status: 'unavailable' } : {
      status: 'model_suggested',
      locations: [{ file: 'Booking.kt', start_line: 2, end_line: 2 }],
      reason: 'Mock reason',
    });
    assert.ok(!readFileSync(join(out, 'evidence-response.txt'), 'utf8').includes('fixture-api-key'));
  }
  assert.equal(readFileSync(join(source, 'Booking.kt'), 'utf8'), before);
});

test('standalone CLI rejects unsupported input, mismatched versions, credentials, and output overlap before writing', (t) => {
  const { source, run, root, project } = setup(t);
  const out = join(root, 'reject');
  const requirementsLink = join(project, 'link.md');
  symlinkSync(join(project, 'requirements.md'), requirementsLink);
  const alias = join(project, 'alias');
  symlinkSync(source, alias);
  for (const [overrides, error] of [
    [['--rubric', 'solid-v999'], /version unavailable/],
    [['--source', 'booking/BookingTest.kt'], /No supported production/],
    [['--source', 'booking/Link.kt'], /regular source file or directory/],
    [['--requirements', requirementsLink], /regular Markdown or text/],
    [['--out', join(alias, 'nested', 'scores')], /outside the selected source directory/],
  ] as const) {
    const proc = run('reject', out, [...overrides, '--dry-run']);
    assert.equal(proc.status, 1, proc.stderr);
    assert.match(proc.stderr, error);
    assert.equal(existsSync(out), false);
    assert.equal(existsSync(join(source, 'nested')), false);
  }
  const literal = 'private-value-for-test';
  writeFileSync(join(source, 'Unexpected.kt'), `const val apiKey = "${literal}"\n`);
  const proc = run('reject', out, ['--dry-run']);
  assert.equal(proc.status, 1, proc.stderr);
  assert.match(proc.stderr, /Possible credential/);
  assert.ok(!proc.stderr.includes(literal));
  assert.equal(existsSync(out), false);
});
