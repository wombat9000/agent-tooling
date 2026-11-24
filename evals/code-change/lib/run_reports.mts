/** Locate completed Harbor Codex runs and their exported artifacts without reading agent logs. */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { taskSourceRoot, taskTarget, taskTestRoot, type RubricTarget } from './judge_review.mts';

/** One trial's exported artifact (REVIEW.md, production src dir, or test dir), paired with its local eval task. */
export interface RunReport {
  trial: string;
  task: string;
  target: RubricTarget;
  report: string;
  contextDir?: string;
  rewardPath?: string;
}

/** Select by completion time, excluding unfinished jobs and non-Codex agents. */
export function latestCodexRun(jobsDirectory: string): string {
  if (!existsSync(jobsDirectory)) throw new Error('No saved Codex runs. Run pnpm eval canary or pnpm eval run first.');
  const runs: Array<{ directory: string; finished: number }> = [];
  for (const entry of readdirSync(jobsDirectory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const directory = join(jobsDirectory, entry.name);
    if (!existsSync(join(directory, 'config.json')) || !existsSync(join(directory, 'result.json'))) continue;
    const config = JSON.parse(readFileSync(join(directory, 'config.json'), 'utf8'));
    if (!Array.isArray(config.agents) || !config.agents.some((agent: { name?: string }) => agent?.name === 'codex')) continue;
    const result = JSON.parse(readFileSync(join(directory, 'result.json'), 'utf8'));
    if (!result.finished_at) continue;
    const finished = Date.parse(result.finished_at);
    if (!Number.isFinite(finished)) throw new Error(`Invalid completion time in ${directory}/result.json`);
    runs.push({ directory, finished });
  }
  runs.sort((a, b) => b.finished - a.finished || a.directory.localeCompare(b.directory));
  if (!runs.length) throw new Error('No completed Codex runs. Wait for the run to finish or pass --run DIRECTORY.');
  return runs[0].directory;
}

function artifactSubdir(trialDirectory: string, relativeRoot: string): string | null {
  for (const artifactRoot of ['artifacts/workspace', 'artifacts']) {
    const candidate = join(trialDirectory, artifactRoot, relativeRoot);
    if (statSync(candidate, { throwIfNoEntry: false })?.isDirectory()) return candidate;
  }
  return null;
}

/**
 * Read all selected trials before any judging call. Missing exports are errors, never skipped.
 * Only known local tasks are accepted; a completed job must have every trial directory.
 */
export function reportsFromRun(
  jobDirectory: string,
  tasksDirectory: string,
  taskFilter?: string,
  targetOverride?: 'test_code',
): RunReport[] {
  const directory = resolve(jobDirectory);
  const result = JSON.parse(readFileSync(join(directory, 'result.json'), 'utf8'));
  if (!result.finished_at) throw new Error(`Run is not finished: ${directory}`);
  const trials = readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.includes('__')).sort((a, b) => a.name.localeCompare(b.name));
  if (!trials.length || trials.length !== result.n_total_trials) {
    throw new Error(`Run has incomplete trial data: ${directory}`);
  }
  const reports: RunReport[] = [];
  for (const trial of trials) {
    const task = trial.name.split('__')[0];
    if (taskFilter && task !== taskFilter) continue;
    const taskDir = join(tasksDirectory, task);
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(task) || !existsSync(join(taskDir, 'task.toml'))) {
      throw new Error(`Unknown task in saved run: ${task}`);
    }
    const baseTarget = taskTarget(taskDir);
    const trialDir = join(directory, trial.name);
    const rewardCandidate = join(trialDir, 'verifier/reward.json');
    const rewardPath = statSync(rewardCandidate, { throwIfNoEntry: false })?.isFile() ? rewardCandidate : undefined;
    if (targetOverride === 'test_code') {
      if (baseTarget === 'review') {
        if (taskFilter) {
          throw new Error(`Task ${task} is a review task and has no test suite to judge.`);
        }
        continue;
      }
      const testRoot = taskTestRoot(taskDir);
      const testDir = artifactSubdir(trialDir, testRoot);
      if (!testDir) {
        throw new Error(`No exported test sources for ${trial.name}. Expected ${testRoot} under exported artifacts.`);
      }
      const contextDir = artifactSubdir(trialDir, taskSourceRoot(taskDir)) ?? undefined;
      reports.push({ trial: trial.name, task, target: 'test_code', report: testDir, contextDir, rewardPath });
    } else if (baseTarget === 'production_code') {
      const sourceDir = artifactSubdir(trialDir, taskSourceRoot(taskDir));
      if (!sourceDir) {
        throw new Error(`No exported production sources for ${trial.name}. Task needs artifacts = ["/workspace/src"].`);
      }
      reports.push({ trial: trial.name, task, target: baseTarget, report: sourceDir, rewardPath });
    } else {
      const report = join(trialDir, 'artifacts/output/REVIEW.md');
      if (!statSync(report, { throwIfNoEntry: false })?.isFile()) {
        throw new Error(`No exported review for ${trial.name}. Future runs need --artifact /output/REVIEW.md.`);
      }
      reports.push({ trial: trial.name, task, target: baseTarget, report, rewardPath });
    }
  }
  if (!reports.length) throw new Error(`Run has no reports${taskFilter ? ` for ${taskFilter}` : ''}: ${directory}`);
  return reports;
}
