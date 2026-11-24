import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test, { type TestContext } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  DEFAULT_RUN_CONCURRENCY,
  countRunningDockerContainers,
  resolveRunConcurrency,
} from './lib/docker_concurrency.mts';
import { isProcessAlive, resolveHarborLockPath, withHarborLock } from './lib/harbor_lock.mts';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const CLI = join(ROOT, 'evals/code-change/cli.mts');

async function waitForCondition(predicate: () => boolean, timeoutMs: number = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for test condition`);
}

function collectOutput(child: ChildProcess): {
  stdout: () => string;
  stderr: () => string;
  done: Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }>;
} {
  let stdout = '';
  let stderr = '';
  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', (chunk) => { stdout += chunk; });
  child.stderr?.on('data', (chunk) => { stderr += chunk; });
  const done = new Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }>((resolveDone, rejectDone) => {
    child.once('error', rejectDone);
    child.once('close', (code, signal) => resolveDone({ code, signal, stdout, stderr }));
  });
  return { stdout: () => stdout, stderr: () => stderr, done };
}

/** Substitute Harbor and Docker; no test can start Docker, an agent, or a paid model call. */
function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'code-change-cli-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bin = join(root, 'bin');
  mkdirSync(bin);
  const record = join(root, 'harbor.jsonl');
  const dockerRecord = join(root, 'docker.jsonl');
  const lockPath = join(root, 'harbor.lock');
  const auth = join(root, 'auth.json');
  writeFileSync(auth, '{}');
  const docker = join(bin, 'docker');
  writeFileSync(docker, `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
if (process.env.TEST_DOCKER_RECORD) {
  fs.appendFileSync(process.env.TEST_DOCKER_RECORD, JSON.stringify({ args }) + '\\n');
}
const exitCode = Number(process.env.TEST_DOCKER_EXIT ?? 0);
if (exitCode !== 0) process.exit(exitCode);
const count = Number(process.env.TEST_DOCKER_CONTAINERS ?? 0);
for (let i = 1; i <= count; i += 1) {
  process.stdout.write('fake-container-' + i + '\\n');
}
`);
  chmodSync(docker, 0o755);
  const harbor = join(bin, 'harbor');
  writeFileSync(harbor, `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
if (process.env.TEST_LOCK_SNAPSHOT && process.env.EVAL_LOCK_PATH && fs.existsSync(process.env.EVAL_LOCK_PATH)) {
  fs.writeFileSync(process.env.TEST_LOCK_SNAPSHOT, fs.readFileSync(process.env.EVAL_LOCK_PATH, 'utf8'));
}
fs.appendFileSync(process.env.TEST_HARBOR_RECORD, JSON.stringify({
  args, cwd: process.cwd(), auth: process.env.CODEX_AUTH_JSON_PATH ?? null,
  forceAuth: process.env.CODEX_FORCE_AUTH_JSON ?? null,
  openrouterPresent: Boolean(process.env.OPENROUTER_API_KEY),
}) + '\\n');
const finish = () => {
  const agent = args[args.indexOf('-a') + 1];
  if (agent === 'oracle' || agent === 'nop') {
    const job = path.join(args[args.indexOf('-o') + 1], args[args.indexOf('--job-name') + 1]);
    fs.mkdirSync(job, { recursive: true });
    const targetPath = args[args.indexOf('-p') + 1];
    const defaultTrials = fs.existsSync(path.join(targetPath, 'task.toml'))
      ? 1
      : fs.readdirSync(targetPath).filter((entry) => fs.existsSync(path.join(targetPath, entry, 'task.toml'))).length;
    const trials = process.env.TEST_SMOKE_TRIALS ? Number(process.env.TEST_SMOKE_TRIALS) : defaultTrials;
    const reward = process.env.TEST_SMOKE_REWARD ? Number(process.env.TEST_SMOKE_REWARD) : agent === 'oracle' ? 1 : 0;
    fs.writeFileSync(path.join(job, 'result.json'), JSON.stringify({ n_total_trials: trials,
      stats: { n_completed_trials: trials, n_errored_trials: 0, evals: { test: { metrics: [{ reward }] } } } }));
  }
  process.exit(Number(process.env.TEST_HARBOR_EXIT ?? 0));
};
if (process.env.TEST_HARBOR_READY_FILE) {
  fs.writeFileSync(process.env.TEST_HARBOR_READY_FILE, String(process.pid));
}
if (process.env.TEST_HARBOR_WAIT_FILE) {
  const timer = setInterval(() => {
    if (fs.existsSync(process.env.TEST_HARBOR_WAIT_FILE)) {
      clearInterval(timer);
      finish();
    }
  }, 20);
} else {
  finish();
}
`);
  chmodSync(harbor, 0o755);
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    EVAL_MODEL: '',
    EVAL_LOCK_PATH: lockPath,
    CODEX_AUTH_JSON_PATH: auth,
    TEST_HARBOR_RECORD: record,
    TEST_DOCKER_RECORD: dockerRecord,
    OPENROUTER_API_KEY: 'fake-judge-key',
  };
  return {
    root, record, dockerRecord, lockPath, auth,
    run(args: string[], extra: NodeJS.ProcessEnv = {}) {
      const child = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: { ...env, ...extra } });
      assert.ifError(child.error);
      return child;
    },
    spawn(args: string[], extra: NodeJS.ProcessEnv = {}) {
      const child = spawn(process.execPath, [CLI, ...args], { env: { ...env, ...extra }, stdio: ['ignore', 'pipe', 'pipe'] });
      t.after(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      });
      return { child, ...collectOutput(child) };
    },
    calls(): Array<{ args: string[]; cwd: string; auth: string | null; forceAuth: string | null; openrouterPresent: boolean }> {
      return existsSync(record) ? readFileSync(record, 'utf8').trim().split('\n').map((line) => JSON.parse(line)) : [];
    },
    dockerCalls(): Array<{ args: string[] }> {
      return existsSync(dockerRecord) ? readFileSync(dockerRecord, 'utf8').trim().split('\n').map((line) => JSON.parse(line)) : [];
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
  assert.equal(defaults[defaults.indexOf('-n') + 1], '2');
  assert.ok(defaults.includes('reasoning_effort=high'));
  assert.ok(defaults.includes('config={"service_tier":"priority"}'));
  const explicitHigher = f.run(['run', '--concurrency', '4']);
  assert.equal(explicitHigher.status, 0, explicitHigher.stderr);
  assert.equal(f.calls()[1].args[f.calls()[1].args.indexOf('-n') + 1], '4');
  const child = f.run(['run', '--baseline', '--task', 'review-seeded-bug', '--model', 'openai/example',
    '--attempts', '2', '--concurrency', '1', '--auth', 'api', '--effort', 'medium', '--service-tier', 'default'], {
    OPENAI_API_KEY: 'fake-agent-key', CODEX_FORCE_AUTH_JSON: '1',
  });
  assert.equal(child.status, 0, child.stderr);
  const overridden = f.calls()[2];
  assert.equal(overridden.auth, null);
  assert.equal(overridden.forceAuth, null);
  assert.ok(!overridden.args.includes('--skill'));
  assert.equal(overridden.args[overridden.args.indexOf('-m') + 1], 'openai/example');
  assert.ok(overridden.args.includes('reasoning_effort=medium'));
  assert.ok(overridden.args.includes('config={"service_tier":"default"}'));
  assert.equal(overridden.args[overridden.args.indexOf('-k') + 1], '2');
  assert.equal(overridden.args[overridden.args.indexOf('-n') + 1], '1');
  assert.ok(overridden.args.includes(join(ROOT, 'evals/code-change/tasks/review-seeded-bug')));
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
  const tasks = ['canary', 'review-seeded-bug'];
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
  assert.ok(!existsSync(staged('review-seeded-bug')));

  clear();
  assert.equal(f.run(['run']).status, 0);
  for (const task of tasks) assert.equal(readFileSync(staged(task), 'utf8'), source, task);
});

test('help documents default concurrency of 2, --no-wait, and busy-Docker behavior', (t) => {
  const f = fixture(t);
  const help = f.run(['--help']);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /5 attempts, 2 concurrent/);
  assert.match(help.stdout, /--concurrency N\s+Concurrent trials \(canary: 1, run: 2; 1 if Docker is busy\)/);
  assert.match(help.stdout, /--no-wait/);
  assert.match(help.stdout, /EVAL_LOCK_PATH/);
});

test('Harbor lock stores owner metadata while running and releases on normal exit and failure', (t) => {
  const f = fixture(t);
  const snapshot = join(f.root, 'lock-snapshot.json');
  const ok = f.run(['run', '--task', 'review-seeded-bug'], { TEST_LOCK_SNAPSHOT: snapshot });
  assert.equal(ok.status, 0, ok.stderr);
  assert.ok(!existsSync(f.lockPath), 'lock file should be removed after normal exit');

  const owner = JSON.parse(readFileSync(snapshot, 'utf8'));
  assert.equal(typeof owner.pid, 'number');
  assert.ok(owner.pid > 0);
  assert.equal(owner.command, 'run');
  assert.equal(owner.task, 'review-seeded-bug');
  assert.equal(owner.cwd, resolve(ROOT));
  assert.ok(Number.isFinite(Date.parse(owner.startedAt)));

  const failed = f.run(['canary'], { TEST_HARBOR_EXIT: '7' });
  assert.equal(failed.status, 7);
  assert.ok(!existsSync(f.lockPath), 'lock file should be removed when Harbor exits non-zero');

  const badSmoke = f.run(['smoke'], { TEST_SMOKE_REWARD: '0' });
  assert.equal(badSmoke.status, 1);
  assert.ok(!existsSync(f.lockPath), 'lock file should be removed when smoke verification throws');
  t.after(() => {
    for (const call of f.calls()) {
      const jobIndex = call.args.indexOf('--job-name');
      if (jobIndex !== -1 && (call.args.includes('oracle') || call.args.includes('nop'))) {
        rmSync(join(ROOT, 'eval-results/harbor', call.args[jobIndex + 1]), { recursive: true, force: true });
      }
    }
  });
});

test('Harbor lock releases cleanly when interrupted by SIGTERM', async (t) => {
  const f = fixture(t);
  const readyFile = join(f.root, 'ready');
  const waitFile = join(f.root, 'never-created');
  const proc = f.spawn(['run', '--task', 'review-seeded-bug'], {
    TEST_HARBOR_READY_FILE: readyFile,
    TEST_HARBOR_WAIT_FILE: waitFile,
  });

  await waitForCondition(() => existsSync(readyFile) && existsSync(f.lockPath));
  proc.child.kill('SIGTERM');
  const result = await proc.done;
  assert.notEqual(result.code, 0);
  assert.ok(!existsSync(f.lockPath), 'lock file should be removed after SIGTERM');
});

test('Harbor lock reclaims stale locks from exited PIDs automatically', (t) => {
  const f = fixture(t);
  const shortLived = spawnSync(process.execPath, ['-e', 'process.exit(0)']);
  assert.ok(shortLived.pid);
  writeFileSync(f.lockPath, JSON.stringify({
    pid: shortLived.pid,
    token: 'stale-token',
    command: 'run',
    task: 'canary',
    cwd: '/tmp/old-worktree',
    startedAt: '2026-01-01T00:00:00.000Z',
  }));

  const child = f.run(['canary']);
  assert.equal(child.status, 0, child.stderr);
  assert.match(child.stderr, new RegExp(`Reclaimed stale Harbor lock.*PID ${shortLived.pid}`));
  assert.equal(f.calls().length, 1);
  assert.ok(!existsSync(f.lockPath));
});

test('withHarborLock reclaims an aged corrupt lock file', async (t) => {
  const f = fixture(t);
  writeFileSync(f.lockPath, '{not-json');
  const messages: string[] = [];
  const result = await withHarborLock(
    {
      command: 'run',
      task: null,
      cwd: ROOT,
      lockPath: f.lockPath,
      initGraceMs: 0,
      log: (message) => messages.push(message),
    },
    async () => {
      const activeOwner = JSON.parse(readFileSync(f.lockPath, 'utf8'));
      assert.equal(activeOwner.pid, process.pid);
      return 'reclaimed';
    },
  );
  assert.equal(result, 'reclaimed');
  assert.ok(messages.some((message) => message.includes('corrupt or incomplete metadata')));
  assert.ok(!existsSync(f.lockPath));
});

test('isProcessAlive handles live PIDs, ESRCH, EPERM, and non-positive PIDs; resolveHarborLockPath respects precedence', () => {
  assert.equal(isProcessAlive(process.pid), true);
  assert.equal(isProcessAlive(0), false);
  assert.equal(isProcessAlive(-5), false);
  assert.equal(isProcessAlive(1.5), false);
  assert.equal(isProcessAlive(4242, () => {
    const err = new Error('no such process') as NodeJS.ErrnoException;
    err.code = 'ESRCH';
    throw err;
  }), false);
  assert.equal(isProcessAlive(4242, () => {
    const err = new Error('operation not permitted') as NodeJS.ErrnoException;
    err.code = 'EPERM';
    throw err;
  }), true);

  assert.equal(
    resolveHarborLockPath({ EVAL_LOCK_PATH: '/tmp/custom.lock', XDG_CACHE_HOME: '/tmp/xdg' }, '/Users/example'),
    resolve('/tmp/custom.lock'),
  );
  assert.equal(
    resolveHarborLockPath({ XDG_CACHE_HOME: '/tmp/xdg' }, '/Users/example'),
    join(resolve('/tmp/xdg'), 'agent-tooling-evals', 'harbor.lock'),
  );
  assert.equal(
    resolveHarborLockPath({}, '/Users/example'),
    join('/Users/example', '.cache', 'agent-tooling-evals', 'harbor.lock'),
  );
});

test('live lock fails fast with --no-wait, blocks and resumes when waiting, and cleans up on SIGTERM while waiting', async (t) => {
  const f = fixture(t);
  const readyFile = join(f.root, 'holder-ready');
  const releaseFile = join(f.root, 'holder-release');
  const holder = f.spawn(['run', '--task', 'review-seeded-bug'], {
    TEST_HARBOR_READY_FILE: readyFile,
    TEST_HARBOR_WAIT_FILE: releaseFile,
  });

  await waitForCondition(() => existsSync(readyFile) && existsSync(f.lockPath));
  const holderOwner = JSON.parse(readFileSync(f.lockPath, 'utf8'));

  for (const args of [['run', '--no-wait'], ['canary', '--no-wait'], ['smoke', '--no-wait']]) {
    const blocked = f.run(args);
    assert.equal(blocked.status, 1, JSON.stringify(args));
    assert.match(blocked.stderr, new RegExp(`PID ${holderOwner.pid}`));
    assert.match(blocked.stderr, /command: run/);
    assert.ok(blocked.stderr.includes(holderOwner.cwd));
    assert.ok(existsSync(f.lockPath), '--no-wait must not remove the live lock');
  }
  assert.equal(f.calls().length, 1, 'none of the --no-wait calls should have launched Harbor');

  const interruptedWaiter = f.spawn(['canary']);
  await waitForCondition(() => interruptedWaiter.stderr().includes(`PID ${holderOwner.pid}`));
  interruptedWaiter.child.kill('SIGTERM');
  const interruptedResult = await interruptedWaiter.done;
  assert.notEqual(interruptedResult.code, 0);
  assert.match(interruptedResult.stderr, /Interrupted while waiting for Harbor lock/);
  assert.ok(existsSync(f.lockPath), 'interrupted waiter must not remove holder lock');

  const waiter = f.spawn(['canary']);
  await waitForCondition(() => waiter.stderr().includes(`Waiting for Harbor lock`) && waiter.stderr().includes(`PID ${holderOwner.pid}`));
  assert.equal(f.calls().length, 1, 'waiter must not launch Harbor before holder releases lock');

  writeFileSync(releaseFile, 'go');
  const [holderResult, waiterResult] = await Promise.all([holder.done, waiter.done]);
  assert.equal(holderResult.code, 0, holderResult.stderr);
  assert.equal(waiterResult.code, 0, waiterResult.stderr);
  assert.match(waiterResult.stderr, /Acquired Harbor lock/);
  assert.equal(f.calls().length, 2, 'waiter should launch Harbor after holder finishes');
  assert.ok(!existsSync(f.lockPath), 'lock should be released after waiter finishes');
});

test('busy Docker host steps down default run concurrency to 1 and warns only when explicit --concurrency is set', (t) => {
  const f = fixture(t);

  const autoStepDown = f.run(['run'], { TEST_DOCKER_CONTAINERS: '3' });
  assert.equal(autoStepDown.status, 0, autoStepDown.stderr);
  assert.equal(f.calls()[0].args[f.calls()[0].args.indexOf('-n') + 1], '1');
  assert.match(autoStepDown.stderr, /3 Docker containers are already running/);
  assert.match(autoStepDown.stderr, /from 2 to 1/);
  assert.equal(f.dockerCalls().length, 1);
  assert.deepEqual(f.dockerCalls()[0].args, ['ps', '-q']);

  const explicitKept = f.run(['run', '--concurrency', '4'], { TEST_DOCKER_CONTAINERS: '2' });
  assert.equal(explicitKept.status, 0, explicitKept.stderr);
  assert.equal(f.calls()[1].args[f.calls()[1].args.indexOf('-n') + 1], '4');
  assert.match(explicitKept.stderr, /2 Docker containers are already running/);
  assert.match(explicitKept.stderr, /keeping explicit --concurrency 4/);

  const explicitOneStillWarns = f.run(['run', '--concurrency', '1'], { TEST_DOCKER_CONTAINERS: '1' });
  assert.equal(explicitOneStillWarns.status, 0, explicitOneStillWarns.stderr);
  assert.equal(f.calls()[2].args[f.calls()[2].args.indexOf('-n') + 1], '1');
  assert.match(explicitOneStillWarns.stderr, /1 Docker container is already running/);
  assert.match(explicitOneStillWarns.stderr, /keeping explicit --concurrency 1/);

  const dockerFailed = f.run(['run'], { TEST_DOCKER_EXIT: '1', TEST_DOCKER_CONTAINERS: '5' });
  assert.equal(dockerFailed.status, 0, dockerFailed.stderr);
  assert.equal(f.calls()[3].args[f.calls()[3].args.indexOf('-n') + 1], '2');
  assert.equal(dockerFailed.stderr.trim(), '');

  assert.equal(countRunningDockerContainers(process.env, '/nonexistent/docker-binary'), 0);
  assert.deepEqual(resolveRunConcurrency(undefined, 0), { concurrency: DEFAULT_RUN_CONCURRENCY, warning: null });
  assert.deepEqual(resolveRunConcurrency(4, 0), { concurrency: 4, warning: null });
  assert.equal(resolveRunConcurrency(undefined, 2).concurrency, 1);
  assert.equal(resolveRunConcurrency(3, 2).concurrency, 3);
});

test('--dry-run bypasses Harbor lock acquisition and Docker container checks', (t) => {
  const f = fixture(t);
  writeFileSync(f.lockPath, JSON.stringify({
    pid: process.pid,
    token: 'live-holder',
    command: 'run',
    task: null,
    cwd: '/tmp/other-worktree',
    startedAt: new Date().toISOString(),
  }));

  for (const args of [
    ['run', '--dry-run'],
    ['run', '--dry-run', '--no-wait'],
    ['canary', '--dry-run', '--no-wait'],
    ['smoke', '--dry-run', '--no-wait'],
  ]) {
    const child = f.run(args, { TEST_DOCKER_CONTAINERS: '4' });
    assert.equal(child.status, 0, `${JSON.stringify(args)}: ${child.stderr}`);
    assert.equal(child.stderr.trim(), '', `${JSON.stringify(args)} should not warn or wait`);
  }

  const runDry = JSON.parse(f.run(['run', '--dry-run'], { TEST_DOCKER_CONTAINERS: '4' }).stdout);
  assert.equal(runDry.args[runDry.args.indexOf('-n') + 1], '2');
  assert.equal(f.dockerCalls().length, 0, '--dry-run must not invoke docker ps');
  assert.equal(f.calls().length, 0, '--dry-run must not invoke harbor');
  assert.ok(existsSync(f.lockPath), '--dry-run must leave an existing lock untouched');
});

test('judge --target tests works on saved implementation runs and manual paths, and rejects incompatible options', (t) => {
  const f = fixture(t);
  const job = join(f.root, 'impl-run');
  mkdirSync(job);
  writeFileSync(join(job, 'config.json'), JSON.stringify({ agents: [{ name: 'codex' }] }));
  writeFileSync(join(job, 'result.json'), JSON.stringify({ finished_at: '2026-01-01T00:00:00', n_total_trials: 1 }));
  const trialSrc = join(job, 'implement-mars-rover__one/artifacts/workspace/src');
  mkdirSync(join(trialSrc, 'main/kotlin/rover'), { recursive: true });
  mkdirSync(join(trialSrc, 'test/kotlin/rover'), { recursive: true });
  writeFileSync(join(trialSrc, 'main/kotlin/rover/MarsRover.kt'), 'package rover\nobject MarsRover {}\n');
  writeFileSync(join(trialSrc, 'test/kotlin/rover/MarsRoverTest.kt'), 'package rover\nclass MarsRoverTest {}\n');

  const batchOut = join(f.root, 'batch-tests');
  const batch = f.run(['judge', '--run', job, '--target', 'tests', '--out', batchOut, '--dry-run'], { OPENROUTER_API_KEY: '' });
  assert.equal(batch.status, 0, batch.stderr);
  assert.match(batch.stdout, /test_code/);
  const batchSummary = JSON.parse(readFileSync(join(batchOut, 'summary.json'), 'utf8'));
  assert.equal(batchSummary.target, 'test_code');
  assert.equal(batchSummary.reports.length, 1);
  assert.equal(batchSummary.reports[0].target, 'test_code');
  const batchReq = JSON.parse(readFileSync(join(batchOut, 'implement-mars-rover__one/request.json'), 'utf8'));
  assert.deepEqual(Object.keys(batchReq.state.test_files), ['rover/MarsRoverTest.kt']);
  assert.deepEqual(Object.keys(batchReq.state.production_files_context), ['rover/MarsRover.kt']);

  // Manual path passing src/ resolves both src/test/kotlin and src/main/kotlin.
  const manualSrcOut = join(f.root, 'manual-src');
  const manualSrc = f.run(['judge', 'implement-mars-rover', trialSrc, '--target', 'tests', '--out', manualSrcOut, '--dry-run'], { OPENROUTER_API_KEY: '' });
  assert.equal(manualSrc.status, 0, manualSrc.stderr);
  const manualSrcReq = JSON.parse(readFileSync(join(manualSrcOut, 'request.json'), 'utf8'));
  assert.deepEqual(Object.keys(manualSrcReq.state.test_files), ['rover/MarsRoverTest.kt']);
  assert.deepEqual(Object.keys(manualSrcReq.state.production_files_context), ['rover/MarsRover.kt']);

  // Manual path passing src/test/kotlin resolves sibling src/main/kotlin automatically.
  const manualTestOut = join(f.root, 'manual-test');
  const manualTest = f.run(['judge', 'implement-mars-rover', join(trialSrc, 'test/kotlin'), '--target', 'tests', '--out', manualTestOut, '--dry-run'], { OPENROUTER_API_KEY: '' });
  assert.equal(manualTest.status, 0, manualTest.stderr);
  const manualTestReq = JSON.parse(readFileSync(join(manualTestOut, 'request.json'), 'utf8'));
  assert.deepEqual(Object.keys(manualTestReq.state.production_files_context), ['rover/MarsRover.kt']);

  // Incompatible combinations fail cleanly.
  assert.equal(f.run(['judge', '--run', job, '--target', 'tests', '--scope', 'per-file', '--dry-run']).status, 1);
  assert.equal(f.run(['judge', '--run', job, '--target', 'invalid', '--dry-run']).status, 1);
  assert.equal(f.run(['judge', 'canary', join(trialSrc, 'test/kotlin/rover/MarsRoverTest.kt'), '--target', 'tests', '--dry-run']).status, 1);
});
