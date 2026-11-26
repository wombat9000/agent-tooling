/** Offline unit & integration tests for rubrics/scan.mts and rubrics/dashboard.mts. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  buildDashboardModel,
  generateDashboard,
  renderDashboardHtml,
} from './dashboard.mts';
import {
  discoverRepoModules,
  formatScanSummary,
  loadScannerConfig,
  runScanner,
} from './scan.mts';
import {
  classifyCheckFailure,
  computeHashesDigest,
  loadRubricCatalog,
  type LoadedSnapshotRecord,
  type RepoSnapshot,
  type RubricFixturesSnapshot,
} from './snapshot.mts';
import { AUTHORITATIVE_RUBRICS_DIR } from './sync.mts';

const SCAN_CLI = fileURLToPath(new URL('./scan.mts', import.meta.url));
const DASHBOARD_CLI = fileURLToPath(new URL('./dashboard.mts', import.meta.url));

function makeTempDir(t: TestContext, prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function runGit(cwd: string, args: string[]): string {
  const proc = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.ifError(proc.error);
  assert.equal(proc.status, 0, `git ${args.join(' ')} failed: ${proc.stderr}`);
  return proc.stdout.trim();
}

function createSyntheticGitRepo(
  root: string,
  name: string,
  files: Record<string, string>,
  installedRef?: string,
): { repoPath: string; commit: string } {
  const repoPath = join(root, name);
  mkdirSync(repoPath, { recursive: true });
  runGit(repoPath, ['init', '-b', 'main']);
  runGit(repoPath, ['config', 'user.email', 'test@example.com']);
  runGit(repoPath, ['config', 'user.name', 'Test User']);

  for (const [relPath, content] of Object.entries(files)) {
    const full = join(repoPath, relPath);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, content, 'utf8');
  }
  if (installedRef !== undefined) {
    writeFileSync(
      join(repoPath, 'skills-lock.json'),
      JSON.stringify({
        version: 2,
        skills: {
          'judge-code': {
            source: 'wombat9000/agent-tooling',
            ref: installedRef,
            sourceType: 'github',
            skillPath: 'skills/judge-code/SKILL.md',
            computedHash: 'abcdef0123456789abcdef0123456789',
          },
        },
      }, null, 2),
      'utf8',
    );
  }
  runGit(repoPath, ['add', '.']);
  runGit(repoPath, ['commit', '-m', 'Initial synthetic commit']);
  const commit = runGit(repoPath, ['rev-parse', 'HEAD']);
  return { repoPath, commit };
}

function makeMockOpenRouterTransport(
  scoreFn?: (body: { model: string; state: Record<string, unknown>; questions: Record<string, unknown> }) => Record<string, { choice: 'pass' | 'fail'; pass: number }>,
): { calls: number; transport: typeof fetch } {
  const state = {
    calls: 0,
    transport: (async (_url: unknown, init?: RequestInit) => {
      state.calls += 1;
      const body = JSON.parse(String(init?.body)) as {
        model: string;
        state: Record<string, unknown>;
        questions: Record<string, unknown>;
      };
      const custom = scoreFn ? scoreFn(body) : {};
      const answers = Object.fromEntries(
        Object.keys(body.questions).map((id) => {
          const override = custom[id];
          const pass = override ? override.pass : 0.92;
          const choice = override ? override.choice : (pass >= 0.5 ? 'pass' : 'fail');
          return [id, {
            type: 'choice',
            choice,
            probabilities: { pass, fail: Number((1 - pass).toFixed(4)) },
            confidence: 0.9,
          }];
        }),
      );
      return Response.json({
        model: `${body.model}-mock`,
        answers,
        usage: { cost: 0.00025, input_tokens: 400 },
      });
    }) as typeof fetch,
  };
  return state;
}

test('loadScannerConfig validates schema and rejects malformed or unsafe configs', (t) => {
  const root = makeTempDir(t, 'scan-config-test-');
  const repoDir = join(root, 'sample-repo');
  mkdirSync(join(repoDir, 'src'), { recursive: true });
  writeFileSync(join(repoDir, 'src/index.ts'), 'export const ok = true;\n');

  const writeCfg = (file: string, data: unknown): string => {
    const p = join(root, file);
    writeFileSync(p, typeof data === 'string' ? data : JSON.stringify(data));
    return p;
  };

  // Valid config resolves cleanly with sensible defaults
  const validPath = writeCfg('valid.json', {
    dataDir: './data',
    repos: [
      {
        name: 'sample-app',
        path: repoDir,
        sources: ['src'],
        modes: ['file', 'structure'],
      },
    ],
  });
  const valid = loadScannerConfig(validPath);
  assert.equal(valid.out, join(root, 'data', 'index.html'));
  assert.equal(valid.repos.length, 1);
  assert.equal(valid.repos[0].all, true);
  assert.equal(valid.repos[0].concurrency, 8);
  assert.equal(valid.fixtures.enabled, false);

  // Missing config file
  assert.throws(() => loadScannerConfig(join(root, 'missing.json')), /Config file not found/);
  // Invalid JSON
  assert.throws(() => loadScannerConfig(writeCfg('bad.json', '{not json')), /Invalid JSON/);
  // Non-HTML out
  assert.throws(
    () => loadScannerConfig(writeCfg('bad-out.json', { dataDir: './d', out: './d/index.txt', repos: [] })),
    /must end in \.html/,
  );
  // Path traversal in sources
  assert.throws(
    () => loadScannerConfig(writeCfg('escape.json', {
      dataDir: './d',
      repos: [{ name: 'bad', path: repoDir, sources: ['../sample-repo'], modes: ['file'] }],
    })),
    /escapes the repository root/,
  );
  // Unsupported mode
  assert.throws(
    () => loadScannerConfig(writeCfg('bad-mode.json', {
      dataDir: './d',
      repos: [{ name: 'bad', path: repoDir, sources: ['src'], modes: ['bogus'] }],
    })),
    /unsupported mode/,
  );
  // Invalid repo name
  assert.throws(
    () => loadScannerConfig(writeCfg('bad-name.json', {
      dataDir: './d',
      repos: [{ name: 'bad/name', path: repoDir, sources: ['src'], modes: ['file'] }],
    })),
    /may only contain/,
  );
  // Duplicate repo names
  assert.throws(
    () => loadScannerConfig(writeCfg('dup.json', {
      dataDir: './d',
      repos: [
        { name: 'dup', path: repoDir, sources: ['src'], modes: ['file'] },
        { name: 'dup', path: repoDir, sources: ['src'], modes: ['structure'] },
      ],
    })),
    /Duplicate repo name/,
  );
  // Invalid model ID
  assert.throws(
    () => loadScannerConfig(writeCfg('bad-model.json', {
      dataDir: './d',
      repos: [{ name: 'app', path: repoDir, sources: ['src'], modes: ['file'], model: 'not-a-model' }],
    })),
    /full OpenRouter model ID/,
  );
});

test('runScanner caches unchanged runs, re-runs on commit/rubric change or --force, and strips all source code from snapshots', async (t) => {
  const root = makeTempDir(t, 'scan-cache-test-');
  const sentinelSecretPhrase = 'UNIQUE_PROPRIETARY_SOURCE_SENTINEL_987654321';
  const { repoPath } = createSyntheticGitRepo(
    root,
    'demo-service',
    {
      'src/domain.ts': [
        `// ${sentinelSecretPhrase}`,
        'export function calculateTotal(items: readonly number[]): number {',
        '  return items.reduce((sum, price) => sum + price, 0);',
        '}',
        '',
      ].join('\n'),
    },
    'v1.2.1',
  );

  // Copy rubrics into temp dir so we can mutate one rubric hash safely during test
  const tempRubricsDir = join(root, 'rubrics');
  mkdirSync(tempRubricsDir, { recursive: true });
  cpSync(join(AUTHORITATIVE_RUBRICS_DIR, 'readability.json'), join(tempRubricsDir, 'readability.json'));
  cpSync(join(AUTHORITATIVE_RUBRICS_DIR, 'project-structure.json'), join(tempRubricsDir, 'project-structure.json'));

  const dataDir = join(root, 'dashboard-data');
  const configPath = join(root, 'config.json');
  writeFileSync(configPath, JSON.stringify({
    dataDir,
    repos: [
      {
        name: 'demo-service',
        path: repoPath,
        sources: ['src'],
        modes: ['file', 'structure'],
        all: true,
        rubrics: [],
        exclude: [],
        conventions: null,
        requirements: null,
        model: null,
        concurrency: 4,
      },
    ],
    fixtures: { enabled: false, repeats: 2 },
  }));

  const prevKey = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = 'sk-or-test-key-should-never-leak';
  t.after(() => {
    if (prevKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = prevKey;
  });

  // 1. Initial live scan with mocked transport (calibrated pass vs raw pass difference on direct_readability: 0.70 -> raw pass, calibrated fail at 0.80!)
  const mock1 = makeMockOpenRouterTransport(() => ({
    direct_readability: { choice: 'pass', pass: 0.7 },
    named_domain_expressions: { choice: 'pass', pass: 0.65 }, // threshold 0.60 -> calibrated pass!
  }));
  const config = loadScannerConfig(configPath);
  const run1 = await runScanner({
    config,
    rubricsDir: tempRubricsDir,
    transport: mock1.transport,
  });
  assert.equal(run1.errors.length, 0);
  assert.equal(run1.repo_outcomes.length, 2);
  assert.equal(run1.repo_outcomes[0].status, 'scanned');
  assert.equal(run1.repo_outcomes[1].status, 'scanned');
  assert.equal(mock1.calls, 2); // 1 file + 1 structure
  assert.ok(run1.total_cost_usd > 0);
  assert.ok(run1.dashboard_path && existsSync(run1.dashboard_path));

  // Verify calibrated vs raw pass rate distinction in file mode:
  // direct_readability: P=0.70 (thr 0.80 -> calibrated fail, raw pass)
  // named_domain_expressions: P=0.65 (thr 0.60 -> calibrated pass, raw pass)
  assert.equal(run1.repo_outcomes[0].calibrated_pass_rate, 0.5);
  assert.equal(run1.repo_outcomes[0].raw_pass_rate, 1.0);

  // Verify zero source code or credentials exist anywhere in <dataDir>/runs/*.json or index.html, and file mode is 0600
  const runsDir = join(dataDir, 'runs');
  const snapshotFiles = readdirSync(runsDir).filter((f) => f.endsWith('.json'));
  assert.equal(snapshotFiles.length, 2);
  for (const file of snapshotFiles) {
    const full = join(runsDir, file);
    const content = readFileSync(full, 'utf8');
    assert.ok(!content.includes(sentinelSecretPhrase), `Source sentinel leaked into ${file}`);
    assert.ok(!content.includes('calculateTotal'), `Source code leaked into ${file}`);
    assert.ok(!content.includes('sk-or-test-key'), `API key leaked into ${file}`);
    assert.equal(statSync(full).mode & 0o777, 0o600, `Expected 0600 permissions on ${file}`);
  }
  const html1 = readFileSync(run1.dashboard_path!, 'utf8');
  assert.ok(!html1.includes(sentinelSecretPhrase));
  assert.ok(!html1.includes('sk-or-test-key'));

  // 2. Second scan with same commit & same rubric hashes -> skipped (unchanged), $0 cost, 0 transport calls!
  const mock2 = makeMockOpenRouterTransport();
  const run2 = await runScanner({
    config,
    rubricsDir: tempRubricsDir,
    transport: mock2.transport,
  });
  assert.equal(mock2.calls, 0);
  assert.equal(run2.total_cost_usd, 0);
  assert.deepEqual(run2.repo_outcomes.map((o) => o.status), ['skipped', 'skipped']);
  assert.deepEqual(run2.repo_outcomes.map((o) => o.reason), ['unchanged', 'unchanged']);

  // 3. --force overrides cache and re-runs
  const mockForce = makeMockOpenRouterTransport();
  const runForce = await runScanner({
    config,
    force: true,
    rubricsDir: tempRubricsDir,
    transport: mockForce.transport,
  });
  assert.equal(mockForce.calls, 2);
  assert.deepEqual(runForce.repo_outcomes.map((o) => o.status), ['scanned', 'scanned']);

  // 4. Mutate readability.json (rubric hash changes) -> file mode re-runs, structure mode stays skipped!
  const readabilityPath = join(tempRubricsDir, 'readability.json');
  const parsedReadability = JSON.parse(readFileSync(readabilityPath, 'utf8')) as Record<string, unknown>;
  parsedReadability.rubric = 'readability-v3';
  writeFileSync(readabilityPath, JSON.stringify(parsedReadability, null, 2));

  const mockRubricChange = makeMockOpenRouterTransport();
  const runRubricChange = await runScanner({
    config,
    rubricsDir: tempRubricsDir,
    transport: mockRubricChange.transport,
  });
  assert.equal(mockRubricChange.calls, 1);
  assert.equal(runRubricChange.repo_outcomes.find((o) => o.mode === 'file')?.status, 'scanned');
  assert.equal(runRubricChange.repo_outcomes.find((o) => o.mode === 'structure')?.status, 'skipped');

  // 5. New git commit -> both modes re-run!
  writeFileSync(join(repoPath, 'src/domain.ts'), 'export const version = 2;\n');
  runGit(repoPath, ['add', '.']);
  runGit(repoPath, ['commit', '-m', 'Second commit']);
  const mockCommitChange = makeMockOpenRouterTransport();
  const runCommitChange = await runScanner({
    config,
    rubricsDir: tempRubricsDir,
    transport: mockCommitChange.transport,
  });
  assert.equal(mockCommitChange.calls, 2);
  assert.deepEqual(runCommitChange.repo_outcomes.map((o) => o.status), ['scanned', 'scanned']);
});

test('dashboard model marks judge_version & rubric_hashes changes, computes deltas, and renders safe self-contained HTML', (t) => {
  const root = makeTempDir(t, 'dashboard-model-test-');
  const catalog = loadRubricCatalog();
  const latestTag = catalog.agent_tooling.latest_tag;

  const makeSnap = (overrides: {
    timestamp: string;
    repo?: string;
    branch?: string;
    commit: string;
    judge_version: string;
    rubric_hashes: Record<string, string>;
    calibrated: number;
    raw: number;
    meanP: number;
    installedRef?: string | null;
    filePath?: string;
  }): RepoSnapshot => ({
    schema_version: 1,
    kind: 'repo',
    timestamp: overrides.timestamp,
    repo: {
      name: overrides.repo ?? 'acme-app',
      branch: overrides.branch ?? 'main',
      commit: overrides.commit,
      commit_short: overrides.commit.slice(0, 7),
      dirty: false,
      installed_judge_code: overrides.installedRef
        ? { ref: overrides.installedRef, source: 'wombat9000/agent-tooling', computed_hash: '1234567890abcdef', skill_path: 'skills/judge-code/SKILL.md' }
        : null,
    },
    scan: {
      mode: 'file',
      sources: ['src'],
      rubrics: Object.keys(overrides.rubric_hashes),
      rubric_id: 'readability-v2',
      rubric_groups: { readability: ['direct_readability', 'named_domain_expressions'] },
      exclude: [],
      model: 'typesafe/jev-1.14',
      returned_model: 'typesafe/jev-1.14',
      backend: 'openrouter',
      conventions_hash: null,
      requirements_hash: null,
    },
    judge_version: overrides.judge_version,
    agent_tooling_tag: latestTag,
    agent_tooling_commit: 'abc1234',
    rubric_hashes: overrides.rubric_hashes,
    rubrics_digest: computeHashesDigest(overrides.rubric_hashes),
    metrics: {
      file_count: 2,
      target_count: 2,
      check_count: 2,
      calibrated_pass_rate: overrides.calibrated,
      raw_pass_rate: overrides.raw,
      all_files_pass_rate: overrides.calibrated,
      mean_pass_probability: overrides.meanP,
      elapsed_ms: 500,
      cost_usd: 0.001,
      requests: 2,
      retries: 0,
    },
    checks: {
      direct_readability: {
        threshold: 0.8,
        rubric_group: 'readability',
        passed: overrides.calibrated >= 0.8 ? 2 : 1,
        raw_passed: 2,
        total: 2,
        pass_rate: overrides.calibrated,
        raw_pass_rate: overrides.raw,
        mean_pass_probability: overrides.meanP,
        min_pass_probability: overrides.meanP - 0.05,
      },
    },
    files: [
      {
        path: overrides.filePath ?? 'src/alpha.ts',
        pass_rate: overrides.calibrated,
        raw_pass_rate: overrides.raw,
        mean_pass_probability: overrides.meanP,
        min_pass_probability: overrides.meanP - 0.05,
        failed_count: overrides.calibrated < 1 ? 1 : 0,
        checks: {
          direct_readability: {
            choice: overrides.calibrated < 1 ? 'fail' : 'pass',
            model_choice: 'pass',
            pass_probability: overrides.meanP - 0.05,
            confidence: 0.9,
          },
        },
      },
    ],
  });

  const h1 = { readability: 'aaaa1111' };
  const h2 = { readability: 'bbbb2222' };
  const repoSnapshots: LoadedSnapshotRecord<RepoSnapshot>[] = [
    { file: '1.json', snapshot: makeSnap({ timestamp: '2026-11-01T10:00:00.000Z', commit: '1111111aaaa', judge_version: 'v1.2.1', rubric_hashes: h1, calibrated: 0.70, raw: 0.85, meanP: 0.78, installedRef: 'v1.2.1' }) },
    { file: '2.json', snapshot: makeSnap({ timestamp: '2026-11-02T10:00:00.000Z', commit: '2222222bbbb', judge_version: 'v1.2.1', rubric_hashes: h1, calibrated: 0.80, raw: 0.90, meanP: 0.84, installedRef: 'v1.2.1' }) },
    { file: '3.json', snapshot: makeSnap({ timestamp: '2026-11-03T10:00:00.000Z', commit: '2222222bbbb', judge_version: 'v1.2.1', rubric_hashes: h2, calibrated: 0.88, raw: 0.92, meanP: 0.89, installedRef: 'v1.2.1' }) },
    { file: '4.json', snapshot: makeSnap({ timestamp: '2026-11-04T10:00:00.000Z', commit: '3333333cccc', judge_version: 'v1.3.0', rubric_hashes: h2, calibrated: 0.95, raw: 0.95, meanP: 0.94, installedRef: latestTag ?? 'v1.3.0' }) },
    // Second repo with XSS attempt in branch/file path & outdated installed skill
    { file: '5.json', snapshot: makeSnap({ timestamp: '2026-11-04T11:00:00.000Z', repo: 'beta-repo', branch: 'feat/</script><img src=x onerror=alert(1)>', filePath: 'src/</script><script>alert(2)</script>.ts', commit: '4444444dddd', judge_version: 'v1.3.0', rubric_hashes: h2, calibrated: 0.60, raw: 0.75, meanP: 0.68, installedRef: 'v1.0.0' }) },
  ];

  const fixtureSnapshots: LoadedSnapshotRecord<RubricFixturesSnapshot>[] = [
    {
      file: 'fx-1.json',
      snapshot: {
        schema_version: 1,
        kind: 'rubric_fixtures',
        timestamp: '2026-11-04T12:00:00.000Z',
        judge_version: 'v1.3.0',
        agent_tooling_tag: latestTag,
        agent_tooling_commit: 'abc1234',
        rubric_hashes: h2,
        fixture_hashes: { 'sample-good': 'cccc3333' },
        combined_hash: 'dddd4444',
        scan: { backend: 'openrouter', model: null, repeats: 2 },
        metrics: {
          status: 'passed',
          fixtures_total: 1,
          fixtures_passed: 1,
          fixture_pass_rate: 1,
          checks_total: 1,
          checks_passed: 1,
          check_pass_rate: 1,
          min_margin: 0.14,
          mean_margin: 0.14,
          max_jitter: 0.03,
          mean_jitter: 0.03,
          elapsed_ms: 800,
          cost_usd: 0.0004,
          requests: 2,
        },
        checks: [
          {
            fixture_id: 'sample-good',
            mode: 'file',
            rubric: 'readability-v2',
            check_id: 'direct_readability',
            expected: 'pass',
            passed: true,
            matches: 2,
            repeats: 2,
            pass_threshold: 0.8,
            min_pass_probability: 0.94,
            max_pass_probability: 0.97,
            mean_pass_probability: 0.955,
            margin: 0.14,
            jitter: 0.03,
          },
        ],
      },
    },
  ];

  const model = buildDashboardModel({ repoSnapshots, fixtureSnapshots, catalog });
  const acme = model.repos.find((r) => r.name === 'acme-app')!;
  const points = acme.by_mode.file!.points;
  assert.equal(points.length, 4);

  // Point 0: baseline
  assert.equal(points[0].version_changed, false);
  assert.equal(points[0].delta_calibrated, null);
  // Point 1: code-only change
  assert.equal(points[1].version_changed, false);
  assert.ok(Math.abs((points[1].delta_calibrated ?? 0) - 0.10) < 1e-9);
  assert.ok(Math.abs((points[1].delta_raw ?? 0) - 0.05) < 1e-9);
  // Point 2: rubric hash changed
  assert.equal(points[2].version_changed, true);
  assert.match(points[2].change_reasons.join(' '), /rubrics: updated readability/);
  // Point 3: judge_version changed
  assert.equal(points[3].version_changed, true);
  assert.match(points[3].change_reasons.join(' '), /judge_version: v1\.2\.1 -> v1\.3\.0/);
  assert.equal(acme.by_mode.file!.version_change_count, 2);

  // Installed judge-code status
  assert.equal(acme.installed_status, latestTag ? 'current' : 'unknown');
  const beta = model.repos.find((r) => r.name === 'beta-repo')!;
  assert.equal(beta.installed_status, latestTag ? 'outdated' : 'unknown');

  // Render HTML and verify offline self-containment + XSS escaping
  const html = renderDashboardHtml(model);
  assert.ok(!/https?:\/\//i.test(html), 'Dashboard HTML must not contain external http/https URLs');
  assert.ok(!html.includes('</script><img'), 'Raw </script> tag must be escaped');
  assert.ok(!html.includes('<script>alert(2)</script>'), 'Raw <script> payload must be escaped');
  assert.match(html, /Content-Security-Policy/);

  // Extract embedded JSON payload and confirm it parses identically
  const match = /<script id="dashboard-data" type="application\/json">([\s\S]*?)<\/script>/.exec(html);
  assert.ok(match, 'Embedded dashboard-data JSON script tag must exist');
  const parsedEmbedded = JSON.parse(match[1]) as { repos: unknown[]; fixtures: { points: unknown[] } };
  assert.equal(parsedEmbedded.repos.length, 2);
  assert.equal(parsedEmbedded.fixtures.points.length, 1);

  // Empty history directory renders cleanly and quickly (<500ms even on slow CI; typically <25ms)
  const emptyDir = join(root, 'empty-data');
  mkdirSync(emptyDir, { recursive: true });
  const emptyRes = generateDashboard({ dataDir: emptyDir });
  assert.equal(emptyRes.model.totals.repo_count, 0);
  assert.equal(emptyRes.model.totals.fixture_runs, 0);
  assert.ok(existsSync(emptyRes.outPath));
  const emptyHtml = readFileSync(emptyRes.outPath, 'utf8');
  assert.ok(!/https?:\/\//i.test(emptyHtml));
  assert.match(emptyHtml, /No repository snapshots found/);
});

test('end-to-end --dry-run scan and dashboard CLI work offline on a synthetic git repo without API keys', (t) => {
  const root = makeTempDir(t, 'scan-e2e-dryrun-');
  const { repoPath } = createSyntheticGitRepo(
    root,
    'synthetic-web',
    {
      'src/app.ts': 'export const greeting = (name: string) => `hello ${name}`;\n',
      'src/math.ts': 'export const add = (a: number, b: number) => a + b;\n',
    },
    'v1.2.1',
  );

  const dataDir = join(root, 'priv-dashboard');
  const outFile = join(dataDir, 'index.html');
  const configPath = join(root, 'config.json');
  writeFileSync(configPath, JSON.stringify({
    dataDir,
    out: outFile,
    repos: [
      {
        name: 'synthetic-web',
        path: repoPath,
        sources: ['src'],
        modes: ['file', 'structure'],
        all: true,
        rubrics: [],
        exclude: [],
        conventions: null,
        requirements: null,
        model: null,
        concurrency: 4,
      },
    ],
    fixtures: {
      enabled: true,
      repeats: 2,
    },
  }));

  const env = { ...process.env };
  delete env.OPENROUTER_API_KEY;

  const scanProc = spawnSync(
    process.execPath,
    [SCAN_CLI, '--config', configPath, '--dry-run'],
    { env, encoding: 'utf8' },
  );
  assert.ifError(scanProc.error);
  assert.equal(scanProc.status, 0, scanProc.stderr || scanProc.stdout);
  assert.match(scanProc.stdout, /DRY RUN/);
  assert.match(scanProc.stdout, /synthetic-web \[file\].*would scan 2 file\(s\)/);
  assert.match(scanProc.stdout, /synthetic-web \[structure\].*would scan 2 file\(s\)/);
  assert.match(scanProc.stdout, /rubrics\/fixtures.*would run/);
  assert.match(scanProc.stdout, /Total OpenRouter cost: \$0\.0000/);
  assert.ok(existsSync(outFile), 'Dry-run scan should rebuild the dashboard HTML');

  // Standalone dashboard CLI also works offline
  const customOut = join(root, 'custom.html');
  const dashProc = spawnSync(
    process.execPath,
    [DASHBOARD_CLI, '--data', dataDir, '--out', customOut],
    { env, encoding: 'utf8' },
  );
  assert.ifError(dashProc.error);
  assert.equal(dashProc.status, 0, dashProc.stderr || dashProc.stdout);
  assert.match(dashProc.stdout, /Dashboard built in \d+ms/);
  assert.ok(existsSync(customOut));
});

test('runScanner caches rubric_fixtures runs by rubrics+fixtures hash, honors --skip-fixtures and --force, and computes margin/jitter', async (t) => {
  const root = makeTempDir(t, 'scan-fixtures-cache-test-');
  const tempRubricsDir = join(root, 'rubrics');
  const tempFixturesDir = join(root, 'fixtures');
  mkdirSync(tempRubricsDir, { recursive: true });
  mkdirSync(tempFixturesDir, { recursive: true });
  cpSync(join(AUTHORITATIVE_RUBRICS_DIR, 'readability.json'), join(tempRubricsDir, 'readability.json'));

  const fixturePath = join(tempFixturesDir, 'sample-good.json');
  writeFileSync(fixturePath, JSON.stringify({
    id: 'sample-good',
    description: 'Clean helper',
    mode: 'file',
    rubric: 'readability',
    files: { 'clean.ts': 'export const isPositive = (n: number) => n > 0;\n' },
    expect: { direct_readability: 'pass' },
  }));

  const dataDir = join(root, 'fx-data');
  const configPath = join(root, 'config.json');
  writeFileSync(configPath, JSON.stringify({
    dataDir,
    repos: [],
    fixtures: { enabled: true, repeats: 2, concurrency: 2 },
  }));

  const prevKey = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = 'sk-or-fixture-cache-test';
  t.after(() => {
    if (prevKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = prevKey;
  });

  let callIdx = 0;
  const mock = makeMockOpenRouterTransport(() => {
    callIdx += 1;
    return { direct_readability: { choice: 'pass', pass: callIdx === 1 ? 0.90 : 0.96 } };
  });
  const config = loadScannerConfig(configPath);
  const first = await runScanner({
    config,
    rubricsDir: tempRubricsDir,
    fixturesDir: tempFixturesDir,
    transport: mock.transport,
  });
  assert.equal(first.fixture_outcome.status, 'scanned');
  assert.equal(first.fixture_outcome.fixtures_passed, 1);
  assert.equal(mock.calls, 2);

  // Verify saved fixture snapshot margin (0.90 - 0.80 = 0.10) and jitter (0.96 - 0.90 = 0.06)
  const fxSnap = JSON.parse(readFileSync(first.fixture_outcome.snapshot_file!, 'utf8')) as RubricFixturesSnapshot;
  assert.equal(fxSnap.kind, 'rubric_fixtures');
  assert.equal(fxSnap.metrics.min_margin, 0.1);
  assert.equal(fxSnap.metrics.max_jitter, 0.06);

  // Second run skips fixtures (unchanged)
  const mock2 = makeMockOpenRouterTransport();
  const second = await runScanner({
    config,
    rubricsDir: tempRubricsDir,
    fixturesDir: tempFixturesDir,
    transport: mock2.transport,
  });
  assert.equal(second.fixture_outcome.status, 'skipped');
  assert.equal(second.fixture_outcome.reason, 'unchanged');
  assert.equal(mock2.calls, 0);

  // --skip-fixtures disables fixture run
  const skippedFlag = await runScanner({
    config,
    skipFixtures: true,
    rubricsDir: tempRubricsDir,
    fixturesDir: tempFixturesDir,
    transport: mock2.transport,
  });
  assert.equal(skippedFlag.fixture_outcome.status, 'disabled');

  // Mutating fixture file invalidates combined_hash and triggers re-run
  writeFileSync(fixturePath, JSON.stringify({
    id: 'sample-good',
    description: 'Clean helper updated',
    mode: 'file',
    rubric: 'readability',
    files: { 'clean.ts': 'export const isPositive = (n: number) => n > 0;\n' },
    expect: { direct_readability: 'pass' },
  }));
  const mock3 = makeMockOpenRouterTransport();
  const third = await runScanner({
    config,
    rubricsDir: tempRubricsDir,
    fixturesDir: tempFixturesDir,
    transport: mock3.transport,
  });
  assert.equal(third.fixture_outcome.status, 'scanned');
  assert.equal(mock3.calls, 2);
});

test('rubrics:scan supports optional per-repo ignore globs in file and structure modes and invalidates cache when ignore changes', async (t) => {
  const root = makeTempDir(t, 'scan-ignore-test-');
  const { repoPath } = createSyntheticGitRepo(
    root,
    'ignore-app',
    {
      'src/domain.ts': 'export const ok = 1;\n',
      'src/booking-test-support.ts': 'export const helper = true;\n',
      'src/legacy/old.ts': 'export const old = 0;\n',
    },
  );

  const tempRubricsDir = join(root, 'rubrics');
  mkdirSync(tempRubricsDir, { recursive: true });
  cpSync(join(AUTHORITATIVE_RUBRICS_DIR, 'readability.json'), join(tempRubricsDir, 'readability.json'));
  cpSync(join(AUTHORITATIVE_RUBRICS_DIR, 'project-structure.json'), join(tempRubricsDir, 'project-structure.json'));

  const dataDir = join(root, 'data');
  const configPath = join(root, 'config.json');
  const writeConfig = (ignore?: string[]) => {
    writeFileSync(configPath, JSON.stringify({
      dataDir,
      repos: [
        {
          name: 'ignore-app',
          path: repoPath,
          sources: ['src'],
          modes: ['file', 'structure'],
          ...(ignore !== undefined ? { ignore } : {}),
        },
      ],
      fixtures: { enabled: false },
    }));
  };

  // Empty or degenerate ignore patterns are rejected at config load time
  writeConfig(['  ']);
  assert.throws(() => loadScannerConfig(configPath), /must be a nonempty string/);
  writeConfig(['./']);
  assert.throws(() => loadScannerConfig(configPath), /Invalid --ignore pattern/);

  const prevKey = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = 'sk-or-ignore-test-key';
  t.after(() => {
    if (prevKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = prevKey;
  });

  // 1. Scan with ignore globs (both basename and repo-relative) filters file and structure modes
  writeConfig(['*-test-support.*', 'src/legacy/**']);
  const cfg1 = loadScannerConfig(configPath);
  assert.deepEqual(cfg1.repos[0].ignore, ['*-test-support.*', 'src/legacy/**']);
  const mock1 = makeMockOpenRouterTransport();
  const run1 = await runScanner({
    config: cfg1,
    rubricsDir: tempRubricsDir,
    noDashboard: true,
    transport: mock1.transport,
  });
  assert.equal(run1.errors.length, 0);
  const fileOut1 = run1.repo_outcomes.find((o) => o.mode === 'file')!;
  const structOut1 = run1.repo_outcomes.find((o) => o.mode === 'structure')!;
  assert.equal(fileOut1.status, 'scanned');
  assert.equal(fileOut1.file_count, 1);
  assert.equal(structOut1.status, 'scanned');
  assert.equal(structOut1.file_count, 1);
  const snap1 = JSON.parse(readFileSync(fileOut1.snapshot_file!, 'utf8')) as RepoSnapshot;
  assert.deepEqual(snap1.scan.ignore, ['*-test-support.*', 'src/legacy/**']);
  assert.deepEqual(snap1.files.map((f) => f.path), ['src/domain.ts']);

  // 2. Unchanged ignore hits cache
  const mock2 = makeMockOpenRouterTransport();
  const run2 = await runScanner({
    config: cfg1,
    rubricsDir: tempRubricsDir,
    noDashboard: true,
    transport: mock2.transport,
  });
  assert.equal(mock2.calls, 0);
  assert.deepEqual(run2.repo_outcomes.map((o) => o.status), ['skipped', 'skipped']);

  // 3. Removing ignore invalidates cache and scans all 3 files
  writeConfig();
  const cfg3 = loadScannerConfig(configPath);
  assert.deepEqual(cfg3.repos[0].ignore, []);
  const mock3 = makeMockOpenRouterTransport();
  const run3 = await runScanner({
    config: cfg3,
    rubricsDir: tempRubricsDir,
    noDashboard: true,
    transport: mock3.transport,
  });
  assert.equal(run3.errors.length, 0);
  assert.equal(run3.repo_outcomes.find((o) => o.mode === 'file')?.file_count, 3);
  assert.equal(run3.repo_outcomes.find((o) => o.mode === 'structure')?.file_count, 3);
});

test('loadScannerConfig and discoverRepoModules handle explicit modules, moduleRoots wildcards, overrides, ignores, and validation', (t) => {
  const root = makeTempDir(t, 'scan-module-discovery-test-');
  const repoDir = join(root, 'polyglot-repo');
  const writeRepoFile = (relPath: string, content: string) => {
    const full = join(repoDir, relPath);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, content, 'utf8');
  };

  // TypeScript/React feature modules + non-code & test dirs
  writeRepoFile('app/features/auth/login.tsx', 'export const Login = () => null;\n');
  writeRepoFile('app/features/billing/invoice.ts', 'export const total = (n: number) => n;\n');
  writeRepoFile('app/features/billing/legacy/old.ts', 'export const legacy = 1;\n');
  writeRepoFile('app/features/assets/logo.svg', '<svg></svg>\n');
  writeRepoFile('app/features/__tests__/helpers.ts', 'export const mock = true;\n');
  writeRepoFile('app/features/ignored-feature/index.ts', 'export const skipped = true;\n');
  writeRepoFile('app/shared/format.ts', 'export const fmt = (s: string) => s;\n');

  // Kotlin/Spring multi-level package modules (including colliding basename "auth")
  writeRepoFile('services/api/domains/booking/BookingService.kt', 'class BookingService\n');
  writeRepoFile('services/api/domains/auth/AuthService.kt', 'class AuthService\n');
  writeRepoFile('services/worker/domains/dispatch/DispatchJob.kt', 'class DispatchJob\n');

  const writeCfg = (file: string, data: unknown): string => {
    const p = join(root, file);
    writeFileSync(p, JSON.stringify(data), 'utf8');
    return p;
  };

  // Valid config combining explicit modules (string shorthand + object override) and moduleRoots
  const validCfgPath = writeCfg('valid-modules.json', {
    dataDir: './data',
    repos: [
      {
        name: 'polyglot-repo',
        path: repoDir,
        sources: ['app'],
        modes: ['file', 'structure'],
        ignore: ['app/features/ignored-feature/**'],
        moduleRoots: ['app/features/*', 'services/*/domains/*'],
        modules: [
          'app/shared',
          { name: 'billing-core', path: 'app/features/billing', ignore: ['legacy/**'] },
        ],
        moduleModel: 'liquid/d1.2-ultra',
      },
    ],
  });

  const cfg = loadScannerConfig(validCfgPath);
  assert.equal(cfg.repos[0].moduleModel, 'liquid/d1.2-ultra');
  assert.deepEqual(cfg.repos[0].moduleRoots, ['app/features/*', 'services/*/domains/*']);
  assert.equal(cfg.repos[0].modules.length, 2);

  const discovered = discoverRepoModules(cfg.repos[0]);
  assert.deepEqual(
    discovered.map((m) => ({ name: m.name, path: m.path, ignore: m.ignore })),
    [
      { name: 'api/auth', path: 'services/api/domains/auth', ignore: [] },
      { name: 'api/booking', path: 'services/api/domains/booking', ignore: [] },
      { name: 'auth', path: 'app/features/auth', ignore: [] },
      { name: 'billing-core', path: 'app/features/billing', ignore: ['legacy/**'] },
      { name: 'shared', path: 'app/shared', ignore: [] },
      { name: 'worker/dispatch', path: 'services/worker/domains/dispatch', ignore: [] },
    ],
  );

  // Plain directory moduleRoot (without trailing /*) + basename collision disambiguation across two roots
  writeRepoFile('lib/features/auth/helper.ts', 'export const helper = 1;\n');
  const collisionCfgPath = writeCfg('collision.json', {
    dataDir: './data',
    repos: [
      {
        name: 'collision-app',
        path: repoDir,
        sources: ['app'],
        modes: ['file'],
        ignore: ['app/features/ignored-feature/**'],
        moduleRoots: ['app/features', 'lib/features'],
      },
    ],
  });
  const collisionDiscovered = discoverRepoModules(loadScannerConfig(collisionCfgPath).repos[0]);
  assert.deepEqual(
    collisionDiscovered.map((m) => ({ name: m.name, path: m.path })),
    [
      { name: 'app/features/auth', path: 'app/features/auth' },
      { name: 'billing', path: 'app/features/billing' },
      { name: 'lib/features/auth', path: 'lib/features/auth' },
    ],
  );

  // Reject unsafe or malformed module configs
  assert.throws(
    () => loadScannerConfig(writeCfg('escape-root.json', {
      dataDir: './d',
      repos: [{ name: 'a', path: repoDir, sources: ['app'], modes: ['file'], moduleRoots: ['../polyglot-repo/*'] }],
    })),
    /escapes the repository root/,
  );
  assert.throws(
    () => loadScannerConfig(writeCfg('globstar-root.json', {
      dataDir: './d',
      repos: [{ name: 'a', path: repoDir, sources: ['app'], modes: ['file'], moduleRoots: ['app/**'] }],
    })),
    /does not support "\*\*"/,
  );
  assert.throws(
    () => loadScannerConfig(writeCfg('missing-root.json', {
      dataDir: './d',
      repos: [{ name: 'a', path: repoDir, sources: ['app'], modes: ['file'], moduleRoots: ['nonexistent/*'] }],
    })),
    /directory not found/,
  );
  assert.throws(
    () => loadScannerConfig(writeCfg('dup-mod-name.json', {
      dataDir: './d',
      repos: [{
        name: 'a',
        path: repoDir,
        sources: ['app'],
        modes: ['file'],
        modules: [
          { name: 'same', path: 'app/features/auth' },
          { name: 'same', path: 'app/features/billing' },
        ],
      }],
    })),
    /Duplicate module name/,
  );
  assert.throws(
    () => loadScannerConfig(writeCfg('bad-mod-model.json', {
      dataDir: './d',
      repos: [{ name: 'a', path: repoDir, sources: ['app'], modes: ['file'], moduleModel: 'invalid' }],
    })),
    /full OpenRouter model ID/,
  );
});

test('runScanner runs --mode code per module with conventions and ignore forwarding, caches hits, and honors --skip-modules / --modules', async (t) => {
  const root = makeTempDir(t, 'scan-modules-e2e-test-');
  const sentinelSecret = 'PROPRIETARY_MODULE_BODY_SENTINEL_445566';
  const { repoPath } = createSyntheticGitRepo(
    root,
    'feature-app',
    {
      'docs/conventions.md': '# Repo Conventions\nKeep modules decoupled.\n',
      'app/features/auth/service.ts': `// ${sentinelSecret}\nexport const login = (u: string) => u.trim();\n`,
      'app/features/auth/auth-test-support.ts': 'export const fakeUser = "x";\n',
      'app/features/billing/service.ts': 'export const charge = (cents: number) => cents;\n',
      'app/features/billing/legacy/old.ts': 'export const deprecated = 1;\n',
    },
    'v1.3.0',
  );

  const tempRubricsDir = join(root, 'rubrics');
  mkdirSync(tempRubricsDir, { recursive: true });
  cpSync(join(AUTHORITATIVE_RUBRICS_DIR, 'solid.json'), join(tempRubricsDir, 'solid.json'));
  cpSync(join(AUTHORITATIVE_RUBRICS_DIR, 'module-design.json'), join(tempRubricsDir, 'module-design.json'));
  cpSync(join(AUTHORITATIVE_RUBRICS_DIR, 'readability.json'), join(tempRubricsDir, 'readability.json'));

  const dataDir = join(root, 'data');
  const configPath = join(root, 'config.json');
  const writeCfg = (extra: Record<string, unknown> = {}) => {
    writeFileSync(configPath, JSON.stringify({
      dataDir,
      repos: [
        {
          name: 'feature-app',
          path: repoPath,
          sources: ['app'],
          modes: ['file'],
          ignore: ['*-test-support.*'],
          conventions: 'docs/conventions.md',
          moduleRoots: ['app/features/*'],
          modules: [
            { name: 'billing', path: 'app/features/billing', ignore: ['legacy/**'] },
          ],
          ...extra,
        },
      ],
      fixtures: { enabled: false },
    }));
  };
  writeCfg();

  const prevKey = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = 'sk-or-module-test-key';
  t.after(() => {
    if (prevKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = prevKey;
  });

  // Track requests to verify conventions, ignore filtering, and module-scoped questions
  const capturedCodeRequests: Array<{ files: string[]; conventions?: string; questions: string[] }> = [];
  const mock1 = makeMockOpenRouterTransport((body) => {
    const prodFiles = Object.keys((body.state.production_files as Record<string, string>) ?? {}).sort();
    const questions = Object.keys(body.questions).sort();
    if (questions.includes('single_responsibility')) {
      capturedCodeRequests.push({
        files: prodFiles,
        conventions: typeof body.state.conventions === 'string' ? body.state.conventions : undefined,
        questions,
      });
      // Give billing 1 hard model fail + 1 borderline threshold flip; auth stays clean
      if (prodFiles.some((f) => f.includes('service.ts')) && JSON.stringify(body.state.production_files).includes('charge')) {
        return {
          single_responsibility: { choice: 'fail', pass: 0.22 },
          modular_organization: { choice: 'pass', pass: 0.72 },
        };
      }
    }
    return {};
  });

  const cfg1 = loadScannerConfig(configPath);
  const run1 = await runScanner({
    config: cfg1,
    rubricsDir: tempRubricsDir,
    transport: mock1.transport,
  });

  assert.equal(run1.errors.length, 0);
  const codeOut = run1.repo_outcomes.find((o) => o.mode === 'code')!;
  assert.ok(codeOut, 'Module config should automatically trigger code mode scan');
  assert.equal(codeOut.status, 'scanned');
  assert.equal(codeOut.module_count, 2);
  assert.equal(codeOut.modules_scored, 2);
  assert.equal(codeOut.modules_skipped, 0);
  assert.equal(codeOut.modules_errored, 0);
  assert.equal(codeOut.findings_total, 2);
  assert.equal(codeOut.findings_hard, 1);
  assert.equal(codeOut.findings_borderline, 1);

  // Verify conventions & ignore patterns were forwarded cleanly for both modules
  assert.equal(capturedCodeRequests.length, 2);
  for (const req of capturedCodeRequests) {
    assert.match(req.conventions ?? '', /Keep modules decoupled/);
    assert.ok(req.questions.includes('follows_repo_conventions'));
    assert.ok(req.questions.includes('single_responsibility'));
    assert.ok(req.questions.includes('modular_organization'));
    assert.deepEqual(req.files, ['service.ts'], 'Ignored test-support and legacy files must be excluded');
  }

  // Verify saved snapshot structure, 0600 mode, and zero source code leakage
  const rawSnap = readFileSync(codeOut.snapshot_file!, 'utf8');
  assert.ok(!rawSnap.includes(sentinelSecret));
  assert.ok(!rawSnap.includes('sk-or-module-test-key'));
  assert.equal(statSync(codeOut.snapshot_file!).mode & 0o777, 0o600);
  const snap = JSON.parse(rawSnap) as RepoSnapshot;
  assert.equal(snap.scan.mode, 'code');
  assert.deepEqual(snap.scan.module_roots, ['app/features/*']);
  assert.equal(snap.modules?.length, 2);
  const billingMod = snap.modules!.find((m) => m.name === 'billing')!;
  assert.equal(billingMod.status, 'scored');
  assert.equal(billingMod.hard_fail_count, 1);
  assert.equal(billingMod.borderline_count, 1);
  assert.equal(billingMod.failed_count, 2);
  assert.equal(billingMod.checks.single_responsibility.model_choice, 'fail');
  assert.equal(billingMod.checks.modular_organization.choice, 'fail');
  assert.equal(billingMod.checks.modular_organization.model_choice, 'pass');

  // Re-run with unchanged repo & modules -> cache hit ($0)
  const mock2 = makeMockOpenRouterTransport();
  const run2 = await runScanner({
    config: cfg1,
    rubricsDir: tempRubricsDir,
    noDashboard: true,
    transport: mock2.transport,
  });
  assert.equal(mock2.calls, 0);
  assert.equal(run2.repo_outcomes.find((o) => o.mode === 'code')?.status, 'skipped');

  // --skip-modules omits code mode altogether
  const runSkipped = await runScanner({
    config: cfg1,
    skipModules: true,
    rubricsDir: tempRubricsDir,
    noDashboard: true,
    transport: mock2.transport,
  });
  assert.equal(runSkipped.repo_outcomes.some((o) => o.mode === 'code'), false);

  // Combining --modules and --skip-modules fails cleanly
  await assert.rejects(
    runScanner({ config: cfg1, includeModules: true, skipModules: true, rubricsDir: tempRubricsDir, noDashboard: true }),
    /Cannot combine --modules and --skip-modules/,
  );

  // Adding a new feature module invalidates the module cache without even committing
  mkdirSync(join(repoPath, 'app/features/search'), { recursive: true });
  writeFileSync(join(repoPath, 'app/features/search/query.ts'), 'export const search = (q: string) => q;\n');
  const mock3 = makeMockOpenRouterTransport();
  const run3 = await runScanner({
    config: cfg1,
    rubricsDir: tempRubricsDir,
    noDashboard: true,
    transport: mock3.transport,
  });
  const codeOut3 = run3.repo_outcomes.find((o) => o.mode === 'code')!;
  assert.equal(codeOut3.status, 'scanned');
  assert.equal(codeOut3.module_count, 3);
  assert.equal(mock3.calls, 3);
});

test('module scan handles oversize (>128 KiB), empty modules, and per-module API errors without crashing sibling modules', async (t) => {
  const root = makeTempDir(t, 'scan-modules-resilience-test-');
  const hugePayload = `export const big = "${'x'.repeat(135 * 1024)}";\n`;
  const { repoPath } = createSyntheticGitRepo(
    root,
    'resilient-app',
    {
      'modules/clean/index.ts': 'export const ok = 1;\n',
      'modules/huge/giant.ts': hugePayload,
      'modules/empty/README.md': '# Only docs here\n',
      'modules/flaky/index.ts': 'export const flaky = 2;\n',
    },
  );

  const tempRubricsDir = join(root, 'rubrics');
  mkdirSync(tempRubricsDir, { recursive: true });
  cpSync(join(AUTHORITATIVE_RUBRICS_DIR, 'solid.json'), join(tempRubricsDir, 'solid.json'));

  const dataDir = join(root, 'data');
  const configPath = join(root, 'config.json');
  writeFileSync(configPath, JSON.stringify({
    dataDir,
    repos: [
      {
        name: 'resilient-app',
        path: repoPath,
        sources: ['modules/clean'],
        modes: ['code'],
        modules: [
          { name: 'clean', path: 'modules/clean' },
          { name: 'huge', path: 'modules/huge' },
          { name: 'empty', path: 'modules/empty' },
        ],
      },
    ],
    fixtures: { enabled: false },
  }));

  const prevKey = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = 'sk-or-resilience-key';
  t.after(() => {
    if (prevKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = prevKey;
  });

  // 1. Dry run reports oversize & empty skips without throwing
  const cfg = loadScannerConfig(configPath);
  const dry = await runScanner({ config: cfg, dryRun: true, rubricsDir: tempRubricsDir, noDashboard: true });
  assert.equal(dry.errors.length, 0);
  const dryOut = dry.repo_outcomes[0];
  assert.equal(dryOut.status, 'dry_run');
  assert.equal(dryOut.module_count, 3);
  assert.equal(dryOut.modules_scored, 1);
  assert.equal(dryOut.modules_skipped, 2);
  assert.deepEqual(
    dryOut.skipped_modules?.map((s) => ({ name: s.name, reason: s.reason })),
    [
      { name: 'empty', reason: 'empty' },
      { name: 'huge', reason: 'oversize' },
    ],
  );
  const summaryText = formatScanSummary(dry);
  assert.match(summaryText, /would scan 1\/3 module\(s\)/);
  assert.match(summaryText, /skip module huge \[modules\/huge\]: oversize/);

  // 2. Live scan scores "clean", skips "huge" (oversize) and "empty", saves snapshot cleanly with 0 errors
  const mockLive = makeMockOpenRouterTransport();
  const live = await runScanner({ config: cfg, rubricsDir: tempRubricsDir, transport: mockLive.transport });
  assert.equal(live.errors.length, 0);
  assert.equal(mockLive.calls, 1);
  const liveOut = live.repo_outcomes[0];
  assert.equal(liveOut.status, 'scanned');
  assert.equal(liveOut.modules_scored, 1);
  assert.equal(liveOut.modules_skipped, 2);
  const snap = JSON.parse(readFileSync(liveOut.snapshot_file!, 'utf8')) as RepoSnapshot;
  const hugeMod = snap.modules!.find((m) => m.name === 'huge')!;
  assert.equal(hugeMod.status, 'skipped');
  assert.equal(hugeMod.skip_reason, 'oversize');
  assert.ok((hugeMod.bytes ?? 0) > 128 * 1024);
  assert.equal(hugeMod.file_count, 1);
  const emptyMod = snap.modules!.find((m) => m.name === 'empty')!;
  assert.equal(emptyMod.status, 'skipped');
  assert.equal(emptyMod.skip_reason, 'empty');

  // Re-run hits cache even with deterministic oversize/empty skips
  const mockCached = makeMockOpenRouterTransport();
  const cachedRun = await runScanner({ config: cfg, rubricsDir: tempRubricsDir, noDashboard: true, transport: mockCached.transport });
  assert.equal(mockCached.calls, 0);
  assert.equal(cachedRun.repo_outcomes[0].status, 'skipped');

  // 3. Per-module API error on "flaky" preserves "clean" result, reports error, and does NOT poison cache
  writeFileSync(configPath, JSON.stringify({
    dataDir: join(root, 'data-err'),
    repos: [
      {
        name: 'resilient-app',
        path: repoPath,
        sources: ['modules/clean'],
        modes: ['code'],
        concurrency: 1,
        modules: [
          { name: 'clean', path: 'modules/clean' },
          { name: 'flaky', path: 'modules/flaky' },
        ],
      },
    ],
    fixtures: { enabled: false },
  }));
  const errCfg = loadScannerConfig(configPath);
  const flakyTransport: typeof fetch = (async (_url, init) => {
    const rawBody = String(init?.body ?? '');
    if (rawBody.includes('flaky')) {
      return new Response(JSON.stringify({ error: { message: 'Model rejected payload' } }), { status: 400 });
    }
    return makeMockOpenRouterTransport().transport(_url, init);
  }) as typeof fetch;

  const partialRun = await runScanner({ config: errCfg, rubricsDir: tempRubricsDir, noDashboard: true, transport: flakyTransport });
  assert.equal(partialRun.errors.length, 1);
  assert.match(partialRun.errors[0], /resilient-app \(code\/flaky\):.*400/);
  const partialOut = partialRun.repo_outcomes[0];
  assert.equal(partialOut.status, 'scanned');
  assert.equal(partialOut.modules_scored, 1);
  assert.equal(partialOut.modules_errored, 1);
  assert.equal(partialOut.errored_modules?.[0].name, 'flaky');

  // Next run does NOT treat the errored snapshot as a clean cache hit
  const mockRetry = makeMockOpenRouterTransport();
  const retryRun = await runScanner({ config: errCfg, rubricsDir: tempRubricsDir, noDashboard: true, transport: mockRetry.transport });
  assert.equal(retryRun.errors.length, 0);
  assert.equal(mockRetry.calls, 2);
  assert.equal(retryRun.repo_outcomes[0].modules_scored, 2);
  assert.equal(retryRun.repo_outcomes[0].modules_errored, 0);
});

test('dashboard model and HTML support Feature / Module Architecture, linter punch-list layout, legacy snapshots, and valid client JS', () => {
  const catalog = loadRubricCatalog();

  // Verify classifyCheckFailure backwards-compatible fallback when model_choice is omitted
  assert.equal(classifyCheckFailure({ choice: 'pass', pass_probability: 0.9 }), null);
  assert.equal(classifyCheckFailure({ choice: 'fail', model_choice: 'fail', pass_probability: 0.2 }), 'hard');
  assert.equal(classifyCheckFailure({ choice: 'fail', model_choice: 'pass', pass_probability: 0.72 }), 'borderline');
  assert.equal(classifyCheckFailure({ choice: 'fail', pass_probability: 0.65 }), 'borderline');
  assert.equal(classifyCheckFailure({ choice: 'fail', pass_probability: 0.35 }), 'hard');

  // 1. Legacy file snapshot (no `modules`, no `model_choice`)
  const legacyFileSnap: RepoSnapshot = {
    schema_version: 1,
    kind: 'repo',
    timestamp: '2026-11-10T10:00:00.000Z',
    repo: {
      name: 'legacy-service',
      branch: 'main',
      commit: 'aaaa1111bbbb',
      commit_short: 'aaaa111',
      dirty: false,
      installed_judge_code: null,
    },
    scan: {
      mode: 'file',
      sources: ['src'],
      rubrics: ['readability'],
      rubric_id: 'readability-v2',
      rubric_groups: { readability: ['direct_readability'] },
      exclude: [],
      model: 'typesafe/jev-1.14',
      returned_model: 'typesafe/jev-1.14',
      backend: 'openrouter',
      conventions_hash: null,
      requirements_hash: null,
    },
    judge_version: 'v1.2.1',
    agent_tooling_tag: 'v1.2.1',
    agent_tooling_commit: 'abc1234',
    rubric_hashes: { readability: '1111' },
    rubrics_digest: computeHashesDigest({ readability: '1111' }),
    metrics: {
      file_count: 2,
      target_count: 2,
      check_count: 1,
      calibrated_pass_rate: 0.5,
      raw_pass_rate: 1.0,
      mean_pass_probability: 0.78,
      elapsed_ms: 200,
      cost_usd: 0.0005,
      requests: 2,
      retries: 0,
    },
    checks: {
      direct_readability: {
        threshold: 0.8,
        rubric_group: 'readability',
        passed: 1,
        raw_passed: 2,
        total: 2,
        pass_rate: 0.5,
        raw_pass_rate: 1.0,
        mean_pass_probability: 0.78,
        min_pass_probability: 0.68,
      },
    },
    files: [
      {
        path: 'src/a.ts',
        pass_rate: 0,
        raw_pass_rate: 1,
        mean_pass_probability: 0.68,
        min_pass_probability: 0.68,
        failed_count: 1,
        checks: { direct_readability: { choice: 'fail', pass_probability: 0.68, confidence: 0.85 } },
      },
      {
        path: 'src/b.ts',
        pass_rate: 1,
        raw_pass_rate: 1,
        mean_pass_probability: 0.88,
        min_pass_probability: 0.88,
        failed_count: 0,
        checks: { direct_readability: { choice: 'pass', pass_probability: 0.88, confidence: 0.9 } },
      },
    ],
  };

  // 2. Modern repo with Feature / Module Architecture snapshot (hard fails, borderline, oversize skip, error + XSS strings)
  const moduleSnap: RepoSnapshot = {
    schema_version: 1,
    kind: 'repo',
    timestamp: '2026-11-11T10:00:00.000Z',
    repo: {
      name: 'web-platform',
      branch: 'main',
      commit: 'bbbb2222cccc',
      commit_short: 'bbbb222',
      dirty: false,
      installed_judge_code: null,
    },
    scan: {
      mode: 'code',
      sources: ['app'],
      module_roots: ['app/features/*'],
      rubrics: ['solid', 'module-design'],
      rubric_id: 'solid-v3+module-design-v2',
      rubric_groups: { solid: ['single_responsibility', 'dependency_inversion'], 'module-design': ['modular_organization'] },
      exclude: [],
      model: 'liquid/d1.2-ultra',
      returned_model: 'liquid/d1.2-ultra',
      backend: 'openrouter',
      conventions_hash: null,
      requirements_hash: null,
    },
    judge_version: 'v1.3.0',
    agent_tooling_tag: 'v1.3.0',
    agent_tooling_commit: 'def5678',
    rubric_hashes: { solid: '2222', 'module-design': '3333' },
    rubrics_digest: computeHashesDigest({ solid: '2222', 'module-design': '3333' }),
    metrics: {
      file_count: 12,
      target_count: 2,
      check_count: 3,
      module_count: 4,
      modules_scored: 2,
      modules_skipped: 1,
      modules_errored: 1,
      calibrated_pass_rate: 0.5,
      raw_pass_rate: 0.6667,
      mean_pass_probability: 0.62,
      elapsed_ms: 900,
      cost_usd: 0.003,
      requests: 2,
      retries: 0,
    },
    checks: {
      single_responsibility: {
        threshold: 0.8,
        rubric_group: 'solid',
        passed: 1,
        raw_passed: 1,
        total: 2,
        pass_rate: 0.5,
        raw_pass_rate: 0.5,
        mean_pass_probability: 0.58,
        min_pass_probability: 0.21,
      },
      dependency_inversion: {
        threshold: 0.8,
        rubric_group: 'solid',
        passed: 0,
        raw_passed: 1,
        total: 2,
        pass_rate: 0,
        raw_pass_rate: 0.5,
        mean_pass_probability: 0.49,
        min_pass_probability: 0.26,
      },
      modular_organization: {
        threshold: 0.8,
        rubric_group: 'module-design',
        passed: 2,
        raw_passed: 2,
        total: 2,
        pass_rate: 1,
        raw_pass_rate: 1,
        mean_pass_probability: 0.91,
        min_pass_probability: 0.89,
      },
    },
    files: [],
    modules: [
      {
        name: 'auth',
        path: 'app/features/auth',
        status: 'scored',
        file_count: 4,
        bytes: 8200,
        pass_rate: 2 / 3,
        raw_pass_rate: 1,
        mean_pass_probability: 0.84,
        min_pass_probability: 0.72,
        failed_count: 1,
        hard_fail_count: 0,
        borderline_count: 1,
        checks: {
          single_responsibility: { choice: 'pass', model_choice: 'pass', pass_probability: 0.95, confidence: 0.9 },
          dependency_inversion: { choice: 'fail', model_choice: 'pass', pass_probability: 0.72, confidence: 0.8 },
          modular_organization: { choice: 'pass', model_choice: 'pass', pass_probability: 0.93, confidence: 0.9 },
        },
      },
      {
        name: 'billing',
        path: 'app/features/billing',
        status: 'scored',
        file_count: 8,
        bytes: 24500,
        pass_rate: 1 / 3,
        raw_pass_rate: 1 / 3,
        mean_pass_probability: 0.45,
        min_pass_probability: 0.21,
        failed_count: 2,
        hard_fail_count: 2,
        borderline_count: 0,
        checks: {
          single_responsibility: { choice: 'fail', model_choice: 'fail', pass_probability: 0.21, confidence: 0.92 },
          dependency_inversion: { choice: 'fail', model_choice: 'fail', pass_probability: 0.26, confidence: 0.88 },
          modular_organization: { choice: 'pass', model_choice: 'pass', pass_probability: 0.89, confidence: 0.9 },
        },
      },
      {
        name: 'monolith-checkout',
        path: 'app/features/checkout',
        status: 'skipped',
        skip_reason: 'oversize',
        error: 'Selected inputs exceed 128 KiB',
        file_count: 30,
        bytes: 192000,
        pass_rate: null,
        raw_pass_rate: null,
        mean_pass_probability: null,
        min_pass_probability: null,
        failed_count: 0,
        hard_fail_count: 0,
        borderline_count: 0,
        checks: {},
      },
      {
        name: 'xss</script><img src=x onerror=alert(9)>',
        path: 'app/features/bad',
        status: 'error',
        error: 'HTTP 500: <script>alert(10)</script>',
        file_count: 2,
        bytes: 1200,
        pass_rate: null,
        raw_pass_rate: null,
        mean_pass_probability: null,
        min_pass_probability: null,
        failed_count: 0,
        hard_fail_count: 0,
        borderline_count: 0,
        checks: {},
      },
    ],
  };

  const model = buildDashboardModel({
    repoSnapshots: [
      { file: '1-legacy.json', snapshot: legacyFileSnap },
      { file: '2-modules.json', snapshot: moduleSnap },
    ],
    fixtureSnapshots: [],
    catalog,
  });

  // Worst-first repo ordering: web-platform (2 hard, 3 total) before legacy-service (0 hard, 1 total)
  assert.deepEqual(model.repos.map((r) => r.name), ['web-platform', 'legacy-service']);
  assert.deepEqual(model.totals.total_findings, { total: 4, hard: 2, borderline: 2 });
  assert.deepEqual(model.totals.module_findings, { total: 3, hard: 2, borderline: 1 });
  assert.equal(model.totals.modules_scanned, 4);
  assert.equal(model.totals.modules_with_findings, 2);
  assert.equal(model.totals.modules_skipped, 1);
  assert.equal(model.totals.modules_errored, 1);

  // Legacy repo has null module_architecture and 1 borderline finding
  const legacyRepo = model.repos.find((r) => r.name === 'legacy-service')!;
  assert.equal(legacyRepo.module_architecture, null);
  assert.deepEqual(legacyRepo.total_findings, { total: 1, hard: 0, borderline: 1 });

  // Web-platform module_architecture ranked worst-first: billing (2 hard) -> auth (1 borderline) -> errored -> skipped
  const webArch = model.repos.find((r) => r.name === 'web-platform')!.module_architecture!;
  assert.deepEqual(
    webArch.modules.map((m) => m.name),
    ['billing', 'auth', 'xss</script><img src=x onerror=alert(9)>', 'monolith-checkout'],
  );
  assert.deepEqual(
    webArch.modules[0].failing_checks.map((c) => ({ id: c.check_id, severity: c.severity })),
    [
      { id: 'single_responsibility', severity: 'hard' },
      { id: 'dependency_inversion', severity: 'hard' },
    ],
  );
  assert.deepEqual(
    webArch.modules[1].failing_checks.map((c) => ({ id: c.check_id, severity: c.severity })),
    [{ id: 'dependency_inversion', severity: 'borderline' }],
  );

  // Render HTML and verify punch-list layout, offline self-containment, XSS escaping, and valid client script syntax
  const html = renderDashboardHtml(model);
  assert.ok(!/https?:\/\//i.test(html), 'Dashboard HTML must remain 100% offline with zero external URLs');
  assert.match(html, /Rubric Quality Punch-List/);
  assert.match(html, /Open findings/);
  assert.match(html, /Module architecture/);
  assert.match(html, /Repositories punch-list \(worst-first\)/);
  assert.match(html, /Feature \/ Module Architecture/);
  assert.ok(!html.includes('</script><img'), 'Raw </script> in module name must be escaped');
  assert.ok(!html.includes('<script>alert(10)</script>'), 'Raw <script> in module error must be escaped');

  // Verify embedded client JS compiles without syntax errors
  const scriptMatch = /<script id="dashboard-data" type="application\/json">[\s\S]*?<\/script>\n<script>([\s\S]*?)<\/script>/.exec(html);
  assert.ok(scriptMatch, 'Client script block must be present');
  assert.doesNotThrow(() => new Function(scriptMatch[1]), 'Inline dashboard client script must parse cleanly');
});

test('CLI supports --module-root and --skip-modules offline in --dry-run mode', (t) => {
  const root = makeTempDir(t, 'scan-cli-modules-test-');
  const { repoPath } = createSyntheticGitRepo(
    root,
    'cli-mod-repo',
    {
      'src/features/orders/order.kt': 'class Order(val id: String)\n',
      'src/features/payments/payment.kt': 'class Payment(val amount: Int)\n',
    },
  );

  const dataDir = join(root, 'data');
  const configPath = join(root, 'config.json');
  writeFileSync(configPath, JSON.stringify({
    dataDir,
    repos: [
      {
        name: 'cli-mod-repo',
        path: repoPath,
        sources: ['src'],
        modes: ['file'],
      },
    ],
    fixtures: { enabled: false },
  }));

  const env = { ...process.env };
  delete env.OPENROUTER_API_KEY;

  const proc = spawnSync(
    process.execPath,
    [SCAN_CLI, '--config', configPath, '--dry-run', '--module-root', 'src/features/*'],
    { env, encoding: 'utf8' },
  );
  assert.ifError(proc.error);
  assert.equal(proc.status, 0, proc.stderr || proc.stdout);
  assert.match(proc.stdout, /cli-mod-repo \[file\].*would scan 2 file\(s\)/);
  assert.match(proc.stdout, /cli-mod-repo \[code\].*would scan 2\/2 module\(s\)/);
});
