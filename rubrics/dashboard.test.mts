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
  loadScannerConfig,
  runScanner,
} from './scan.mts';
import {
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
