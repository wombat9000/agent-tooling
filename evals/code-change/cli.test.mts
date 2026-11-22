import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const CLI = join(ROOT, 'evals/code-change/cli.mts');

/** Substitute only Harbor; no test can start Docker, an agent, or a paid model call. */
function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'code-change-cli-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bin = join(root, 'bin');
  mkdirSync(bin);
  const record = join(root, 'harbor.jsonl');
  const auth = join(root, 'auth.json');
  writeFileSync(auth, '{}');
  const harbor = join(bin, 'harbor');
  writeFileSync(harbor, `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.TEST_HARBOR_RECORD, JSON.stringify({
  args, cwd: process.cwd(), auth: process.env.CODEX_AUTH_JSON_PATH ?? null,
  forceAuth: process.env.CODEX_FORCE_AUTH_JSON ?? null,
  openrouterPresent: Boolean(process.env.OPENROUTER_API_KEY),
}) + '\\n');
const agent = args[args.indexOf('-a') + 1];
if (agent === 'oracle' || agent === 'nop') {
  const job = path.join(args[args.indexOf('-o') + 1], args[args.indexOf('--job-name') + 1]);
  fs.mkdirSync(job, { recursive: true });
  const trials = process.env.TEST_SMOKE_TRIALS ? Number(process.env.TEST_SMOKE_TRIALS) : 3;
  const reward = process.env.TEST_SMOKE_REWARD ? Number(process.env.TEST_SMOKE_REWARD) : agent === 'oracle' ? 1 : 0;
  fs.writeFileSync(path.join(job, 'result.json'), JSON.stringify({ n_total_trials: trials,
    stats: { n_completed_trials: trials, n_errored_trials: 0, evals: { test: { metrics: [{ reward }] } } } }));
}
process.exit(Number(process.env.TEST_HARBOR_EXIT ?? 0));
`);
  chmodSync(harbor, 0o755);
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, EVAL_MODEL: '',
    CODEX_AUTH_JSON_PATH: auth, TEST_HARBOR_RECORD: record, OPENROUTER_API_KEY: 'fake-judge-key' };
  return {
    root, record, auth,
    run(args: string[], extra: NodeJS.ProcessEnv = {}) {
      const child = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: { ...env, ...extra } });
      assert.ifError(child.error);
      return child;
    },
    calls(): Array<{ args: string[]; cwd: string; auth: string | null; forceAuth: string | null; openrouterPresent: boolean }> {
      return existsSync(record) ? readFileSync(record, 'utf8').trim().split('\n').map((line) => JSON.parse(line)) : [];
    },
  };
}

test('canary uses Terra Fast/high, local login, skill loading, report export, and one trial', (t) => {
  const f = fixture(t);
  const child = f.run(['canary']);
  assert.equal(child.status, 0, child.stderr);
  const [call] = f.calls();
  assert.equal(call.auth, f.auth);
  assert.equal(call.openrouterPresent, false);
  assert.equal(call.cwd, ROOT.replace(/\/$/, ''));
  assert.equal(call.args[call.args.indexOf('-m') + 1], 'openai/gpt-6.1-terra');
  assert.ok(call.args.includes('reasoning_effort=high'));
  assert.ok(call.args.includes('config={"service_tier":"priority"}'));
  assert.equal(call.args[call.args.indexOf('-k') + 1], '1');
  assert.equal(call.args[call.args.indexOf('-n') + 1], '1');
  assert.ok(call.args.includes(join(ROOT, 'skills/code-change')));
  assert.ok(call.args.includes('/output/REVIEW.md'));
  assert.ok(call.args.includes(join(ROOT, 'evals/code-change/tasks/canary')));
});

test('full run defaults and baseline overrides produce the intended Harbor arguments', (t) => {
  const f = fixture(t);
  assert.equal(f.run(['run']).status, 0);
  const defaults = f.calls()[0].args;
  assert.equal(defaults[defaults.indexOf('-k') + 1], '5');
  assert.equal(defaults[defaults.indexOf('-n') + 1], '4');
  assert.ok(defaults.includes('reasoning_effort=high'));
  assert.ok(defaults.includes('config={"service_tier":"priority"}'));
  const child = f.run(['run', '--baseline', '--task', 'review-clean-change', '--model', 'openai/example',
    '--attempts', '2', '--concurrency', '1', '--auth', 'api', '--effort', 'medium', '--service-tier', 'default'], {
    OPENAI_API_KEY: 'fake-agent-key', CODEX_FORCE_AUTH_JSON: '1',
  });
  assert.equal(child.status, 0, child.stderr);
  const overridden = f.calls()[1];
  assert.equal(overridden.auth, null);
  assert.equal(overridden.forceAuth, null);
  assert.ok(!overridden.args.includes('--skill'));
  assert.equal(overridden.args[overridden.args.indexOf('-m') + 1], 'openai/example');
  assert.ok(overridden.args.includes('reasoning_effort=medium'));
  assert.ok(overridden.args.includes('config={"service_tier":"default"}'));
  assert.equal(overridden.args[overridden.args.indexOf('-k') + 1], '2');
  assert.equal(overridden.args[overridden.args.indexOf('-n') + 1], '1');
  assert.ok(overridden.args.includes(join(ROOT, 'evals/code-change/tasks/review-clean-change')));
});

test('dry runs preview commands without starting Harbor, and EVAL_MODEL can set the model', (t) => {
  const f = fixture(t);
  const child = f.run(['canary', '--dry-run'], { EVAL_MODEL: 'openai/from-env', CODEX_AUTH_JSON_PATH: '/missing/auth.json' });
  assert.equal(child.status, 0, child.stderr);
  const command = JSON.parse(child.stdout);
  assert.ok(command.args.includes('openai/from-env'));
  assert.ok(!child.stdout.includes('fake-judge-key'));
  assert.equal(f.calls().length, 0);
  const check = f.run(['check', '--dry-run']);
  assert.equal(check.status, 0);
  assert.ok(JSON.parse(check.stdout).args.includes('evals/code-change/cli.test.mts'));
});

test('smoke checks launch both agents and reject a wrong reward even if Harbor exits zero', (t) => {
  const f = fixture(t);
  const child = f.run(['smoke']);
  assert.equal(child.status, 0, child.stderr);
  const calls = f.calls();
  assert.equal(calls.length, 2);
  assert.equal(calls[0].args[calls[0].args.indexOf('-a') + 1], 'oracle');
  assert.equal(calls[1].args[calls[1].args.indexOf('-a') + 1], 'nop');
  t.after(() => {
    for (const call of f.calls()) {
      const path = join(ROOT, 'eval-results/harbor', call.args[call.args.indexOf('--job-name') + 1]);
      rmSync(path, { recursive: true, force: true });
    }
  });
  const wrong = f.run(['smoke'], { TEST_SMOKE_REWARD: '0' });
  assert.equal(wrong.status, 1);
  assert.match(wrong.stderr, /expected reward 1/);
});

test('invalid commands, tasks, counts, and auth fail before launching Harbor', (t) => {
  const f = fixture(t);
  for (const args of [[], ['wat'], ['run', '--task', '../canary'], ['run', '--attempts', '0'],
    ['run', '--concurrency', '1.5'], ['canary', '--effort', 'unknown'], ['canary', '--service-tier', ''],
    ['canary', '--auth', 'unknown'], ['canary', '--unknown'],
    ['canary', '--auth', 'api'], ['judge', 'canary', '/missing/REVIEW.md'],
    ['judge', 'canary', ''], ['judge', '--run', '']]) {
    const child = f.run(args, { OPENAI_API_KEY: '', CODEX_API_KEY: '' });
    assert.equal(child.status, args.length ? 1 : 0, JSON.stringify(args));
  }
  const noLogin = f.run(['canary'], { CODEX_AUTH_JSON_PATH: join(f.root, 'missing.json') });
  assert.equal(noLogin.status, 1);
  assert.match(noLogin.stderr, /Local Codex auth file is missing/);
  assert.equal(f.calls().length, 0);
});

test('Harbor exit codes reach the terminal unchanged', (t) => {
  const f = fixture(t);
  assert.equal(f.run(['run'], { TEST_HARBOR_EXIT: '7' }).status, 7);
});

test('judge aliases and automatic output directories work without a key in dry-run mode', (t) => {
  const f = fixture(t);
  execFileSync('bash', [join(ROOT, 'evals/code-change/tasks/review-seeded-bug/solution/solve.sh')], {
    env: { ...process.env, OUTPUT_DIR: f.root },
  });
  for (const [alias, model] of [['d1', 'liquid/d1.2-ultra'], ['jev', 'typesafe/jev-1.14'], ['vendor/custom', 'vendor/custom']]) {
    const out = join(f.root, alias);
    const child = f.run(['judge', 'review-seeded-bug', join(f.root, 'REVIEW.md'),
      '--judge', alias, '--out', out, '--dry-run'], { OPENROUTER_API_KEY: '' });
    assert.equal(child.status, 0, child.stderr);
    assert.match(child.stdout, /Status: dry_run/);
    const request = JSON.parse(readFileSync(join(out, 'request.json'), 'utf8'));
    assert.equal(request.model, model);
  }
  const auto = f.run(['judge', 'review-seeded-bug', join(f.root, 'REVIEW.md'), '--dry-run']);
  assert.equal(auto.status, 0, auto.stderr);
  const out = auto.stdout.match(/^Results: (.+)$/m)![1];
  t.after(() => rmSync(out, { recursive: true, force: true }));
  assert.ok(out.startsWith(join(ROOT, 'eval-results/judges/review-seeded-bug')));
  assert.equal(JSON.parse(readFileSync(join(out, 'request.json'), 'utf8')).model, 'liquid/d1.2-ultra');
});

/** Build an isolated saved run with real reference reviews for CLI integration tests. */
function savedRun(root: string): string {
  const job = join(root, 'saved-run');
  mkdirSync(job);
  writeFileSync(join(job, 'config.json'), JSON.stringify({ agents: [{ name: 'codex' }] }));
  writeFileSync(join(job, 'result.json'), JSON.stringify({ finished_at: '2026-01-01T00:00:00', n_total_trials: 3 }));
  for (const trial of ['canary__one', 'review-seeded-bug__one', 'review-seeded-bug__two']) {
    const task = trial.split('__')[0];
    execFileSync('bash', [join(ROOT, 'evals/code-change/tasks', task, 'solution/solve.sh')], {
      env: { ...process.env, OUTPUT_DIR: join(job, trial, 'artifacts/output') },
    });
  }
  return job;
}

test('saved-run judging finds all attempts and permits a task filter without report paths', (t) => {
  const f = fixture(t);
  const job = savedRun(f.root);
  const out = join(f.root, 'batch');
  const run = f.run(['judge', '--run', job, '--out', out, '--dry-run'], { OPENROUTER_API_KEY: '' });
  assert.equal(run.status, 0, run.stderr);
  const summary = JSON.parse(readFileSync(join(out, 'summary.json'), 'utf8'));
  assert.equal(summary.reports.length, 3);
  assert.ok(summary.reports.every((report: { status: string }) => report.status === 'dry_run'));
  assert.ok(existsSync(join(out, 'review-seeded-bug__two/request.json')));
  assert.ok(existsSync(join(out, 'report.html')));
  const filtered = f.run(['judge', 'review-seeded-bug', '--run', job, '--out', join(f.root, 'filtered'), '--dry-run']);
  assert.equal(filtered.status, 0, filtered.stderr);
  assert.match(filtered.stdout, /reports: 2/);
  const conflict = f.run(['judge', '--run', job, '--latest', '--dry-run']);
  assert.equal(conflict.status, 1);
  assert.match(conflict.stderr, /Choose one report source/);
});

test('batch judging stops at the first API error and preserves a summary of pending trials', (t) => {
  const f = fixture(t);
  const job = savedRun(f.root);
  const preload = join(f.root, 'mock-fetch.mjs');
  const calls = join(f.root, 'calls.txt');
  writeFileSync(preload, `import { appendFileSync } from 'node:fs';
globalThis.fetch = async () => {
  appendFileSync(${JSON.stringify(calls)}, 'called\\n');
  return new Response('{}', { status: 429 });
};`);
  const out = join(f.root, 'failed-batch');
  const run = f.run(['judge', '--run', job, '--out', out], {
    NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`,
  });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /HTTP 429/);
  assert.equal(readFileSync(calls, 'utf8'), 'called\n');
  const summary = JSON.parse(readFileSync(join(out, 'summary.json'), 'utf8'));
  assert.deepEqual(summary.reports.map((report: { status: string }) => report.status), ['error', 'pending', 'pending']);
  assert.ok(readFileSync(join(out, 'report.html'), 'utf8').includes('HTTP 429'));
});

test('report rebuilds saved judgments without credentials or network access', (t) => {
  const f = fixture(t);
  const job = savedRun(f.root);
  const out = join(f.root, 'judged');
  const judge = f.run(['judge', '--run', job, '--out', out, '--dry-run'], { OPENROUTER_API_KEY: '' });
  assert.equal(judge.status, 0, judge.stderr);
  const custom = join(f.root, 'custom.html');
  const report = f.run(['report', out, '--out', custom], { OPENROUTER_API_KEY: '' });
  assert.equal(report.status, 0, report.stderr);
  assert.match(report.stdout, /HTML report:/);
  assert.ok(readFileSync(custom, 'utf8').includes('Rubric and scores'));
  const missing = join(f.root, 'no-judge-output');
  const invalid = f.run(['report', missing]);
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /No saved judge data/);
  assert.ok(!existsSync(missing));
  assert.equal(f.calls().length, 0);
});

test('Harbor commands stage lib/grade_review.mts into target tasks and dry-run leaves tasks untouched', (t) => {
  const f = fixture(t);
  const source = readFileSync(join(ROOT, 'evals/code-change/lib/grade_review.mts'), 'utf8');
  const tasks = ['canary', 'review-clean-change', 'review-seeded-bug'];
  const staged = (task: string) => join(ROOT, 'evals/code-change/tasks', task, 'tests/grade_review.mts');
  const clear = () => {
    for (const task of tasks) rmSync(staged(task), { force: true });
  };
  clear();
  t.after(clear);

  assert.equal(f.run(['canary', '--dry-run']).status, 0);
  assert.equal(f.run(['smoke', '--dry-run']).status, 0);
  assert.ok(tasks.every((task) => !existsSync(staged(task))));

  writeFileSync(staged('canary'), '// stale\n');
  assert.equal(f.run(['canary']).status, 0);
  assert.equal(readFileSync(staged('canary'), 'utf8'), source);
  assert.ok(!existsSync(staged('review-clean-change')));
  assert.ok(!existsSync(staged('review-seeded-bug')));

  clear();
  assert.equal(f.run(['run']).status, 0);
  for (const task of tasks) assert.equal(readFileSync(staged(task), 'utf8'), source, task);
});
