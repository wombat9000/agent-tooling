/** Offline tests for scorecard schema, content hashing, staleness, recording, Markdown, and HTML. */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  buildScorecardSnapshot,
  discoverHarborTasks,
  loadAllScorecards,
} from './scorecard_discovery.mts';
import {
  computeRubricHash,
  computeSkillHash,
  computeTaskHash,
  evaluateStaleness,
  resolveGitRef,
} from './scorecard_hashes.mts';
import { renderScorecardHtml, writeScorecardHtml } from './scorecard_html.mts';
import { renderScorecardMarkdown } from './scorecard_markdown.mts';
import { recordJudgeBatches } from './scorecard_record.mts';
import {
  SCORECARD_SCHEMA_VERSION,
  formatTaskScorecardJson,
  validateTaskScorecard,
  type ScorecardEntry,
  type TaskScorecard,
} from './scorecard_schema.mts';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));

function tempDir(t: TestContext, prefix = 'scorecard-test-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function sampleEntry(overrides: Partial<ScorecardEntry> = {}): ScorecardEntry {
  return {
    recorded_at: '2026-11-24',
    agent_model: 'openai/gpt-6.1-terra',
    judge_model: 'liquid/d1.2-ultra',
    scope: 'whole',
    rubric: 'demo-rubric-v1',
    rubric_groups: { 'facet-a': ['check_one', 'check_two'] },
    trials: { total: 3, scored: 3, errored: 0 },
    deterministic: {
      passed: 3,
      total: 3,
      pass_rate: 1,
      metrics: { contract_tests_pass: { passed: 3, total: 3, pass_rate: 1 } },
    },
    quality: {
      pass_rate: 0.8333,
      mean_pass_probability: 0.88,
      checks: {
        check_one: { passed: 3, total: 3, pass_rate: 1, mean_pass_probability: 0.96 },
        check_two: { passed: 2, total: 3, pass_rate: 0.6667, mean_pass_probability: 0.8 },
      },
    },
    hashes: {
      skill_hash: 'aaaaaaaaaaaa',
      task_hash: 'bbbbbbbbbbbb',
      rubric_hash: 'cccccccccccc',
    },
    source: { git_ref: '8916d62' },
    ...overrides,
  };
}

test('all checked-in evals/scorecards/**/*.json files pass strict schema validation and canonical formatting', () => {
  const scorecards = loadAllScorecards(ROOT);
  for (const sc of scorecards) {
    const filePath = join(ROOT, 'evals/scorecards', sc.skill, `${sc.task}.json`);
    const rawText = readFileSync(filePath, 'utf8');
    assert.equal(rawText, formatTaskScorecardJson(sc), `${filePath} must use canonical deterministic formatting`);
    assert.ok(!/\/Users\/|\/home\//.test(rawText), `${filePath} must not contain local absolute paths`);
    assert.ok(
      !/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(rawText),
      `${filePath} must not contain random UUIDs`,
    );
  }
});

test('validateTaskScorecard rejects malformed entries, non-null baseline skill_hash, paths, and UUIDs', () => {
  const valid: TaskScorecard = {
    schema_version: SCORECARD_SCHEMA_VERSION,
    skill: 'code-change',
    task: 'demo-task',
    entries: {
      baseline: {
        production_code: sampleEntry({
          hashes: { skill_hash: null, task_hash: 'bbbbbbbbbbbb', rubric_hash: 'cccccccccccc' },
        }),
      },
      skill: {
        production_code: sampleEntry(),
      },
    },
  };
  const parsed = validateTaskScorecard(valid);
  assert.equal(parsed.entries.baseline?.production_code?.hashes.skill_hash, null);

  assert.throws(() => validateTaskScorecard({ ...valid, schema_version: 2 }), /schema_version/);
  assert.throws(() => validateTaskScorecard({
    ...valid,
    entries: {
      baseline: { production_code: sampleEntry() }, // non-null skill_hash on baseline
    },
  }), /skill_hash must be null/);
  assert.throws(() => validateTaskScorecard({
    ...valid,
    entries: {
      skill: { production_code: sampleEntry({ hashes: { skill_hash: null, task_hash: 'bbbbbbbbbbbb', rubric_hash: 'cccccccccccc' } }) },
    },
  }), /skill_hash/);
  assert.throws(() => validateTaskScorecard({
    ...valid,
    entries: {
      skill: { production_code: sampleEntry({ recorded_at: '2026-11-24T12:00:00Z' }) },
    },
  }), /YYYY-MM-DD/);
  assert.throws(() => validateTaskScorecard({
    ...valid,
    entries: {
      skill: { production_code: sampleEntry({ agent_model: '/Users/dev/local-model' }) },
    },
  }), /local absolute file paths/);
  assert.throws(() => validateTaskScorecard({
    ...valid,
    entries: {
      skill: { production_code: sampleEntry({ rubric: 'rubric-0f2bd5ab-3df8-43d4-a653-9c79eb052c81' }) },
    },
  }), /UUID/);
});

test('working-tree content hashes match git HEAD hashes and ignore excluded files', (t) => {
  const { full: headSha } = resolveGitRef(ROOT, 'HEAD');
  assert.equal(
    computeSkillHash(ROOT, 'code-change'),
    computeSkillHash(ROOT, 'code-change', headSha),
    'skill_hash must match between working tree and HEAD',
  );

  const tasks = discoverHarborTasks(ROOT, 'code-change');
  assert.ok(tasks.length >= 6);
  for (const task of tasks) {
    assert.equal(
      computeTaskHash(ROOT, 'code-change', task),
      computeTaskHash(ROOT, 'code-change', task, headSha),
      `task_hash for ${task} must match HEAD`,
    );
    const primaryTarget = task === 'canary' || task === 'review-seeded-bug' ? 'review' : 'production_code';
    assert.equal(
      computeRubricHash(ROOT, 'code-change', task, primaryTarget),
      computeRubricHash(ROOT, 'code-change', task, primaryTarget, headSha),
      `rubric_hash for ${task} (${primaryTarget}) must match HEAD`,
    );
    if (primaryTarget === 'production_code') {
      assert.equal(
        computeRubricHash(ROOT, 'code-change', task, 'test_code'),
        computeRubricHash(ROOT, 'code-change', task, 'test_code', headSha),
        `rubric_hash for ${task} (test_code) must match HEAD`,
      );
    }
  }

  // Excluded files (.DS_Store, tests/grade_review.mts, build/, node_modules/) do not change hashes.
  const tmpRepo = tempDir(t, 'hash-exclude-');
  mkdirSync(join(tmpRepo, 'skills/demo'), { recursive: true });
  mkdirSync(join(tmpRepo, 'evals/demo/tasks/task-a/tests'), { recursive: true });
  writeFileSync(join(tmpRepo, 'skills/demo/SKILL.md'), '# demo\n');
  writeFileSync(join(tmpRepo, 'evals/demo/tasks/task-a/instruction.md'), '# task\n');

  const skillHashBefore = computeSkillHash(tmpRepo, 'demo');
  const taskHashBefore = computeTaskHash(tmpRepo, 'demo', 'task-a');

  writeFileSync(join(tmpRepo, 'skills/demo/.DS_Store'), 'junk');
  mkdirSync(join(tmpRepo, 'skills/demo/node_modules/pkg'), { recursive: true });
  writeFileSync(join(tmpRepo, 'skills/demo/node_modules/pkg/index.js'), 'x');
  writeFileSync(join(tmpRepo, 'evals/demo/tasks/task-a/tests/grade_review.mts'), '// staged');
  mkdirSync(join(tmpRepo, 'evals/demo/tasks/task-a/build'), { recursive: true });
  writeFileSync(join(tmpRepo, 'evals/demo/tasks/task-a/build/out.jar'), 'jar');

  assert.equal(computeSkillHash(tmpRepo, 'demo'), skillHashBefore);
  assert.equal(computeTaskHash(tmpRepo, 'demo', 'task-a'), taskHashBefore);

  // Rubric hashing falls back to skills/judge-code/rubrics/ and strips question scope metadata.
  const rubricRepo = tempDir(t, 'hash-rubric-scope-');
  mkdirSync(join(rubricRepo, 'evals/demo/tasks/task-a/tests'), { recursive: true });
  mkdirSync(join(rubricRepo, 'skills/judge-code/rubrics'), { recursive: true });
  writeFileSync(join(rubricRepo, 'evals/demo/tasks/task-a/tests/judge.json'), JSON.stringify({ extends: ['readability'] }));
  const baseRubric = {
    rubric: 'readability-v2',
    target: 'production_code',
    questions: {
      direct_readability: {
        type: 'choice',
        instructions: 'Readable?',
        criteria: { pass: 'Yes', fail: 'No' },
      },
    },
  };
  writeFileSync(join(rubricRepo, 'skills/judge-code/rubrics/readability.json'), JSON.stringify(baseRubric));
  const hashWithoutScope = computeRubricHash(rubricRepo, 'demo', 'task-a', 'production_code');
  assert.ok(hashWithoutScope);
  writeFileSync(join(rubricRepo, 'skills/judge-code/rubrics/readability.json'), JSON.stringify({
    ...baseRubric,
    questions: {
      direct_readability: {
        ...baseRubric.questions.direct_readability,
        scope: 'file',
      },
    },
  }));
  const hashWithScope = computeRubricHash(rubricRepo, 'demo', 'task-a', 'production_code');
  assert.equal(hashWithScope, hashWithoutScope);
});

test('staleness detection ignores skill_hash on baseline entries and reports exact reasons on skill entries', () => {
  const current = {
    skill_hash: '111111111111',
    task_hash: '222222222222',
    rubric_hash: '333333333333',
  };

  assert.deepEqual(
    evaluateStaleness('skill', { ...current }, current).status,
    'current',
  );
  assert.deepEqual(
    evaluateStaleness('skill', { ...current, skill_hash: '999999999999' }, current),
    { status: 'stale', reasons: ['skill'], currentHashes: current },
  );
  assert.deepEqual(
    evaluateStaleness('skill', { skill_hash: '111111111111', task_hash: '000000000000', rubric_hash: 'ffffffffffff' }, current),
    { status: 'stale', reasons: ['task', 'rubric'], currentHashes: current },
  );

  // Baseline entry stays CURRENT even when skill_hash changed!
  assert.deepEqual(
    evaluateStaleness(
      'baseline',
      { skill_hash: null, task_hash: '222222222222', rubric_hash: '333333333333' },
      { ...current, skill_hash: 'changedskill' },
    ),
    { status: 'current', reasons: [], currentHashes: { ...current, skill_hash: 'changedskill' } },
  );
  assert.deepEqual(
    evaluateStaleness(
      'baseline',
      { skill_hash: null, task_hash: '222222222222', rubric_hash: 'oldrubric000' },
      current,
    ),
    { status: 'stale', reasons: ['rubric'], currentHashes: current },
  );
});

test('recordJudgeBatches merges conditions/targets, resolves relocated archives, strips paths/UUIDs, and validates rubric provenance', (t) => {
  const repo = tempDir(t, 'scorecard-repo-');
  mkdirSync(join(repo, 'skills/demo'), { recursive: true });
  writeFileSync(join(repo, 'skills/demo/SKILL.md'), '# Demo skill\n');
  mkdirSync(join(repo, 'evals/demo/rubrics'), { recursive: true });
  writeFileSync(join(repo, 'evals/demo/rubrics/core.json'), JSON.stringify({
    rubric: 'core-v1',
    target: 'production_code',
    questions: {
      clean_code: { type: 'choice', instructions: 'Clean?', criteria: { pass: 'Yes', fail: 'No' } },
      modularity: { type: 'choice', instructions: 'Modular?', criteria: { pass: 'Yes', fail: 'No' } },
    },
  }));
  writeFileSync(join(repo, 'evals/demo/rubrics/testing-core.json'), JSON.stringify({
    rubric: 'testing-core-v1',
    target: 'test_code',
    questions: {
      independent_tests: { type: 'choice', instructions: 'Independent?', criteria: { pass: 'Yes', fail: 'No' } },
    },
  }));
  mkdirSync(join(repo, 'evals/demo/tasks/build-widget/tests'), { recursive: true });
  writeFileSync(join(repo, 'evals/demo/tasks/build-widget/task.toml'), 'version = "1"\n');
  writeFileSync(join(repo, 'evals/demo/tasks/build-widget/tests/judge.json'), JSON.stringify({ extends: ['core'] }));
  writeFileSync(join(repo, 'evals/demo/tasks/build-widget/tests/judge-tests.json'), JSON.stringify({ extends: ['testing-core'] }));

  // Build an archived-style directory where summary.json contains stale original absolute paths.
  const archive = tempDir(t, 'scorecard-archive-');
  const makeBatch = (
    runFolder: string,
    agentSkills: string[],
    target: 'production_code' | 'test_code',
    rubric: string,
    groups: Record<string, string[]>,
    checksPerTrial: Array<Record<string, { choice: 'pass' | 'fail'; pass_probability: number; confidence: number }>>,
  ) => {
    const harborDir = join(archive, 'eval-results/harbor', runFolder);
    mkdirSync(harborDir, { recursive: true });
    writeFileSync(join(harborDir, 'config.json'), JSON.stringify({
      agents: [{ name: 'codex', model_name: 'openai/gpt-6.1-terra', skills: agentSkills }],
    }));
    writeFileSync(join(harborDir, 'result.json'), JSON.stringify({ finished_at: '2026-11-24T15:00:00Z' }));

    const batchDir = join(archive, 'eval-results/judges', runFolder, `batch-${target}`);
    mkdirSync(batchDir, { recursive: true });
    const reports = checksPerTrial.map((checks, idx) => {
      const trial = `build-widget__t${idx + 1}`;
      const tDir = join(batchDir, trial);
      mkdirSync(tDir, { recursive: true });
      const vals = Object.values(checks);
      const passRate = vals.filter((c) => c.choice === 'pass').length / vals.length;
      writeFileSync(join(tDir, 'result.json'), JSON.stringify({
        status: 'scored',
        target,
        scope: 'whole',
        requested_model: 'liquid/d1.2-ultra',
        returned_model: 'liquid/d1.2-ultra-snap',
        rubric,
        rubric_groups: groups,
        deterministic: { reward: 1, contract_tests_pass: 1 },
        quality: { pass_rate: passRate, checks },
      }));
      return {
        trial,
        task: 'build-widget',
        target,
        status: 'scored',
        // Intentionally point to a nonexistent original worktree to test archive fallback!
        result_dir: `/Users/nonexistent/old-worktree/eval-results/judges/${runFolder}/${trial}`,
        quality_pass_rate: passRate,
      };
    });
    writeFileSync(join(batchDir, 'summary.json'), JSON.stringify({
      source_run: `/Users/nonexistent/old-worktree/eval-results/harbor/${runFolder}`,
      model: 'liquid/d1.2-ultra',
      scope: 'whole',
      ...(target === 'test_code' ? { target: 'test_code' } : {}),
      reports,
    }));
    return batchDir;
  };

  const baseProd = makeBatch(
    'run-baseline-11111111-2222-3333-4444-555555555555',
    [],
    'production_code',
    'core-v1',
    { core: ['clean_code', 'modularity'] },
    [
      {
        clean_code: { choice: 'pass', pass_probability: 0.9, confidence: 0.9 },
        modularity: { choice: 'fail', pass_probability: 0.2, confidence: 0.8 },
      },
      {
        clean_code: { choice: 'pass', pass_probability: 0.8, confidence: 0.85 },
        modularity: { choice: 'fail', pass_probability: 0.3, confidence: 0.8 },
      },
    ],
  );
  const skillProd = makeBatch(
    'run-skill-11111111-2222-3333-4444-555555555555',
    ['/skills/demo'],
    'production_code',
    'core-v1',
    { core: ['clean_code', 'modularity'] },
    [
      {
        clean_code: { choice: 'pass', pass_probability: 0.95, confidence: 0.95 },
        modularity: { choice: 'pass', pass_probability: 0.9, confidence: 0.9 },
      },
      {
        clean_code: { choice: 'pass', pass_probability: 0.95, confidence: 0.95 },
        modularity: { choice: 'pass', pass_probability: 0.85, confidence: 0.9 },
      },
    ],
  );
  const skillTests = makeBatch(
    'run-skill-11111111-2222-3333-4444-555555555555',
    ['/skills/demo'],
    'test_code',
    'testing-core-v1',
    { 'testing-core': ['independent_tests'] },
    [
      { independent_tests: { choice: 'pass', pass_probability: 0.92, confidence: 0.9 } },
      { independent_tests: { choice: 'pass', pass_probability: 0.96, confidence: 0.95 } },
    ],
  );

  // Dry-run does not write any scorecard file.
  const dry = recordJudgeBatches({ repoRoot: repo, judgeDirs: [baseProd], skill: 'demo', dryRun: true });
  assert.equal(dry.length, 1);
  assert.equal(existsSync(join(repo, 'evals/scorecards/demo/build-widget.json')), false);

  // Record baseline prod, then skill prod + skill tests; verify merge preserves all entries.
  recordJudgeBatches({ repoRoot: repo, judgeDirs: [baseProd], skill: 'demo' });
  recordJudgeBatches({ repoRoot: repo, judgeDirs: [skillProd, skillTests], skill: 'demo' });

  const outFile = join(repo, 'evals/scorecards/demo/build-widget.json');
  const raw = readFileSync(outFile, 'utf8');
  assert.ok(!raw.includes('/Users/'), 'must never leak local paths');
  assert.ok(!raw.includes('11111111-2222-3333-4444-555555555555'), 'must never leak Harbor UUIDs');

  const parsed = validateTaskScorecard(JSON.parse(raw));
  assert.equal(parsed.entries.baseline?.production_code?.quality.pass_rate, 0.5);
  assert.equal(parsed.entries.baseline?.production_code?.hashes.skill_hash, null);
  assert.equal(parsed.entries.skill?.production_code?.quality.pass_rate, 1);
  assert.equal(parsed.entries.skill?.test_code?.quality.pass_rate, 1);

  // Editing the skill marks skill entries stale while keeping baseline entry current!
  writeFileSync(join(repo, 'skills/demo/SKILL.md'), '# Demo skill v2\n');
  const snap = buildScorecardSnapshot(repo);
  const prodRow = snap.rows.find((r) => r.target === 'production_code')!;
  assert.equal(prodRow.baseline?.staleness.status, 'current');
  assert.equal(prodRow.skillEntry?.staleness.status, 'stale');
  assert.deepEqual(prodRow.skillEntry?.staleness.reasons, ['skill']);
  assert.equal(prodRow.liftPassRate, 0.5);

  // Markdown rendering is deterministic and includes Skill Coverage + Summary + collapsible details.
  const md1 = renderScorecardMarkdown(snap);
  const md2 = renderScorecardMarkdown(snap);
  assert.equal(md1, md2);
  assert.match(md1, /## Skill Coverage/);
  assert.match(md1, /## `demo` Eval Summary/);
  assert.match(md1, /\+50\.0pp/);
  assert.match(md1, /Skill: Stale \(skill\); Base: Current/);
  assert.match(md1, /<details>/);

  // HTML rendering succeeds and rejects non-.html output paths.
  const htmlOut = join(repo, 'eval-results/scorecard.html');
  writeScorecardHtml(repo, htmlOut);
  const html = readFileSync(htmlOut, 'utf8');
  assert.match(html, /Content-Security-Policy/);
  assert.match(html, /build-widget/);
  assert.match(html, /\+50\.0pp/);
  assert.throws(() => writeScorecardHtml(repo, join(repo, 'bad.json')), /end in \.html/);

  // Provenance mismatch check: changing rubric ID rejects recording against mismatched tree.
  writeFileSync(join(repo, 'evals/demo/rubrics/core.json'), JSON.stringify({
    rubric: 'core-v2',
    target: 'production_code',
    questions: {
      clean_code: { type: 'choice', instructions: 'Clean?', criteria: { pass: 'Yes', fail: 'No' } },
    },
  }));
  assert.throws(
    () => recordJudgeBatches({ repoRoot: repo, judgeDirs: [skillProd], skill: 'demo' }),
    /Provenance mismatch/,
  );
});

test('renderScorecardHtml escapes untrusted strings to prevent XSS', () => {
  const payload = '<script>alert("xss")</script>';
  const snapshot = {
    skills: [
      {
        skill: payload,
        hasHarborEvals: true,
        harborTasks: [payload],
        evaluatedTasks: [payload],
        hasUnitTests: false,
        unitTestFiles: [],
        coverageStatus: 'harbor_evals' as const,
      },
    ],
    scorecards: [],
    entries: [],
    rows: [
      {
        skill: payload,
        task: payload,
        target: 'review' as const,
        baseline: null,
        skillEntry: {
          skill: payload,
          task: payload,
          condition: 'skill' as const,
          target: 'review' as const,
          entry: sampleEntry({ agent_model: payload, judge_model: payload, rubric: payload }),
          staleness: {
            status: 'stale' as const,
            reasons: ['skill' as const],
            currentHashes: { skill_hash: '111111111111', task_hash: 'bbbbbbbbbbbb', rubric_hash: 'cccccccccccc' },
          },
        },
        liftPassRate: null,
        liftMeanProb: null,
      },
    ],
  };
  const html = renderScorecardHtml(snapshot);
  assert.ok(!html.includes('<script>alert("xss")</script>'));
  assert.ok(html.includes('&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;'));
});
