#!/usr/bin/env node
/** Terminal entry point for code-change evals. Run pnpm eval --help for commands. */
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { judgeReview, taskTarget, type RubricTarget } from './lib/judge_review.mts';
import { judgeCode, judgeTests, type JudgeScope } from './lib/judge_code.mts';
import { latestCodexRun, reportsFromRun } from './lib/run_reports.mts';
import { latestJudgment, writeHtmlReport } from './lib/html_report.mts';
import { recordJudgeBatches } from './lib/scorecard_record.mts';
import { writeScorecardMarkdown } from './lib/scorecard_markdown.mts';
import { writeScorecardHtml } from './lib/scorecard_html.mts';
import type { ScorecardCondition } from './lib/scorecard_schema.mts';
import { DEFAULT_RUN_CONCURRENCY, countRunningDockerContainers, resolveRunConcurrency } from './lib/docker_concurrency.mts';
import { HarborLockInterruptedError, signalExitCode, withHarborLock } from './lib/harbor_lock.mts';
import {
  JUDGE_CODE_EXTRA_INSTRUCTION,
  inspectHarborRunCondition,
  type BaseRunCondition,
} from './lib/run_condition.mts';

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
  run                   Run all tasks with the skill (5 attempts, 2 concurrent)
  judge [task] [report]  Score saved reviews or code (default: latest completed Codex run)
  report [DIRECTORY]    Build HTML from saved judge scores; no API call
  scorecard [subcmd]    Build offline scorecard HTML dashboard, Markdown, or record judge runs

Run options (canary, run):
  --model ID            Codex model (EVAL_MODEL or ${DEFAULT_MODEL})
  --effort LEVEL        Reasoning effort (default: high)
  --service-tier TIER   Codex service tier (default: priority / Fast)
  --auth local|api      Codex auth (default: local login)
  --baseline            Omit the skill
  --with-judge-code     Install skills/judge-code and forward OPENROUTER_API_KEY into the agent container
  --attempts N          Attempts per task (canary: 1, run: 5)
  --concurrency N       Concurrent trials (canary: 1, run: 2; 1 if Docker is busy)

Task option (run, smoke):
  --task NAME           Run one task instead of all tasks

Lock option (smoke, canary, run):
  --no-wait             Fail immediately if another eval holds the Harbor lock

Judge options:
  --latest              Use the latest completed Codex run (default without a report)
  --run DIRECTORY       Use a specific saved Harbor run
  --resume DIRECTORY    Resume an interrupted batch judge directory (skips scored trials)
  --judge NAME          d1 (default), jev, or a full OpenRouter model ID
  --target MODE         default (task default) or tests (test_code for implementation tasks)
  --scope MODE          whole (default) or per-file (production_code tasks)
  --out DIRECTORY       New output directory (default: a unique saved run)
  --open                Open the HTML report in your browser

Report options:
  --latest              Use the latest saved judge scores (default)
  --out FILE.html       Write HTML to another file
  --open                Open the report in your browser

Scorecard commands & options:
  scorecard [--out FILE.html] [--open]
                        Build interactive HTML dashboard (eval-results/scorecard.html) without touching tracked files
  scorecard build [--out FILE.html] [--open]
                        Regenerate evals/SCORECARD.md and build the HTML dashboard
  scorecard record <judge-dir...> [--skill NAME] [--condition skill|baseline] [--git-ref REF] [--agent-model ID] [--task NAME] [--open]
                        Record saved judge batch(es) into evals/scorecards/<skill>/<task>.json and rebuild outputs

All commands:
  --dry-run             Preview commands; judge saves a request without an API call
  --help                Show this help

Harbor commands serialize via a host-wide lock (EVAL_LOCK_PATH or ~/.cache/agent-tooling-evals/harbor.lock).
Reports are exported automatically. Results: eval-results/
Judging needs OPENROUTER_API_KEY in your shell; transient HTTP 429/502/503/504 responses retry with backoff.
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
function codexEnvironment(auth: string, dryRun: boolean, withJudgeCode = false): NodeJS.ProcessEnv {
  const env = { ...process.env };
  const openRouterKey = env.OPENROUTER_API_KEY?.trim() ?? '';
  if (withJudgeCode) {
    if (!dryRun && !openRouterKey) {
      throw new Error('Set OPENROUTER_API_KEY in the host environment when using --with-judge-code.');
    }
    if (openRouterKey) {
      env.OPENROUTER_API_KEY = openRouterKey;
    } else {
      delete env.OPENROUTER_API_KEY;
    }
  } else {
    delete env.OPENROUTER_API_KEY;
  }
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

/** Resolve test directory and optional read-only production context directory from a manual path. */
function resolveManualTestPaths(inputPath: string): { testDir: string; productionDir?: string } {
  const resolved = resolve(inputPath);
  const stat = statSync(resolved, { throwIfNoEntry: false });
  if (stat?.isDirectory()) {
    const nestedKotlinTests = join(resolved, 'test/kotlin');
    if (statSync(nestedKotlinTests, { throwIfNoEntry: false })?.isDirectory()) {
      const nestedKotlinMain = join(resolved, 'main/kotlin');
      return {
        testDir: nestedKotlinTests,
        productionDir: statSync(nestedKotlinMain, { throwIfNoEntry: false })?.isDirectory() ? nestedKotlinMain : undefined,
      };
    }
    const siblingKotlinMain = resolve(resolved, '../../main/kotlin');
    if (resolved.replaceAll('\\', '/').endsWith('/src/test/kotlin')
      && statSync(siblingKotlinMain, { throwIfNoEntry: false })?.isDirectory()) {
      return { testDir: resolved, productionDir: siblingKotlinMain };
    }
    const siblingSrc = resolve(resolved, '../src');
    if (/(?:^|\/)tests?$/.test(resolved.replaceAll('\\', '/'))
      && statSync(siblingSrc, { throwIfNoEntry: false })?.isDirectory()) {
      return { testDir: resolved, productionDir: siblingSrc };
    }
    return { testDir: resolved };
  }
  if (stat?.isFile()) {
    const normalized = resolved.replaceAll('\\', '/');
    const kotlinTestMarker = '/src/test/kotlin/';
    const markerIndex = normalized.lastIndexOf(kotlinTestMarker);
    if (markerIndex !== -1) {
      const mainCandidate = `${normalized.slice(0, markerIndex)}/src/main/kotlin`;
      if (statSync(mainCandidate, { throwIfNoEntry: false })?.isDirectory()) {
        return { testDir: resolved, productionDir: mainCandidate };
      }
    }
  }
  return { testDir: resolved };
}

interface BatchSummaryReport {
  trial: string;
  task: string;
  target: RubricTarget;
  report: string;
  contextDir?: string;
  rewardPath?: string;
  status: string;
  result_dir: string;
  quality_pass_rate: number | null;
  error: string | null;
}

interface BatchSummary {
  source_run: string;
  model: string;
  scope: JudgeScope;
  target?: 'test_code';
  condition?: BaseRunCondition;
  with_judge_code?: boolean;
  reports: BatchSummaryReport[];
}

function loadResumeSummary(directory: string): { out: string; summary: BatchSummary } {
  const out = resolve(directory);
  const summaryPath = join(out, 'summary.json');
  if (!statSync(out, { throwIfNoEntry: false })?.isDirectory() || !statSync(summaryPath, { throwIfNoEntry: false })?.isFile()) {
    throw new Error(`No saved batch judge summary in ${out}. Pass a batch judge output directory containing summary.json.`);
  }
  const raw = JSON.parse(readFileSync(summaryPath, 'utf8'));
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`Invalid summary.json in ${out}.`);
  }
  if (typeof raw.source_run !== 'string' || !raw.source_run.trim()) {
    throw new Error(`Invalid summary.json in ${out}: missing source_run.`);
  }
  if (typeof raw.model !== 'string' || !raw.model.trim()) {
    throw new Error(`Invalid summary.json in ${out}: missing model.`);
  }
  const scope: JudgeScope = raw.scope ?? 'whole';
  if (scope !== 'whole' && scope !== 'per-file') {
    throw new Error(`Invalid summary.json in ${out}: unsupported scope ${String(raw.scope)}.`);
  }
  if (!Array.isArray(raw.reports) || raw.reports.length === 0) {
    throw new Error(`Invalid summary.json in ${out}: reports must be a nonempty array.`);
  }
  const reports: BatchSummaryReport[] = raw.reports.map((entry: unknown, index: number) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`Invalid summary.json in ${out}: reports[${index}] must be an object.`);
    }
    const item = entry as Record<string, unknown>;
    if (typeof item.trial !== 'string' || !item.trial.trim()
      || typeof item.task !== 'string' || !item.task.trim()
      || typeof item.report !== 'string' || !item.report.trim()
      || typeof item.result_dir !== 'string' || !item.result_dir.trim()
      || typeof item.status !== 'string' || !item.status.trim()) {
      throw new Error(`Invalid summary.json in ${out}: reports[${index}] is missing required fields.`);
    }
    const taskDir = taskDirectory(item.task);
    const target: RubricTarget = item.target === 'review' || item.target === 'production_code' || item.target === 'test_code'
      ? item.target
      : raw.target === 'test_code'
        ? 'test_code'
        : taskTarget(taskDir);
    return {
      ...(item as unknown as BatchSummaryReport),
      target,
    };
  });
  const condition = raw.condition === 'skill' || raw.condition === 'baseline' || raw.condition === 'oracle' || raw.condition === 'nop'
    ? raw.condition
    : undefined;
  const withJudgeCode = raw.with_judge_code === true ? true : undefined;
  return {
    out,
    summary: {
      source_run: raw.source_run,
      model: raw.model,
      scope,
      ...(raw.target === 'test_code' ? { target: 'test_code' as const } : {}),
      ...(condition ? { condition } : {}),
      ...(withJudgeCode ? { with_judge_code: true } : {}),
      reports,
    },
  };
}

async function runBatchJudge(
  out: string,
  summary: BatchSummary,
  dryRun: boolean,
  open: boolean,
  isResume: boolean,
): Promise<number> {
  const resolvedOut = resolve(out);
  const saveSummary = () => {
    writeFileSync(join(resolvedOut, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
    writeHtmlReport(resolvedOut);
  };
  saveSummary();
  for (const entry of summary.reports) {
    if (isResume && entry.status !== 'error' && entry.status !== 'pending') {
      continue;
    }
    if (isResume) {
      const resolvedTrialDir = resolve(entry.result_dir);
      if (resolvedTrialDir !== resolvedOut && !resolvedTrialDir.startsWith(`${resolvedOut}${sep}`)) {
        throw new Error(`Refusing to clear trial result directory outside ${resolvedOut}: ${resolvedTrialDir}`);
      }
      if (existsSync(resolvedTrialDir)) {
        rmSync(resolvedTrialDir, { recursive: true, force: true });
      }
    }
    try {
      const result = entry.target === 'test_code'
        ? await judgeTests({ task: taskDirectory(entry.task), testDir: entry.report,
            productionDir: entry.contextDir, model: summary.model, out: entry.result_dir,
            rewardPath: entry.rewardPath, dryRun })
        : entry.target === 'production_code'
          ? await judgeCode({ task: taskDirectory(entry.task), sourceDir: entry.report,
              model: summary.model, out: entry.result_dir, scope: summary.scope,
              rewardPath: entry.rewardPath, dryRun })
          : await judgeReview({ task: taskDirectory(entry.task), report: entry.report,
              model: summary.model, out: entry.result_dir, dryRun });
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
      if (entry.status === 'error') {
        console.error(`Resume remaining trials with: pnpm eval judge --resume ${resolvedOut}`);
      }
      await showReport(join(resolvedOut, 'report.html'), open);
      return 1;
    }
  }
  return showReport(join(resolvedOut, 'report.html'), open);
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
      'evals/code-change/lib/run_reports.test.mts',
      'evals/code-change/lib/html_report.test.mts',
      'evals/code-change/lib/scorecard.test.mts',
      'evals/code-change/cli.test.mts',
    ], process.env, values['dry-run']);
  }
  if (command === 'scorecard') {
    const subcommand = args[0] && !args[0].startsWith('-') ? args[0] : null;
    if (subcommand === 'record') {
      const { values, positionals } = parseArgs({
        args: args.slice(1),
        allowPositionals: true,
        options: {
          ...common,
          skill: { type: 'string', default: 'code-change' },
          condition: { type: 'string' },
          'git-ref': { type: 'string' },
          'agent-model': { type: 'string' },
          task: { type: 'string' },
          date: { type: 'string' },
          out: { type: 'string' },
          open: { type: 'boolean', default: false },
        },
      });
      if (!positionals.length || positionals.some((value) => !value.trim())) {
        throw new Error('Usage: pnpm eval scorecard record <judge-dir...> [--skill code-change] [--condition skill|baseline] [--git-ref REF] [--agent-model ID] [--task NAME] [--open]');
      }
      let condition: ScorecardCondition | undefined;
      if (values.condition !== undefined) {
        if (values.condition !== 'skill' && values.condition !== 'baseline') {
          throw new Error('--condition must be skill or baseline');
        }
        condition = values.condition;
      }
      if (values.date !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(values.date)) {
        throw new Error('--date must be YYYY-MM-DD');
      }
      const recorded = recordJudgeBatches({
        repoRoot: ROOT,
        judgeDirs: positionals,
        skill: values.skill,
        condition,
        gitRef: values['git-ref'],
        agentModel: values['agent-model'],
        taskFilter: values.task,
        recordedAt: values.date,
        dryRun: values['dry-run'],
      });
      for (const item of recorded) {
        console.log(`${values['dry-run'] ? 'Would record' : 'Recorded'} ${item.skill}/${item.task} (${item.condition}, ${item.target}): ${Math.round(item.entry.quality.pass_rate * 1000) / 10}% -> ${item.path}`);
      }
      if (values['dry-run']) return 0;
      const md = writeScorecardMarkdown(ROOT);
      console.log(`Markdown scorecard: ${md.path}`);
      const html = writeScorecardHtml(ROOT, values.out);
      return showReport(html.path, values.open);
    }
    if (subcommand === 'build') {
      const { values, positionals } = parseArgs({
        args: args.slice(1),
        allowPositionals: true,
        options: {
          ...common,
          out: { type: 'string' },
          open: { type: 'boolean', default: false },
        },
      });
      if (positionals.length > 0) {
        throw new Error('Usage: pnpm eval scorecard build [--out FILE.html] [--open]');
      }
      if (values['dry-run']) {
        console.log(`Would build ${join(ROOT, 'evals/SCORECARD.md')} and ${values.out ? resolve(values.out) : join(ROOT, 'eval-results/scorecard.html')}`);
        return 0;
      }
      const md = writeScorecardMarkdown(ROOT);
      console.log(`Markdown scorecard: ${md.path}`);
      const html = writeScorecardHtml(ROOT, values.out);
      return showReport(html.path, values.open);
    }
    if (subcommand !== null) {
      throw new Error(`Unknown scorecard subcommand: ${subcommand}. Choose build, record, or omit for HTML dashboard.`);
    }
    const { values, positionals } = parseArgs({
      args,
      allowPositionals: true,
      options: {
        ...common,
        out: { type: 'string' },
        open: { type: 'boolean', default: false },
      },
    });
    if (positionals.length > 0) {
      throw new Error('Usage: pnpm eval scorecard [--out FILE.html] [--open]');
    }
    if (values['dry-run']) {
      console.log(`Would build ${values.out ? resolve(values.out) : join(ROOT, 'eval-results/scorecard.html')}`);
      return 0;
    }
    const html = writeScorecardHtml(ROOT, values.out);
    return showReport(html.path, values.open);
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
      ...common, judge: { type: 'string' }, out: { type: 'string' },
      scope: { type: 'string' },
      target: { type: 'string' },
      latest: { type: 'boolean', default: false }, run: { type: 'string' },
      resume: { type: 'string' },
      open: { type: 'boolean', default: false },
    } });
    if (values.resume !== undefined) {
      if (!values.resume.trim()) throw new Error('--resume must name a saved batch judge directory.');
      if (positionals.length > 0 || values.latest || values.run !== undefined || values.out !== undefined
        || values.judge !== undefined || values.target !== undefined || values.scope !== undefined) {
        throw new Error('--resume uses settings saved in summary.json; omit task/report paths, --latest, --run, --out, --judge, --target, and --scope.');
      }
      const { out, summary } = loadResumeSummary(values.resume);
      const remaining = summary.reports.filter((entry) => entry.status === 'error' || entry.status === 'pending');
      const alreadyScored = summary.reports.filter((entry) => entry.status === 'scored').length;
      if (remaining.length === 0) {
        console.log(`Resuming: ${out}`);
        console.log(`All ${summary.reports.length} trials are already settled (${alreadyScored} scored); regenerating report.`);
        return showReport(writeHtmlReport(out), values.open);
      }
      if (!values['dry-run'] && !process.env.OPENROUTER_API_KEY?.trim()) {
        throw new Error('Set OPENROUTER_API_KEY before judging.');
      }
      console.log(`Resuming: ${out}`);
      console.log(`Run: ${summary.source_run}`);
      console.log(`Judge: ${summary.model} (${summary.scope}${summary.target === 'test_code' ? ', test_code' : ''}); remaining: ${remaining.length}/${summary.reports.length} (${alreadyScored} already scored)`);
      return runBatchJudge(out, summary, values['dry-run'], values.open, true);
    }
    const judgeValue = values.judge ?? 'd1';
    const scopeValue = values.scope ?? 'whole';
    const targetValue = values.target ?? 'default';
    if (positionals.length > 2) throw new Error('Usage: pnpm eval judge [task] [report] [--latest | --run DIRECTORY | --resume DIRECTORY] [--judge d1|jev|MODEL] [--target default|tests] [--scope whole|per-file]');
    if (positionals.some((value) => value.length === 0)) throw new Error('Task and report arguments must not be empty.');
    if (values.run !== undefined && !values.run.trim()) throw new Error('--run must name a saved run directory.');
    if (scopeValue !== 'whole' && scopeValue !== 'per-file') {
      throw new Error('--scope must be whole or per-file');
    }
    if (targetValue !== 'default' && targetValue !== 'tests' && targetValue !== 'test_code') {
      throw new Error('--target must be default or tests');
    }
    const isTestsTarget = targetValue === 'tests' || targetValue === 'test_code';
    const scope: JudgeScope = scopeValue;
    if ((values.latest && values.run) || (positionals.length === 2 && (values.latest || values.run))) {
      throw new Error('Choose one report source: a report path, --latest, or --run DIRECTORY.');
    }
    const [task, report] = positionals;
    const directory = task ? taskDirectory(task) : undefined;
    const model = Object.hasOwn(JUDGES, judgeValue) ? JUDGES[judgeValue] : judgeValue;
    if (!model.trim()) throw new Error('--judge must name a model');
    const modelSlug = `${model.replace(/[^a-zA-Z0-9.-]/g, '-')}${isTestsTarget ? '-tests' : ''}${scope === 'per-file' ? '-per-file' : ''}`;
    if (!report) {
      const source = values.run ? resolve(values.run) : latestCodexRun(join(RESULTS, 'harbor'));
      const reports = reportsFromRun(source, TASKS, task, isTestsTarget ? 'test_code' : undefined);
      if (scope === 'per-file' && (isTestsTarget || reports.some((entry) => entry.target !== 'production_code'))) {
        throw new Error('--scope per-file applies only to production_code tasks.');
      }
      if (!values['dry-run'] && !process.env.OPENROUTER_API_KEY?.trim()) throw new Error('Set OPENROUTER_API_KEY before judging.');
      const out = values.out ? resolve(values.out)
        : join(RESULTS, 'judges', basename(source), `${modelSlug}-${randomUUID()}`);
      mkdirSync(dirname(out), { recursive: true });
      mkdirSync(out);
      const runCondition = inspectHarborRunCondition(source);
      const summary: BatchSummary = {
        source_run: source, model, scope,
        ...(isTestsTarget ? { target: 'test_code' as const } : {}),
        ...(runCondition.baseCondition ? { condition: runCondition.baseCondition } : {}),
        ...(runCondition.withJudgeCode ? { with_judge_code: true } : {}),
        reports: reports.map((entry) => ({ ...entry, status: 'pending', result_dir: join(out, entry.trial),
          quality_pass_rate: null as number | null, error: null as string | null })),
      };
      console.log(`Run: ${source}`);
      console.log(`Judge: ${model} (${scope}${isTestsTarget ? ', test_code' : ''}); reports: ${reports.length}`);
      console.log(`Results: ${out}`);
      return runBatchJudge(out, summary, values['dry-run'], values.open, false);
    }
    const baseTarget = taskTarget(directory!);
    const target = isTestsTarget ? 'test_code' : baseTarget;
    if (isTestsTarget && baseTarget === 'review') {
      throw new Error(`Task ${task} is a review task and has no test suite to judge.`);
    }
    if (target !== 'production_code' && scope === 'per-file') {
      throw new Error('--scope per-file applies only to production_code tasks.');
    }
    const reportStat = statSync(report, { throwIfNoEntry: false });
    if (target === 'production_code' || target === 'test_code'
      ? !(reportStat?.isDirectory() || reportStat?.isFile())
      : !reportStat?.isFile()) {
      throw new Error(`Report file is missing: ${report}. Omit the path to judge this task in the latest run.`);
    }
    const out = values.out ? resolve(values.out)
      : join(RESULTS, 'judges', task, `${modelSlug}-${randomUUID()}`);
    const result = target === 'test_code'
      ? (() => {
        const { testDir, productionDir } = resolveManualTestPaths(report);
        return judgeTests({ task: directory!, testDir, productionDir, model, out, dryRun: values['dry-run'] });
      })()
      : target === 'production_code'
        ? judgeCode({ task: directory!, sourceDir: report, model, out, scope, dryRun: values['dry-run'] })
        : judgeReview({ task: directory!, report, model, out, dryRun: values['dry-run'] });
    const resolvedResult = await result;
    console.log(`Judge: ${model} (${scope}${target === 'test_code' ? ', test_code' : ''})`);
    console.log(`Status: ${resolvedResult.status}`);
    if (resolvedResult.quality) console.log(`Quality checks passed: ${Object.values(resolvedResult.quality.checks).filter((v) => v.choice === 'pass').length}/${Object.keys(resolvedResult.quality.checks).length}`);
    console.log(`Results: ${out}`);
    if (resolvedResult.error) console.error(resolvedResult.error);
    const reportStatus = await showReport(writeHtmlReport(out), values.open);
    return resolvedResult.status === 'error' ? 1 : reportStatus;
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
      'with-judge-code': { type: 'boolean', default: false },
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
    const withJudgeCode = values['with-judge-code'];
    const env = codexEnvironment(values.auth, values['dry-run'], withJudgeCode);
    const conditionSlug = `${values.baseline ? 'baseline' : 'skill'}${withJudgeCode ? '-with-judge-code' : ''}`;
    const buildHarborArgs = (concurrency: number): string[] => {
      const harborArgs = ['run', '-p', task, '-a', 'codex', '-m', values.model,
        '--ak', `reasoning_effort=${values.effort}`,
        '--ak', `config=${JSON.stringify({ service_tier: values['service-tier'] })}`,
        '-k', attempts, '-n', String(concurrency), '-o', join(RESULTS, 'harbor'),
        '--job-name', `${command}-${conditionSlug}-${randomUUID()}`];
      if (targets.some((dir) => taskTarget(dir) === 'review')) harborArgs.push('--artifact', '/output/REVIEW.md');
      if (!values.baseline) harborArgs.push('--skill', join(ROOT, 'skills/code-change'));
      if (withJudgeCode) {
        harborArgs.push(
          '--skill', join(ROOT, 'skills/judge-code'),
          '--ae', 'OPENROUTER_API_KEY=${OPENROUTER_API_KEY}',
          '--extra-instruction', JUDGE_CODE_EXTRA_INSTRUCTION,
        );
      }
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
