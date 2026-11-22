#!/usr/bin/env node
/** Terminal entry point for code-change evals. Run pnpm eval --help for commands. */
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { judgeReview } from './lib/judge_review.mts';
import { latestCodexRun, reportsFromRun } from './lib/run_reports.mts';
import { latestJudgment, writeHtmlReport } from './lib/html_report.mts';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const TASKS = join(ROOT, 'evals/code-change/tasks');
const GRADER = join(ROOT, 'evals/code-change/lib/grade_review.mts');
const RESULTS = join(ROOT, 'eval-results');
const DEFAULT_MODEL = 'openai/gpt-6.1-terra';
const JUDGES: Record<string, string> = { jev: 'typesafe/jev-1.14', d1: 'liquid/d1.2-ultra' };
const HELP = `Usage: pnpm eval <command> [options]

Commands:
  check                 Run all offline tests; no Docker or API key needed
  smoke                 Run Harbor oracle and nop checks; Docker required
  canary                Run one skill-loading trial with Codex
  run                   Run all tasks with the skill (5 attempts, 4 concurrent)
  judge [task] [report]  Score saved reviews (default: latest completed Codex run)
  report [DIRECTORY]    Build HTML from saved judge scores; no API call

Run options (canary, run):
  --model ID            Codex model (EVAL_MODEL or ${DEFAULT_MODEL})
  --effort LEVEL        Reasoning effort (default: high)
  --service-tier TIER   Codex service tier (default: priority / Fast)
  --auth local|api      Codex auth (default: local login)
  --baseline            Omit the skill
  --attempts N          Attempts per task (canary: 1, run: 5)
  --concurrency N       Concurrent trials (canary: 1, run: 4)

Task option (run, smoke):
  --task NAME           Run one task instead of all tasks

Judge options:
  --latest              Use the latest completed Codex run (default without a report)
  --run DIRECTORY       Use a specific saved Harbor run
  --judge NAME          d1 (default), jev, or a full OpenRouter model ID
  --out DIRECTORY       New output directory (default: a unique saved run)
  --open                Open the HTML report in your browser

Report options:
  --latest              Use the latest saved judge scores (default)
  --out FILE.html       Write HTML to another file
  --open                Open the report in your browser

All commands:
  --dry-run             Preview commands; judge saves a request without an API call
  --help                Show this help

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

/** Stage the shared grader into each task's tests/ folder before Harbor uploads it. */
function syncGrader(tasks: string[]): void {
  for (const dir of tasks) {
    copyFileSync(GRADER, join(dir, 'tests/grade_review.mts'));
  }
}

function positiveInteger(value: string | undefined, fallback: number, name: string): string {
  if (value === undefined) return String(fallback);
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

/** Run children directly without a shell; preserve output and their nonzero exit status. */
function run(command: string, args: string[], env: NodeJS.ProcessEnv, dryRun: boolean): number {
  if (dryRun) {
    console.log(JSON.stringify({ command, args, cwd: ROOT,
      codex_auth: env.CODEX_AUTH_JSON_PATH ?? null }));
    return 0;
  }
  const child = spawnSync(command, args, { cwd: ROOT, env, stdio: 'inherit' });
  if (child.error) {
    if ((child.error as NodeJS.ErrnoException).code === 'ENOENT' && command === 'harbor') {
      throw new Error('Harbor is not installed. Run: uv tool install harbor');
    }
    throw child.error;
  }
  return child.status ?? 1;
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
function showReport(path: string, open: boolean): number {
  console.log(`HTML report: ${path}`);
  if (!open) return 0;
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
      latest: { type: 'boolean', default: false }, run: { type: 'string' },
      open: { type: 'boolean', default: false },
    } });
    if (positionals.length > 2) throw new Error('Usage: pnpm eval judge [task] [report] [--latest | --run DIRECTORY] [--judge d1|jev|MODEL]');
    if (positionals.some((value) => value.length === 0)) throw new Error('Task and report arguments must not be empty.');
    if (values.run !== undefined && !values.run.trim()) throw new Error('--run must name a saved run directory.');
    if ((values.latest && values.run) || (positionals.length === 2 && (values.latest || values.run))) {
      throw new Error('Choose one report source: a report path, --latest, or --run DIRECTORY.');
    }
    const [task, report] = positionals;
    const directory = task ? taskDirectory(task) : undefined;
    const model = Object.hasOwn(JUDGES, values.judge) ? JUDGES[values.judge] : values.judge;
    if (!model.trim()) throw new Error('--judge must name a model');
    if (!report) {
      const source = values.run ? resolve(values.run) : latestCodexRun(join(RESULTS, 'harbor'));
      const reports = reportsFromRun(source, TASKS, task);
      if (!values['dry-run'] && !process.env.OPENROUTER_API_KEY?.trim()) throw new Error('Set OPENROUTER_API_KEY before judging.');
      const out = values.out ? resolve(values.out)
        : join(RESULTS, 'judges', basename(source), `${model.replace(/[^a-zA-Z0-9.-]/g, '-')}-${randomUUID()}`);
      mkdirSync(dirname(out), { recursive: true });
      mkdirSync(out);
      const summary = {
        source_run: source, model,
        reports: reports.map((entry) => ({ ...entry, status: 'pending', result_dir: join(out, entry.trial),
          quality_pass_rate: null as number | null, error: null as string | null })),
      };
      const saveSummary = () => {
        writeFileSync(join(out, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
        writeHtmlReport(out);
      };
      saveSummary();
      console.log(`Run: ${source}`);
      console.log(`Judge: ${model}; reports: ${reports.length}`);
      console.log(`Results: ${out}`);
      for (const entry of summary.reports) {
        try {
          const result = await judgeReview({ task: taskDirectory(entry.task), report: entry.report,
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
          showReport(join(out, 'report.html'), values.open);
          return 1;
        }
      }
      return showReport(join(out, 'report.html'), values.open);
    }
    if (!statSync(report, { throwIfNoEntry: false })?.isFile()) throw new Error(`Report file is missing: ${report}. Omit the path to judge this task in the latest run.`);
    const out = values.out ? resolve(values.out)
      : join(RESULTS, 'judges', task, `${model.replace(/[^a-zA-Z0-9.-]/g, '-')}-${randomUUID()}`);
    const result = await judgeReview({ task: directory!, report, model, out, dryRun: values['dry-run'] });
    console.log(`Judge: ${model}`);
    console.log(`Status: ${result.status}`);
    if (result.quality) console.log(`Quality checks passed: ${Object.values(result.quality.checks).filter((v) => v.choice === 'pass').length}/${Object.keys(result.quality.checks).length}`);
    console.log(`Results: ${out}`);
    if (result.error) console.error(result.error);
    const reportStatus = showReport(writeHtmlReport(out), values.open);
    return result.status === 'error' ? 1 : reportStatus;
  }
  if (command === 'smoke') {
    const { values } = parseArgs({ args, options: { ...common, task: { type: 'string' } } });
    const targets = taskDirectories(values.task);
    const task = values.task ? targets[0] : TASKS;
    const env = { ...process.env };
    delete env.OPENROUTER_API_KEY;
    if (!values['dry-run']) syncGrader(targets);
    for (const agent of ['oracle', 'nop']) {
      const name = `${agent}-${randomUUID()}`;
      const status = run('harbor', ['run', '-p', task, '-a', agent, '-n', '1',
        '-o', join(RESULTS, 'harbor'), '--job-name', name], env, values['dry-run']);
      if (status !== 0) return status;
      if (!values['dry-run']) {
        verifySmoke(join(RESULTS, 'harbor', name), targets.length, agent === 'oracle' ? 1 : 0);
      }
    }
    return 0;
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
    const attempts = positiveInteger(values.attempts, command === 'canary' ? 1 : 5, '--attempts');
    const concurrency = positiveInteger(values.concurrency, command === 'canary' ? 1 : 4, '--concurrency');
    const harborArgs = ['run', '-p', task, '-a', 'codex', '-m', values.model,
      '--ak', `reasoning_effort=${values.effort}`,
      '--ak', `config=${JSON.stringify({ service_tier: values['service-tier'] })}`,
      '-k', attempts, '-n', concurrency, '--artifact', '/output/REVIEW.md', '-o', join(RESULTS, 'harbor'),
      '--job-name', `${command}-${values.baseline ? 'baseline' : 'skill'}-${randomUUID()}`];
    if (!values.baseline) harborArgs.push('--skill', join(ROOT, 'skills/code-change'));
    const env = codexEnvironment(values.auth, values['dry-run']);
    if (!values['dry-run']) syncGrader(targets);
    return run('harbor', harborArgs, env, values['dry-run']);
  }
  throw new Error(`Unknown command: ${command}. Run pnpm eval --help.`);
}

main().then((status) => { process.exitCode = status; }).catch((error) => {
  console.error(error instanceof Error ? error.message : 'Eval command failed');
  process.exitCode = 1;
});
