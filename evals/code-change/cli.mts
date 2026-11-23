#!/usr/bin/env node
/** Terminal entry point for code-change evals. Run pnpm eval --help for commands. */
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { DEFAULT_DECISION_MODEL } from '../../skills/judge-code/scripts/decisions.mts';
import { judgeReview, taskTarget } from './lib/judge_review.mts';
import { judgeCode, type JudgeScope } from './lib/judge_code.mts';
import { latestCodexRun, reportsFromRun } from './lib/run_reports.mts';
import { latestJudgment, writeHtmlReport } from './lib/html_report.mts';
import { DEFAULT_RUN_CONCURRENCY, countRunningDockerContainers, resolveRunConcurrency } from './lib/docker_concurrency.mts';
import { HarborLockInterruptedError, signalExitCode, withHarborLock } from './lib/harbor_lock.mts';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const TASKS = join(ROOT, 'evals/code-change/tasks');
const GRADER = join(ROOT, 'evals/code-change/lib/grade_review.mts');
const RESULTS = join(ROOT, 'eval-results');
const DEFAULT_MODEL = 'openai/gpt-6.1-terra';
const JUDGES: Record<string, string> = { jev: 'typesafe/jev-1.14', d1: DEFAULT_DECISION_MODEL };
const HELP = `Usage: pnpm eval <command> [options]

Commands:
  check                 Run all offline tests; no Docker or API key needed
  smoke                 Run Harbor oracle and nop checks; Docker required
  canary                Run one skill-loading trial with Codex
  run                   Run all tasks with the skill (5 attempts, 2 concurrent)
  judge [task] [report]  Score saved reviews or code (default: latest completed Codex run)
  report [DIRECTORY]    Build HTML from saved judge scores; no API call

Run options (canary, run):
  --model ID            Codex model (EVAL_MODEL or ${DEFAULT_MODEL})
  --effort LEVEL        Reasoning effort (default: high)
  --service-tier TIER   Codex service tier (default: priority / Fast)
  --auth local|api      Codex auth (default: local login)
  --baseline            Omit the skill
  --attempts N          Attempts per task (canary: 1, run: 5)
  --concurrency N       Concurrent trials (canary: 1, run: 2; 1 if Docker is busy)

Task option (run, smoke):
  --task NAME           Run one task instead of all tasks

Lock option (smoke, canary, run):
  --no-wait             Fail immediately if another eval holds the Harbor lock

Judge options:
  --latest              Use the latest completed Codex run (default without a report)
  --run DIRECTORY       Use a specific saved Harbor run
  --judge NAME          d1 (default), jev, or a full OpenRouter model ID
  --scope MODE          whole (default) or per-file (production_code tasks)
  --out DIRECTORY       New output directory (default: a unique saved run)
  --open                Open the HTML report in your browser

Report options:
  --latest              Use the latest saved judge scores (default)
  --out FILE.html       Write HTML to another file
  --open                Open the report in your browser

All commands:
  --dry-run             Preview commands; judge saves a request without an API call
  --help                Show this help

Harbor commands serialize via a host-wide lock (EVAL_LOCK_PATH or ~/.cache/agent-tooling-evals/harbor.lock).
Reports are exported automatically. Results: eval-results/
Judging needs OPENROUTER_API_KEY in your shell.
`;

/** Reject non-task paths before passing names to Harbor or loading judge context. */
function taskDirectory(name: string): string {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)
    || !existsSync(join(TASKS, name, 'task.toml'))) {
    const names = readdirSync(TASKS).filter((entry) => existsSync(join(TASKS, entry, 'task.toml')));
    throw new Error(`Unknown task ${name}. Choose: ${names.join(', ')}`);
  }
  return join(TASKS, name);
}

/** Return the selected task directory, or every task directory when no name is given. */
function taskDirectories(name?: string): string[] {
  if (name) return [taskDirectory(name)];
  return readdirSync(TASKS)
    .filter((entry) => existsSync(join(TASKS, entry, 'task.toml')))
    .sort()
    .map((entry) => join(TASKS, entry));
}

/** Stage the shared review grader into review tasks' tests/ folders before Harbor uploads them. */
function syncGrader(tasks: string[]): void {
  for (const dir of tasks) {
    if (existsSync(join(dir, 'tests/expected.json'))) {
      copyFileSync(GRADER, join(dir, 'tests/grade_review.mts'));
    }
  }
}

const POSITIVE_INTEGER_PATTERN = /^[1-9]\d*$/;

function parseOptionalPositiveInteger(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  const isValidPositiveInteger = POSITIVE_INTEGER_PATTERN.test(value) && Number.isSafeInteger(parsed);
  if (!isValidPositiveInteger) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function abortReasonSignal(signal: AbortSignal): NodeJS.Signals | null {
  const isPosixStop = signal.reason === 'SIGINT' || signal.reason === 'SIGTERM';
  return isPosixStop ? signal.reason : null;
}

/** Run children directly without a shell; preserve output, signal forwarding, and exit status. */
function run(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  dryRun: boolean,
  abortSignal?: AbortSignal,
): Promise<number> {
  if (dryRun) {
    console.log(JSON.stringify({ command, args, cwd: ROOT,
      codex_auth: env.CODEX_AUTH_JSON_PATH ?? null }));
    return Promise.resolve(0);
  }
  if (abortSignal?.aborted) {
    return Promise.resolve(signalExitCode(abortReasonSignal(abortSignal)));
  }
  return new Promise((resolveStatus, rejectError) => {
    const child = spawn(command, args, { cwd: ROOT, env, stdio: 'inherit' });
    const onAbort = () => {
      const forwardSignal = abortReasonSignal(abortSignal!) ?? 'SIGTERM';
      try { child.kill(forwardSignal); } catch { /* Child already exited. */ }
    };
    abortSignal?.addEventListener('abort', onAbort, { once: true });

    child.once('error', (error) => {
      abortSignal?.removeEventListener('abort', onAbort);
      const isMissingHarbor = (error as NodeJS.ErrnoException).code === 'ENOENT' && command === 'harbor';
      if (isMissingHarbor) {
        rejectError(new Error('Harbor is not installed. Run: uv tool install harbor'));
        return;
      }
      rejectError(error);
    });

    child.once('close', (code, termSignal) => {
      abortSignal?.removeEventListener('abort', onAbort);
      if (code !== null) {
        resolveStatus(code);
        return;
      }
      resolveStatus(signalExitCode(termSignal));
    });
  });
}

/** Explicit auth selection prevents an inherited local-login flag from overriding API mode. */
function codexEnvironment(auth: string, dryRun: boolean): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.OPENROUTER_API_KEY;
  if (auth === 'local') {
    env.CODEX_AUTH_JSON_PATH = env.CODEX_AUTH_JSON_PATH
      || join(env.CODEX_HOME || join(homedir(), '.codex'), 'auth.json');
    if (!dryRun && !statSync(env.CODEX_AUTH_JSON_PATH, { throwIfNoEntry: false })?.isFile()) {
      throw new Error('Local Codex auth file is missing. Run codex login, set CODEX_AUTH_JSON_PATH, or use --auth api.');
    }
  } else if (auth === 'api') {
    delete env.CODEX_AUTH_JSON_PATH;
    delete env.CODEX_FORCE_AUTH_JSON;
    if (!dryRun && !env.OPENAI_API_KEY && !env.CODEX_API_KEY) {
      throw new Error('Set OPENAI_API_KEY or CODEX_API_KEY for --auth api.');
    }
  } else {
    throw new Error('--auth must be local or api');
  }
  return env;
}

/** Harbor can exit zero with failed trials; verify completion and the expected smoke reward. */
function verifySmoke(job: string, trials: number, expectedReward: number): void {
  const result = JSON.parse(readFileSync(join(job, 'result.json'), 'utf8'));
  if (result.n_total_trials !== trials || result.stats?.n_completed_trials !== trials
    || result.stats?.n_errored_trials !== 0) {
    throw new Error(`Smoke run did not finish ${trials} trials without errors. Inspect ${job}`);
  }
  const evaluations = Object.values(result.stats.evals ?? {}) as Array<{ metrics?: Array<{ reward?: number }> }>;
  const rewards = evaluations.flatMap((evaluation) => evaluation.metrics?.map((metric) => metric.reward) ?? []);
  if (rewards.length !== 1 || rewards[0] !== expectedReward) {
    throw new Error(`Smoke run expected reward ${expectedReward}. Inspect ${job}`);
  }
}

/** Opening is opt-in, so report generation also works in headless terminals. */
function showReport(path: string, open: boolean): Promise<number> {
  console.log(`HTML report: ${path}`);
  if (!open) return Promise.resolve(0);
  const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer.exe' : 'xdg-open';
  return run(opener, [path], process.env, false);
}

async function main(): Promise<number> {
  const [command, ...args] = process.argv.slice(2);
  if (!command || command === '--help' || command === '-h' || args.includes('--help')) {
    console.log(HELP);
    return 0;
  }
  const common = { 'dry-run': { type: 'boolean' as const, default: false } };
  if (command === 'check') {
    const { values } = parseArgs({ args, options: common });
    return run(process.execPath, ['--test',
      'evals/code-change/lib/selfcheck.mts',
      'evals/code-change/lib/judge_review.test.mts',
      'evals/code-change/lib/judge_code.test.mts',
      'evals/code-change/lib/standalone_judge.test.mts',
      'evals/code-change/lib/run_reports.test.mts',
      'evals/code-change/lib/html_report.test.mts',
      'evals/code-change/cli.test.mts',
    ], process.env, values['dry-run']);
  }
  if (command === 'report') {
    const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
      ...common, latest: { type: 'boolean', default: false }, out: { type: 'string' },
      open: { type: 'boolean', default: false },
    } });
    if (positionals.length > 1 || (values.latest && positionals.length) || positionals.some((value) => !value.trim())) {
      throw new Error('Usage: pnpm eval report [DIRECTORY | --latest] [--open] [--out FILE.html]');
    }
    const directory = positionals[0] ? resolve(positionals[0]) : latestJudgment(join(RESULTS, 'judges'));
    if (values['dry-run']) {
      console.log(`HTML report source: ${directory}`);
      return 0;
    }
    return showReport(writeHtmlReport(directory, values.out), values.open);
  }
  if (command === 'judge') {
    const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
      ...common, judge: { type: 'string', default: 'd1' }, out: { type: 'string' },
      scope: { type: 'string', default: 'whole' },
      latest: { type: 'boolean', default: false }, run: { type: 'string' },
      open: { type: 'boolean', default: false },
    } });
    if (positionals.length > 2) throw new Error('Usage: pnpm eval judge [task] [report] [--latest | --run DIRECTORY] [--judge d1|jev|MODEL] [--scope whole|per-file]');
    if (positionals.some((value) => value.length === 0)) throw new Error('Task and report arguments must not be empty.');
    if (values.run !== undefined && !values.run.trim()) throw new Error('--run must name a saved run directory.');
    if (values.scope !== 'whole' && values.scope !== 'per-file') {
      throw new Error('--scope must be whole or per-file');
    }
    const scope: JudgeScope = values.scope;
    if ((values.latest && values.run) || (positionals.length === 2 && (values.latest || values.run))) {
      throw new Error('Choose one report source: a report path, --latest, or --run DIRECTORY.');
    }
    const [task, report] = positionals;
    const directory = task ? taskDirectory(task) : undefined;
    const model = Object.hasOwn(JUDGES, values.judge) ? JUDGES[values.judge] : values.judge;
    if (!model.trim()) throw new Error('--judge must name a model');
    const modelSlug = `${model.replace(/[^a-zA-Z0-9.-]/g, '-')}${scope === 'per-file' ? '-per-file' : ''}`;
    if (!report) {
      const source = values.run ? resolve(values.run) : latestCodexRun(join(RESULTS, 'harbor'));
      const reports = reportsFromRun(source, TASKS, task);
      if (scope === 'per-file' && reports.some((entry) => entry.target !== 'production_code')) {
        throw new Error('--scope per-file applies only to production_code tasks.');
      }
      if (!values['dry-run'] && !process.env.OPENROUTER_API_KEY?.trim()) throw new Error('Set OPENROUTER_API_KEY before judging.');
      const out = values.out ? resolve(values.out)
        : join(RESULTS, 'judges', basename(source), `${modelSlug}-${randomUUID()}`);
      mkdirSync(dirname(out), { recursive: true });
      mkdirSync(out);
      const summary = {
        source_run: source, model, scope,
        reports: reports.map((entry) => ({ ...entry, status: 'pending', result_dir: join(out, entry.trial),
          quality_pass_rate: null as number | null, error: null as string | null })),
      };
      const saveSummary = () => {
        writeFileSync(join(out, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
        writeHtmlReport(out);
      };
      saveSummary();
      console.log(`Run: ${source}`);
      console.log(`Judge: ${model} (${scope}); reports: ${reports.length}`);
      console.log(`Results: ${out}`);
      for (const entry of summary.reports) {
        try {
          const result = entry.target === 'production_code'
            ? await judgeCode({ task: taskDirectory(entry.task), sourceDir: entry.report,
                model, out: entry.result_dir, scope, rewardPath: entry.rewardPath, dryRun: values['dry-run'] })
            : await judgeReview({ task: taskDirectory(entry.task), report: entry.report,
                model, out: entry.result_dir, dryRun: values['dry-run'] });
          entry.status = result.status;
          entry.quality_pass_rate = result.quality?.pass_rate ?? null;
          entry.error = result.error ?? null;
        } catch (error) {
          entry.status = 'error';
          entry.error = error instanceof Error ? error.message : 'Judging failed';
        }
        saveSummary();
        if (entry.status === 'error' || entry.status === 'missing_report') {
          if (entry.error) console.error(entry.error);
          await showReport(join(out, 'report.html'), values.open);
          return 1;
        }
      }
      return showReport(join(out, 'report.html'), values.open);
    }
    const target = taskTarget(directory!);
    if (target === 'review' && scope === 'per-file') {
      throw new Error('--scope per-file applies only to production_code tasks.');
    }
    const reportStat = statSync(report, { throwIfNoEntry: false });
    if (target === 'production_code' ? !(reportStat?.isDirectory() || reportStat?.isFile()) : !reportStat?.isFile()) {
      throw new Error(`Report file is missing: ${report}. Omit the path to judge this task in the latest run.`);
    }
    const out = values.out ? resolve(values.out)
      : join(RESULTS, 'judges', task, `${modelSlug}-${randomUUID()}`);
    const result = target === 'production_code'
      ? await judgeCode({ task: directory!, sourceDir: report, model, out, scope, dryRun: values['dry-run'] })
      : await judgeReview({ task: directory!, report, model, out, dryRun: values['dry-run'] });
    console.log(`Judge: ${model} (${scope})`);
    console.log(`Status: ${result.status}`);
    if (result.quality) console.log(`Quality checks passed: ${Object.values(result.quality.checks).filter((v) => v.choice === 'pass').length}/${Object.keys(result.quality.checks).length}`);
    console.log(`Results: ${out}`);
    if (result.error) console.error(result.error);
    const reportStatus = await showReport(writeHtmlReport(out), values.open);
    return result.status === 'error' ? 1 : reportStatus;
  }
  if (command === 'smoke') {
    const { values } = parseArgs({ args, options: {
      ...common,
      task: { type: 'string' },
      'no-wait': { type: 'boolean', default: false },
    } });
    const targets = taskDirectories(values.task);
    const task = values.task ? targets[0] : TASKS;
    const env = { ...process.env };
    delete env.OPENROUTER_API_KEY;
    const executeSmoke = async (abortSignal?: AbortSignal): Promise<number> => {
      if (!values['dry-run']) syncGrader(targets);
      for (const agent of ['oracle', 'nop']) {
        const name = `${agent}-${randomUUID()}`;
        const status = await run('harbor', ['run', '-p', task, '-a', agent, '-n', '1',
          '-o', join(RESULTS, 'harbor'), '--job-name', name], env, values['dry-run'], abortSignal);
        if (status !== 0) return status;
        if (!values['dry-run']) {
          verifySmoke(join(RESULTS, 'harbor', name), targets.length, agent === 'oracle' ? 1 : 0);
        }
      }
      return 0;
    };
    if (values['dry-run']) return executeSmoke();
    return withHarborLock(
      { command: 'smoke', task: values.task ?? null, cwd: ROOT, noWait: values['no-wait'], env },
      executeSmoke,
    );
  }
  if (command === 'canary' || command === 'run') {
    const { values } = parseArgs({ args, options: {
      ...common,
      model: { type: 'string', default: process.env.EVAL_MODEL || DEFAULT_MODEL },
      effort: { type: 'string', default: 'high' },
      'service-tier': { type: 'string', default: 'priority' },
      auth: { type: 'string', default: 'local' },
      baseline: { type: 'boolean', default: false },
      attempts: { type: 'string' }, concurrency: { type: 'string' },
      task: { type: 'string' },
      'no-wait': { type: 'boolean', default: false },
    } });
    if (command === 'canary' && values.task) throw new Error('--task applies to run and smoke; canary always selects canary.');
    if (!values.model.trim()) throw new Error('--model must name a model');
    if (!['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(values.effort)) {
      throw new Error('--effort must be none, minimal, low, medium, high, xhigh, or max');
    }
    if (!values['service-tier'].trim()) throw new Error('--service-tier must name a tier');
    const taskName = command === 'canary' ? 'canary' : values.task;
    const targets = taskDirectories(taskName);
    const task = taskName ? targets[0] : TASKS;
    const defaultAttempts = command === 'canary' ? 1 : 5;
    const attempts = String(parseOptionalPositiveInteger(values.attempts, '--attempts') ?? defaultAttempts);
    const requestedConcurrency = parseOptionalPositiveInteger(values.concurrency, '--concurrency');
    const env = codexEnvironment(values.auth, values['dry-run']);
    const buildHarborArgs = (concurrency: number): string[] => {
      const harborArgs = ['run', '-p', task, '-a', 'codex', '-m', values.model,
        '--ak', `reasoning_effort=${values.effort}`,
        '--ak', `config=${JSON.stringify({ service_tier: values['service-tier'] })}`,
        '-k', attempts, '-n', String(concurrency), '-o', join(RESULTS, 'harbor'),
        '--job-name', `${command}-${values.baseline ? 'baseline' : 'skill'}-${randomUUID()}`];
      if (targets.some((dir) => taskTarget(dir) === 'review')) harborArgs.push('--artifact', '/output/REVIEW.md');
      if (!values.baseline) harborArgs.push('--skill', join(ROOT, 'skills/code-change'));
      return harborArgs;
    };
    if (values['dry-run']) {
      const defaultConcurrency = command === 'canary' ? 1 : DEFAULT_RUN_CONCURRENCY;
      return run('harbor', buildHarborArgs(requestedConcurrency ?? defaultConcurrency), env, true);
    }
    return withHarborLock(
      { command, task: taskName ?? null, cwd: ROOT, noWait: values['no-wait'], env },
      async (abortSignal) => {
        let concurrency = requestedConcurrency ?? 1;
        if (command === 'run') {
          const activeContainers = countRunningDockerContainers(env);
          const decision = resolveRunConcurrency(requestedConcurrency, activeContainers);
          if (decision.warning) console.error(decision.warning);
          concurrency = decision.concurrency;
        }
        syncGrader(targets);
        return run('harbor', buildHarborArgs(concurrency), env, false, abortSignal);
      },
    );
  }
  throw new Error(`Unknown command: ${command}. Run pnpm eval --help.`);
}

main().then((status) => { process.exitCode = status; }).catch((error) => {
  if (error instanceof HarborLockInterruptedError) {
    console.error(error.message);
    process.exitCode = error.exitCode;
    return;
  }
  console.error(error instanceof Error ? error.message : 'Eval command failed');
  process.exitCode = 1;
});
