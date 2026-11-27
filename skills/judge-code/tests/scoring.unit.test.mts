import assert from 'node:assert/strict';
import test from 'node:test';
import { formatLinterOutput } from '../scripts/cli/format-report.mts';
import { formatScore } from '../scripts/cli/format-summary.mts';
import { adaptCliChecks } from '../scripts/engine/cli-backend.mts';
import { parseRetryAfterMs, readAnswers } from '../scripts/engine/openrouter.mts';
import { findingSeverity } from '../scripts/engine/scoring.mts';
import { ERROR_SCORE_THRESHOLD, type JudgeResult } from '../scripts/engine/types.mts';
import { EXIT_ERROR, EXIT_FINDINGS, EXIT_OK, exitCodeForResult } from '../scripts/judge-code.mts';
import { parsePassThreshold } from '../scripts/rubrics/loader.mts';
import { PASS_THRESHOLD } from '../scripts/rubrics/types.mts';

function makeDecisionAnswer(passProb: number) {
  return {
    type: 'choice',
    choice: passProb >= 0.5 ? 'pass' : 'fail',
    probabilities: { pass: passProb, fail: Number((1 - passProb).toFixed(4)) },
  };
}

function makeWarningOnlyResult(): JudgeResult {
  return {
    status: 'scored',
    backend: 'openrouter',
    mode: 'file',
    file_count: 1,
    elapsed_ms: 120,
    requested_model: 'typesafe/jev-1.14',
    returned_model: 'typesafe/jev-1.14',
    rubric: 'readability-v2',
    rubric_groups: { readability: ['direct_readability'] },
    pass_threshold: 80,
    quality: {
      pass_rate: 0,
      all_files_pass_rate: 0,
      checks: {
        direct_readability: {
          choice: 'fail',
          severity: 'warning',
          files_passed: 0,
          files_total: 1,
          files_warnings: 1,
          score: 79.6,
          min_score: 79.6,
        },
      },
    },
    file_results: [
      {
        file: 'edge.ts',
        status: 'scored',
        returned_model: 'typesafe/jev-1.14',
        elapsed_ms: 120,
        pass_rate: 0,
        checks: {
          direct_readability: {
            choice: 'fail',
            severity: 'warning',
            model_choice: 'pass',
            score: 79.6,
          },
        },
      },
    ],
  };
}

test('readAnswers maps probabilities across 60 and 80 severity cutoffs without emitting legacy fields', () => {
  const question = { type: 'choice' as const, instructions: 'Q', criteria: { pass: 'Y', fail: 'N' } };
  const cases = [
    { id: 'rule_80_at_50', prob: 0.5, threshold: 0.8, choice: 'fail', severity: 'error', score: 50 },
    { id: 'rule_80_at_59', prob: 0.59, threshold: 0.8, choice: 'fail', severity: 'error', score: 59 },
    { id: 'rule_80_at_59_6', prob: 0.5961, threshold: 0.8, choice: 'fail', severity: 'error', score: 59.6 },
    { id: 'rule_80_at_60', prob: 0.6, threshold: 0.8, choice: 'fail', severity: 'warning', score: 60 },
    { id: 'rule_60_at_60', prob: 0.6, threshold: 0.6, choice: 'pass', severity: undefined, score: 60 },
    { id: 'rule_60_at_59_6', prob: 0.5961, threshold: 0.6, choice: 'fail', severity: 'error', score: 59.6 },
    { id: 'rule_80_at_79_6', prob: 0.7961, threshold: 0.8, choice: 'fail', severity: 'warning', score: 79.6 },
    { id: 'rule_80_at_80', prob: 0.8, threshold: 0.8, choice: 'pass', severity: undefined, score: 80 },
  ] as const;

  const questions = Object.fromEntries(cases.map((c) => [c.id, question]));
  const thresholds = Object.fromEntries(cases.map((c) => [c.id, c.threshold]));
  const answers = Object.fromEntries(cases.map((c) => [c.id, makeDecisionAnswer(c.prob)]));

  const { checks } = readAnswers({ model: 'mock', answers }, questions, thresholds);

  assert.equal(ERROR_SCORE_THRESHOLD, 60);
  for (const c of cases) {
    assert.equal(checks[c.id].choice, c.choice);
    assert.equal(checks[c.id].severity, c.severity);
    assert.equal(checks[c.id].score, c.score);
    assert.equal('confidence' in checks[c.id], false);
    assert.equal('pass_probability' in checks[c.id], false);
  }
  assert.equal(checks.rule_60_at_60.pass_threshold, 60);
});

test('findingSeverity classifies failing checks below 60 as error and 60+ as warning', () => {
  assert.equal(findingSeverity({ choice: 'fail', model_choice: 'pass', score: 50 }), 'error');
  assert.equal(findingSeverity({ choice: 'fail', model_choice: 'pass', score: 59 }), 'error');
  assert.equal(findingSeverity({ choice: 'fail', model_choice: 'pass', score: 60 }), 'warning');
  assert.equal(findingSeverity({ choice: 'pass', model_choice: 'pass', score: 92 }), null);
});

test('formatScore prevents scores strictly below error or pass thresholds from rounding up to the boundary', () => {
  assert.equal(formatScore(59.6, 80), '59.6');
  assert.equal(formatScore(59.6, 60), '59.6');
  assert.equal(formatScore(79.6, 80), '79.6');
  assert.equal(formatScore(80, 80), '80');
});

test('formatLinterOutput renders sub-threshold decimal scores without rounding them up to passing labels', () => {
  const result: JudgeResult = {
    ...makeWarningOnlyResult(),
    rubric_groups: { readability: ['direct_readability', 'named_domain_expressions'] },
    check_thresholds: { named_domain_expressions: 60 },
    file_results: [
      {
        file: 'edge.ts',
        status: 'scored',
        returned_model: 'typesafe/jev-1.14',
        elapsed_ms: 120,
        pass_rate: 0,
        checks: {
          direct_readability: { choice: 'fail', severity: 'warning', model_choice: 'pass', score: 79.6 },
          named_domain_expressions: {
            choice: 'fail',
            severity: 'error',
            model_choice: 'pass',
            score: 59.6,
            pass_threshold: 60,
          },
        },
      },
    ],
  };

  const formatted = formatLinterOutput(result);

  assert.match(
    formatted,
    /edge\.ts\n\s+error\s+named_domain_expressions\s+\(score 59\.6\/100, pass >= 60\)\n\s+warning\s+direct_readability\s+\(score 79\.6\/100, pass >= 80\)/,
  );
  assert.doesNotMatch(formatted, /score 60\/100, pass >= 60/);
  assert.doesNotMatch(formatted, /score 80\/100, pass >= 80/);
});

test('formatLinterOutput skips Rule criteria legend cleanly when a check is missing from rubric metadata', () => {
  const result: JudgeResult = {
    status: 'scored',
    backend: 'openrouter',
    mode: 'code',
    target: 'booking',
    file_count: 1,
    elapsed_ms: 50,
    requested_model: 'liquid/d1.2-ultra',
    returned_model: 'liquid/d1.2-ultra',
    rubric: 'readability-v2+repo-conventions',
    rubric_groups: { readability: ['direct_readability'], conventions: ['follows_repo_conventions'] },
    pass_threshold: 80,
    quality: {
      pass_rate: 0.5,
      checks: {
        follows_repo_conventions: { choice: 'fail', severity: 'error', model_choice: 'fail', score: 25 },
      },
    },
  };

  const output = formatLinterOutput(result, { rubric: { questions: {} } });

  assert.match(output, /follows_repo_conventions\s+\(score 25\/100, pass >= 80\)/);
  assert.doesNotMatch(output, /Rule criteria:/);
});

test('exitCodeForResult returns 0, 1, or 2 according to errors, warning budgets, and run status', () => {
  const warningOnly = makeWarningOnlyResult();

  assert.equal(EXIT_OK, 0);
  assert.equal(EXIT_FINDINGS, 1);
  assert.equal(EXIT_ERROR, 2);
  assert.equal(exitCodeForResult(warningOnly), EXIT_OK);
  assert.equal(exitCodeForResult(warningOnly, { failOnWarning: true }), EXIT_FINDINGS);
  assert.equal(exitCodeForResult(warningOnly, { maxWarnings: 1 }), EXIT_OK);
  assert.equal(exitCodeForResult(warningOnly, { maxWarnings: 0 }), EXIT_FINDINGS);
  assert.equal(
    exitCodeForResult({ ...warningOnly, status: 'error', quality: null, error: 'HTTP 400' }),
    EXIT_ERROR,
  );
});

test('adaptCliChecks maps integer 0-100 CLI scores against per-criterion thresholds', () => {
  const adapted = adaptCliChecks(
    {
      checks: [
        { id: 'err_59', note: 'Serious flaw.', score: 59 },
        { id: 'warn_60', note: 'Below 80.', score: 60 },
        { id: 'warn_79', note: 'Just under 80.', score: 79 },
        { id: 'pass_80', note: 'Solid.', score: 80 },
        { id: 'cal_pass_60', note: 'Acceptable for 60 bar.', score: 60 },
        { id: 'cal_err_59', note: 'Fails 60 bar.', score: 59 },
        { id: 'cal_warn_65', note: 'Below 70 bar.', score: 65 },
      ],
    },
    ['err_59', 'warn_60', 'warn_79', 'pass_80', 'cal_pass_60', 'cal_err_59', 'cal_warn_65'],
    { err_59: 0.8, warn_60: 0.8, warn_79: 0.8, pass_80: 0.8, cal_pass_60: 0.6, cal_err_59: 0.6, cal_warn_65: 0.7 },
  );

  assert.deepEqual(adapted, {
    err_59: { choice: 'fail', severity: 'error', score: 59, note: 'Serious flaw.' },
    warn_60: { choice: 'fail', severity: 'warning', score: 60, note: 'Below 80.' },
    warn_79: { choice: 'fail', severity: 'warning', score: 79, note: 'Just under 80.' },
    pass_80: { choice: 'pass', score: 80, note: 'Solid.' },
    cal_pass_60: { choice: 'pass', score: 60, pass_threshold: 60, note: 'Acceptable for 60 bar.' },
    cal_err_59: { choice: 'fail', severity: 'error', score: 59, pass_threshold: 60, note: 'Fails 60 bar.' },
    cal_warn_65: { choice: 'fail', severity: 'warning', score: 65, pass_threshold: 70, note: 'Below 70 bar.' },
  });
});

test('adaptCliChecks rejects non-integer or out-of-range scores', () => {
  assert.throws(
    () => adaptCliChecks({ checks: [{ id: 'a', note: 'x', score: 75.5 }] }, ['a']),
    /Invalid score for a/,
  );
  assert.throws(
    () => adaptCliChecks({ checks: [{ id: 'a', note: 'x', score: 101 }] }, ['a']),
    /Invalid score for a/,
  );
});

test('parseRetryAfterMs parses delta-seconds, HTTP dates, caps, and rejects invalid headers', () => {
  const nowMs = Date.parse('2026-11-25T00:00:00Z');

  assert.equal(parseRetryAfterMs('5', nowMs), 5_000);
  assert.equal(parseRetryAfterMs('180', nowMs, 60_000), 60_000);
  assert.equal(parseRetryAfterMs('Wed, 25 Nov 2026 00:00:12 GMT', nowMs), 12_000);
  assert.equal(parseRetryAfterMs('invalid', nowMs), null);
});

test('parsePassThreshold defaults to 0.8 and rejects values outside (0, 1]', () => {
  assert.equal(PASS_THRESHOLD, 0.8);
  assert.equal(parsePassThreshold(undefined, 'ok'), 0.8);
  assert.throws(() => parsePassThreshold(0, 'bad'), /Invalid pass_threshold/);
  assert.throws(() => parsePassThreshold(1.2, 'bad'), /Invalid pass_threshold/);
});
