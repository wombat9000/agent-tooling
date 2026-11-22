import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { latestCodexRun, reportsFromRun } from './run_reports.mts';

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'code-change-runs-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const tasks = join(root, 'tasks');
  const jobs = join(root, 'jobs');
  mkdirSync(jobs);
  for (const task of ['canary', 'review-seeded-bug']) {
    mkdirSync(join(tasks, task), { recursive: true });
    writeFileSync(join(tasks, task, 'task.toml'), '');
  }
  return {
    root, tasks, jobs,
    run(name: string, finished: string | null, agent = 'codex') {
      const job = join(jobs, name);
      mkdirSync(job);
      writeFileSync(join(job, 'config.json'), JSON.stringify({ agents: [{ name: agent }] }));
      writeFileSync(join(job, 'result.json'), JSON.stringify({ finished_at: finished, n_total_trials: 3 }));
      for (const trial of ['canary__one', 'review-seeded-bug__one', 'review-seeded-bug__two']) {
        const artifacts = join(job, trial, 'artifacts/output');
        mkdirSync(artifacts, { recursive: true });
        writeFileSync(join(artifacts, 'REVIEW.md'), trial);
      }
      return job;
    },
  };
}

test('latest chooses completion time, ignores directory modification time, unfinished jobs, and smoke agents', (t) => {
  const f = fixture(t);
  const older = f.run('older', '2026-01-01T00:00:00');
  const latest = f.run('latest', '2026-01-02T00:00:00');
  f.run('still-running', null);
  f.run('newer-oracle', '2026-01-03T00:00:00', 'oracle');
  utimesSync(older, new Date('2040-01-01'), new Date('2040-01-01'));
  assert.equal(latestCodexRun(f.jobs), latest);
});

test('every attempt is returned, with optional task filtering', (t) => {
  const f = fixture(t);
  const job = f.run('run', '2026-01-02T00:00:00');
  const all = reportsFromRun(job, f.tasks);
  assert.equal(all.length, 3);
  const seeded = reportsFromRun(job, f.tasks, 'review-seeded-bug');
  assert.equal(seeded.length, 2);
  assert.deepEqual(seeded.map((entry) => entry.trial), ['review-seeded-bug__one', 'review-seeded-bug__two']);
  assert.equal(seeded[0].report, join(job, 'review-seeded-bug__one/artifacts/output/REVIEW.md'));
});

test('missing exports and incomplete or unfinished runs fail instead of selecting a partial set', (t) => {
  const f = fixture(t);
  const job = f.run('run', '2026-01-02T00:00:00');
  rmSync(join(job, 'review-seeded-bug__two/artifacts/output/REVIEW.md'));
  assert.throws(() => reportsFromRun(job, f.tasks), /No exported review for review-seeded-bug__two/);
  assert.equal(reportsFromRun(job, f.tasks, 'canary').length, 1);
  rmSync(join(job, 'review-seeded-bug__two'), { recursive: true });
  assert.throws(() => reportsFromRun(job, f.tasks), /incomplete trial data/);
  const running = f.run('running', null);
  assert.throws(() => reportsFromRun(running, f.tasks), /not finished/);
});

test('empty history, absent tasks, and unknown task folders give explicit errors', (t) => {
  const f = fixture(t);
  assert.throws(() => latestCodexRun(f.jobs), /No completed Codex runs/);
  assert.throws(() => latestCodexRun(join(f.root, 'missing')), /No saved Codex runs/);
  const job = f.run('run', '2026-01-02T00:00:00');
  assert.throws(() => reportsFromRun(job, f.tasks, 'missing'), /no reports for missing/);
  rmSync(join(f.tasks, 'canary'), { recursive: true });
  assert.throws(() => reportsFromRun(job, f.tasks), /Unknown task/);
});
