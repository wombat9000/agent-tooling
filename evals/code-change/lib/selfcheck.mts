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
import { parseRubric, parseSharedRubric, parseTestRubric, taskSourceRoot, taskTestRoot } from './judge_review.mts';

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

test('each task has valid wiring, and review tasks pass reference and fail missing reports', () => {
  const tasks = readdirSync(TASKS).filter((task) => existsSync(join(TASKS, task, 'task.toml'))).sort();
  assert.ok(tasks.length);
  for (const task of tasks) {
    const dir = join(TASKS, task);
    assert.ok(existsSync(join(dir, 'tests/test.sh')), `${task}: missing tests/test.sh`);
    assert.ok(existsSync(join(dir, 'tests/judge.json')), `${task}: missing tests/judge.json`);
    const rubric = parseRubric(dir, '');
    assert.ok(Object.keys(rubric.questions).length > 0, `${task}: invalid tests/judge.json`);
    if (rubric.target === 'production_code') {
      assert.ok(taskSourceRoot(dir), `${task}: invalid source_root in tests/judge.json`);
      assert.ok(existsSync(join(dir, 'tests/judge-tests.json')), `${task}: missing tests/judge-tests.json`);
      assert.ok(taskTestRoot(dir), `${task}: invalid test_source_root`);
      const testRubric = parseTestRubric(dir, '');
      assert.equal(testRubric.target, 'test_code', `${task}: test rubric must target test_code`);
      assert.ok(Object.keys(testRubric.questions).length > 0, `${task}: invalid test rubric`);
    }
    assert.ok(existsSync(join(dir, 'solution/solve.sh')), `${task}: missing solution/solve.sh`);
    if (existsSync(join(dir, 'tests/expected.json'))) {
      assert.equal(grade(referenceReport(task), expected(task)).reward, 1, task);
      assert.ok(Object.values(grade(null, expected(task))).every((score) => score === 0), task);
    }
  }
});

test('shared rubrics under rubrics/ parse cleanly without overlapping question IDs per target', () => {
  const rubricsDir = join(LIB, '../../../rubrics');
  const allSlugs = readdirSync(rubricsDir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => name.slice(0, -'.json'.length))
    .sort();
  assert.ok(allSlugs.length >= 13, `Expected at least 13 shared rubrics in rubrics/, found ${allSlugs.length}`);

  const seenByTarget = new Map<string, Map<string, string>>();
  for (const slug of allSlugs) {
    const parsed = parseSharedRubric(slug);
    const seen = seenByTarget.get(parsed.target) ?? new Map<string, string>();
    seenByTarget.set(parsed.target, seen);
    for (const id of Object.keys(parsed.questions)) {
      assert.equal(seen.get(id), undefined, `Overlapping question ID ${id} in ${seen.get(id)} and ${slug}`);
      seen.set(id, slug);
    }
  }
  for (const [slug, minCount] of [
    ['testing-core', 4],
    ['testing-unit', 2],
    ['testing-integration', 4],
    ['testing-e2e', 3],
  ] as const) {
    const parsed = parseSharedRubric(slug);
    assert.equal(parsed.target, 'test_code', `${slug} must target test_code`);
    assert.ok(Object.keys(parsed.questions).length >= minCount, `${slug} question count`);
  }
});

test('lowering the seeded bug severity fails', () => {
  const report = referenceReport('review-seeded-bug').replace('### Blocking', '### Optional');
  assert.equal(grade(report, expected('review-seeded-bug')).severity, 0);
});

test('an invented finding above Optional fails restraint grading', () => {
  const cleanExpected = { verdicts: ['ready'], must_find: [], max_unmatched_severity: 'Optional' };
  const report = [
    'Verdict: ready',
    '',
    '### Should fix — Thresholds should be configurable',
    '- Location: src/main/kotlin/shop/ShippingPolicy.kt:12',
    '- Category: design',
    '- Evidence: hypothesis — may change later',
    '',
    'Checks run: traced diff',
    'Not assessed: none',
  ].join('\n');
  const scores = grade(report, cleanExpected);
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

test('Unicode letters do not end verdict words or guideline IDs, and TU/TI testing IDs are recognized', () => {
  const clean = 'Verdict: readyé\n\nChecks run: traced diff\nNot assessed: none\n';
  assert.equal(grade(clean, { verdicts: ['ready'], must_find: [] }).verdict, 0);
  const canary = referenceReport('canary').replaceAll('M3', 'éM3').replaceAll('T2', 'T2é');
  assert.equal(grade(canary, expected('canary')).guideline, 0);
  for (const id of ['TU1', 'TI2', 'TE1']) {
    const withTierId = referenceReport('canary').replaceAll('M3', 'éM3').replaceAll('T2', id);
    assert.equal(grade(withTierId, expected('canary')).guideline, 1, id);
  }
});

test('CLI writes reward.json and stdout for present and missing reports; bad arguments fail', () => {
  const out = mkdtempSync(join(tmpdir(), 'code-change-cli-'));
  try {
    const report = join(out, 'REVIEW.md');
    writeFileSync(report, referenceReport('review-seeded-bug'));
    for (const [path, reward] of [[report, 1], [join(out, 'missing.md'), 0]] as const) {
      const resultPath = join(out, 'nested/reward.json');
      const stdout = execFileSync(process.execPath, [join(LIB, 'grade_review.mts'),
        '--report', path, '--expected', join(TASKS, 'review-seeded-bug/tests/expected.json'),
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
