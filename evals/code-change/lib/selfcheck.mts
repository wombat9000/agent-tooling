#!/usr/bin/env node
/** Check task copies, reference reviews, failure cases, and the grader CLI without Docker. */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { grade, type ExpectedReview } from './grade_review.mts';

const LIB = fileURLToPath(new URL('.', import.meta.url));
const TASKS = join(LIB, '../tasks');

function expected(task: string): ExpectedReview {
  return JSON.parse(readFileSync(join(TASKS, task, 'tests/expected.json'), 'utf8'));
}

/** Reference scripts write only inside an owned temporary directory, removed even on failure. */
function referenceReport(task: string): string {
  const out = mkdtempSync(join(tmpdir(), 'code-change-reference-'));
  try {
    execFileSync('bash', [join(TASKS, task, 'solution/solve.sh')], {
      env: { ...process.env, OUTPUT_DIR: out },
    });
    return readFileSync(join(out, 'REVIEW.md'), 'utf8');
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

test('each task has a passing reference review and a failing missing report', () => {
  const tasks = readdirSync(TASKS).filter((task) => existsSync(join(TASKS, task, 'task.toml'))).sort();
  assert.ok(tasks.length);
  for (const task of tasks) {
    assert.ok(existsSync(join(TASKS, task, 'tests/test.sh')), `${task}: missing tests/test.sh`);
    assert.equal(grade(referenceReport(task), expected(task)).reward, 1, task);
    assert.ok(Object.values(grade(null, expected(task))).every((score) => score === 0), task);
  }
});

test('lowering the seeded bug severity fails', () => {
  const report = referenceReport('review-seeded-bug').replace('### Blocking', '### Optional');
  assert.equal(grade(report, expected('review-seeded-bug')).severity, 0);
});

test('an invented finding above Optional fails on the clean change', () => {
  const report = referenceReport('review-clean-change') + [
    '\n### Should fix — Thresholds should be configurable',
    '- Location: src/main/kotlin/shop/ShippingPolicy.kt:12',
    '- Category: design', '- Evidence: hypothesis — may change later', '',
  ].join('\n');
  const scores = grade(report, expected('review-clean-change'));
  assert.equal(scores.restraint, 0);
  assert.equal(scores.reward, 0);
});

test('a review without the skill format fails the canary', () => {
  const report = 'The import duplicates the SKU check and crashes on lines without a comma. '
    + 'The test only asserts that the result is not null.\n';
  assert.equal(grade(report, expected('canary')).reward, 0);
});

test('Markdown emphasis, CRLF, and location ranges retain the reference scores', () => {
  const report = referenceReport('review-seeded-bug')
    .replace('Verdict:', '**Verdict:**')
    .replaceAll('### ', '#### ')
    .replaceAll('- Category:', '- **Category:**')
    .replace('src/main/kotlin/shop/PricingPolicy.kt:18', '`src/main/kotlin/shop/PricingPolicy.kt:17–19`')
    .replaceAll('\n', '\r\n');
  assert.equal(grade(report, expected('review-seeded-bug')).reward, 1);
});

test('Unicode decimal line numbers retain the reference scores', () => {
  const reference = referenceReport('review-seeded-bug');
  for (const digits of ['١٨', '１８', '𝟙𝟠', '1٨', '١٧–١٩']) {
    const report = reference.replace('PricingPolicy.kt:18', `PricingPolicy.kt:${digits}`);
    assert.equal(grade(report, expected('review-seeded-bug')).reward, 1, digits);
  }
});

test('Unicode letters do not end verdict words or guideline IDs', () => {
  const clean = referenceReport('review-clean-change').replace('Verdict: ready', 'Verdict: readyé');
  assert.equal(grade(clean, expected('review-clean-change')).verdict, 0);
  const canary = referenceReport('canary').replaceAll('M3', 'éM3').replaceAll('T2', 'T2é');
  assert.equal(grade(canary, expected('canary')).guideline, 0);
});

test('CLI writes reward.json and stdout for present and missing reports; bad arguments fail', () => {
  const out = mkdtempSync(join(tmpdir(), 'code-change-cli-'));
  try {
    const report = join(out, 'REVIEW.md');
    writeFileSync(report, referenceReport('review-clean-change'));
    for (const [path, reward] of [[report, 1], [join(out, 'missing.md'), 0]] as const) {
      const resultPath = join(out, 'nested/reward.json');
      const stdout = execFileSync(process.execPath, [join(LIB, 'grade_review.mts'),
        '--report', path, '--expected', join(TASKS, 'review-clean-change/tests/expected.json'),
        '--out', resultPath], { encoding: 'utf8' });
      const result = JSON.parse(readFileSync(resultPath, 'utf8'));
      assert.equal(result.reward, reward);
      assert.deepEqual(JSON.parse(stdout), result);
    }
    const invalid = spawnSync(process.execPath, [join(LIB, 'grade_review.mts')], { encoding: 'utf8' });
    assert.ifError(invalid.error);
    assert.notEqual(invalid.status, 0);
    assert.match(invalid.stderr, /Usage:/);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});
