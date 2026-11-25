#!/usr/bin/env node
/**
 * Deterministic configurable local repo rubric scanner (`pnpm rubrics:scan`).
 * Evaluates configured repos against authoritative rubrics/*.json, caches unchanged
 * (repo, commit, mode, sources, exclude, rubric_hashes, model) runs, stores sanitized
 * score-only snapshots under <dataDir>/runs/, and rebuilds the static HTML dashboard.
 */
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import {
  DEFAULT_DECISION_MODEL,
  DEFAULT_FILE_MODE_DECISION_MODEL,
  PASS_THRESHOLD,
  runDecisionJudge,
  type JudgeResult,
  type Judgment,
} from '../skills/judge-code/scripts/decisions.mts';
import { readInputs, readPerFileInputs } from '../skills/judge-code/scripts/inputs.mts';
import {
  nonempty,
  object,
  resolveRubrics,
  type JudgeMode,
  type ResolvedRubric,
  type RubricTarget,
} from '../skills/judge-code/scripts/rubrics.mts';
import { readStructureInputs } from '../skills/judge-code/scripts/structure.mts';
import { generateDashboard } from './dashboard.mts';
import {
  REPO_ROOT,
  SNAPSHOT_SCHEMA_VERSION,
  compareCodepoint,
  computeHashesDigest,
  equalStringRecords,
  formatUtcFileTimestamp,
  hashJsonDirectory,
  loadSnapshotsFromDir,
  readAgentToolingGitInfo,
  readInstalledJudgeCodeInfo,
  readTargetRepoGitInfo,
  sanitizeSlugForFilename,
  type FixtureCheckSnapshot,
  type RepoSnapshot,
  type RubricFixturesSnapshot,
  type SnapshotCheckSummary,
  type SnapshotFileCheckScore,
  type SnapshotFileEntry,
} from './snapshot.mts';
import { AUTHORITATIVE_RUBRICS_DIR, sha256File } from './sync.mts';
import { DEFAULT_FIXTURES_DIR, runRubricHarness, type RubricHarnessReport } from './test-rubrics.mts';

const USAGE = `Usage: node rubrics/scan.mts --config <config.json> [options]

Scan configured local repositories and/or rubric fixtures, skip unchanged runs,
save sanitized score snapshots, and rebuild the offline HTML dashboard.

  --config FILE     Path to private scan config JSON (required)
  --dry-run         Validate config, discover files, report skip/run plan, rebuild dashboard (no API calls)
  --force           Re-run even when a matching snapshot already exists
  --repo NAME       Scan only the named repo(s) (repeatable)
  --skip-fixtures   Skip rubrics/fixtures health check even if enabled in config
  --no-dashboard    Do not rebuild the HTML dashboard after scanning
  --help, -h        Show this help
`;

export interface RepoScanConfig {
  name: string;
  path: string;
  sources: string[];
  modes: JudgeMode[];
  all: boolean;
  rubrics: string[];
  exclude: string[];
  conventions: string | null;
  requirements: string | null;
  model: string | null;
  concurrency: number;
  allowCredentials: boolean;
}

export interface FixturesScanConfig {
  enabled: boolean;
  repeats: number;
  model: string | null;
  concurrency: number;
}

export interface ScannerConfig {
  dataDir: string;
  out: string;
  repos: RepoScanConfig[];
  fixtures: FixturesScanConfig;
}

export interface RepoScanOutcome {
  repo: string;
  mode: JudgeMode;
  status: 'scanned' | 'skipped' | 'dry_run' | 'error';
  reason?: string;
  commit_short: string;
  dirty: boolean;
  file_count: number;
  check_count: number;
  calibrated_pass_rate?: number;
  raw_pass_rate?: number;
  cost_usd: number;
  snapshot_file?: string;
  error?: string;
}

export interface FixtureScanOutcome {
  status: 'scanned' | 'skipped' | 'dry_run' | 'disabled' | 'error';
  reason?: string;
  fixtures_total: number;
  fixtures_passed: number;
  checks_total: number;
  checks_passed: number;
  cost_usd: number;
  snapshot_file?: string;
  error?: string;
}

export interface ScanRunSummary {
  dry_run: boolean;
  repo_outcomes: RepoScanOutcome[];
  fixture_outcome: FixtureScanOutcome;
  dashboard_path: string | null;
  total_cost_usd: number;
  errors: string[];
}

function parsePositiveIntField(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value;
}

function parseStringArrayField(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array of strings`);
  return value.map((item, idx) => nonempty(item, `${label}[${idx}]`).trim());
}

function normalizeRelativeSource(source: string, repoPath: string, label: string): string {
  const cleaned = source.replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/+$/, '') || '.';
  if (isAbsolute(source)) {
    throw new Error(`${label} must be a path relative to the repo root (got "${source}")`);
  }
  if (cleaned.split('/').some((seg) => seg === '..')) {
    throw new Error(`${label} escapes the repository root: "${source}"`);
  }
  const resolvedPath = resolve(repoPath, cleaned);
  const rel = relative(repoPath, resolvedPath);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`${label} escapes the repository root: "${source}"`);
  }
  const stat = statSync(resolvedPath, { throwIfNoEntry: false });
  if (!stat?.isDirectory() && !stat?.isFile()) {
    throw new Error(`${label} not found: ${resolvedPath}`);
  }
  return rel ? rel.split(sep).join('/') : '.';
}

function parseOptionalModel(value: unknown, label: string): string | null {
  if (value === undefined || value === null) return null;
  const str = nonempty(value, label).trim();
  if (!/^[a-z0-9_.-]+\/[a-z0-9_.:-]+$/i.test(str)) {
    throw new Error(`${label} must be a full OpenRouter model ID (e.g. liquid/d1.2-ultra)`);
  }
  return str;
}

function parseOptionalDocPath(value: unknown, repoPath: string, label: string): string | null {
  if (value === undefined || value === null) return null;
  const raw = nonempty(value, label).trim();
  const full = isAbsolute(raw) ? raw : resolve(repoPath, raw);
  if (!statSync(full, { throwIfNoEntry: false })?.isFile()) {
    throw new Error(`${label} file not found: ${full}`);
  }
  return full;
}

export function loadScannerConfig(configPath: string): ScannerConfig {
  const absConfig = resolve(configPath);
  if (!statSync(absConfig, { throwIfNoEntry: false })?.isFile()) {
    throw new Error(`Config file not found: ${absConfig}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(absConfig, 'utf8'));
  } catch (error) {
    throw new Error(`Invalid JSON in ${absConfig}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const raw = object(parsed, 'config');
  const baseDir = dirname(absConfig);

  const rawDataDir = nonempty(raw.dataDir, 'config.dataDir').trim();
  const dataDir = isAbsolute(rawDataDir) ? rawDataDir : resolve(baseDir, rawDataDir);

  let out: string;
  if (raw.out === undefined || raw.out === null) {
    out = join(dataDir, 'index.html');
  } else {
    const rawOut = nonempty(raw.out, 'config.out').trim();
    out = isAbsolute(rawOut) ? rawOut : resolve(baseDir, rawOut);
  }
  if (extname(out).toLowerCase() !== '.html') {
    throw new Error('config.out must end in .html');
  }

  if (!Array.isArray(raw.repos)) {
    throw new Error('config.repos must be an array');
  }

  const seenNames = new Set<string>();
  const repos: RepoScanConfig[] = raw.repos.map((entry, index) => {
    const label = `config.repos[${index}]`;
    const rec = object(entry, label);
    const name = nonempty(rec.name, `${label}.name`).trim();
    if (!/^[a-zA-Z0-9._-]+$/.test(name)) {
      throw new Error(`${label}.name "${name}" may only contain letters, digits, ".", "_", and "-"`);
    }
    if (seenNames.has(name)) {
      throw new Error(`Duplicate repo name in config: ${name}`);
    }
    seenNames.add(name);

    const rawRepoPath = nonempty(rec.path, `${label}.path`).trim();
    const repoPath = isAbsolute(rawRepoPath) ? resolve(rawRepoPath) : resolve(baseDir, rawRepoPath);
    if (!statSync(repoPath, { throwIfNoEntry: false })?.isDirectory()) {
      throw new Error(`${label}.path is not an existing directory: ${repoPath}`);
    }

    const rawSources = parseStringArrayField(rec.sources, `${label}.sources`);
    if (rawSources.length === 0) {
      throw new Error(`${label}.sources must contain at least one relative path`);
    }
    const sources = [...new Set(rawSources.map((s, i) => normalizeRelativeSource(s, repoPath, `${label}.sources[${i}]`)))];

    const rawModes = parseStringArrayField(rec.modes, `${label}.modes`);
    if (rawModes.length === 0) {
      throw new Error(`${label}.modes must contain at least one mode (file, structure, or code)`);
    }
    const modes: JudgeMode[] = [];
    for (const m of rawModes) {
      if (m !== 'file' && m !== 'structure' && m !== 'code') {
        throw new Error(`${label}.modes contains unsupported mode "${m}" (expected file, structure, or code)`);
      }
      if (!modes.includes(m)) modes.push(m);
    }

    const rubrics = rec.rubrics === undefined ? [] : parseStringArrayField(rec.rubrics, `${label}.rubrics`);
    const all = rec.all === undefined
      ? rubrics.length === 0
      : typeof rec.all === 'boolean'
        ? rec.all
        : (() => { throw new Error(`${label}.all must be a boolean`); })();
    const exclude = rec.exclude === undefined ? [] : [...new Set(parseStringArrayField(rec.exclude, `${label}.exclude`))].sort(compareCodepoint);
    const conventions = parseOptionalDocPath(rec.conventions, repoPath, `${label}.conventions`);
    const requirements = parseOptionalDocPath(rec.requirements, repoPath, `${label}.requirements`);
    const model = parseOptionalModel(rec.model, `${label}.model`);
    const concurrency = rec.concurrency === undefined
      ? 8
      : parsePositiveIntField(rec.concurrency, `${label}.concurrency`);
    const allowCredentials = rec.allowCredentials === undefined
      ? false
      : typeof rec.allowCredentials === 'boolean'
        ? rec.allowCredentials
        : (() => { throw new Error(`${label}.allowCredentials must be a boolean`); })();

    return {
      name,
      path: repoPath,
      sources,
      modes,
      all,
      rubrics,
      exclude,
      conventions,
      requirements,
      model,
      concurrency,
      allowCredentials,
    };
  });

  let fixtures: FixturesScanConfig = { enabled: false, repeats: 2, model: null, concurrency: 8 };
  if (raw.fixtures !== undefined && raw.fixtures !== null) {
    const fx = object(raw.fixtures, 'config.fixtures');
    const enabled = fx.enabled === undefined
      ? true
      : typeof fx.enabled === 'boolean'
        ? fx.enabled
        : (() => { throw new Error('config.fixtures.enabled must be a boolean'); })();
    const repeats = fx.repeats === undefined ? 2 : parsePositiveIntField(fx.repeats, 'config.fixtures.repeats');
    const model = parseOptionalModel(fx.model, 'config.fixtures.model');
    const concurrency = fx.concurrency === undefined ? 8 : parsePositiveIntField(fx.concurrency, 'config.fixtures.concurrency');
    fixtures = { enabled, repeats, model, concurrency };
  }

  return { dataDir, out, repos, fixtures };
}

function listAuthoritativeRubricsForTarget(rubricsDir: string, target: RubricTarget): string[] {
  return readdirSync(rubricsDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => entry.name)
    .sort(compareCodepoint)
    .filter((file) => {
      const parsed = JSON.parse(readFileSync(join(rubricsDir, file), 'utf8')) as Record<string, unknown>;
      const t = parsed.target === undefined ? 'production_code' : parsed.target;
      return t === target;
    })
    .map((file) => file.slice(0, -'.json'.length));
}

export function resolveAuthoritativeRubricsForScan(options: {
  mode: JudgeMode;
  all: boolean;
  rubrics: string[];
  exclude: string[];
  hasRequirements: boolean;
  hasConventions: boolean;
  rubricsDir?: string;
}): {
  resolved: ResolvedRubric;
  rubricSlugs: string[];
  rubricHashes: Record<string, string>;
  rubricsDigest: string;
} {
  const rubricsDir = options.rubricsDir ?? AUTHORITATIVE_RUBRICS_DIR;
  const target: RubricTarget = options.mode === 'structure' ? 'project_structure' : 'production_code';
  const rubricPaths: string[] = [];
  const rubricHashes: Record<string, string> = {};
  const seenPaths = new Set<string>();

  const addAuthoritativeSlug = (slug: string) => {
    const fullPath = join(rubricsDir, `${slug}.json`);
    if (!statSync(fullPath, { throwIfNoEntry: false })?.isFile()) {
      throw new Error(`Unknown authoritative rubric "${slug}" in ${rubricsDir}`);
    }
    if (seenPaths.has(fullPath)) return;
    seenPaths.add(fullPath);
    rubricPaths.push(fullPath);
    rubricHashes[slug] = sha256File(fullPath);
  };

  if (options.all || (options.mode === 'structure' && options.rubrics.length === 0 && !options.hasConventions)) {
    for (const slug of listAuthoritativeRubricsForTarget(rubricsDir, target)) {
      addAuthoritativeSlug(slug);
    }
  }

  for (const spec of options.rubrics) {
    if (spec.endsWith('.json') || spec.includes('/') || spec.includes('\\')) {
      const fullPath = resolve(spec);
      if (!statSync(fullPath, { throwIfNoEntry: false })?.isFile()) {
        throw new Error(`Custom rubric file not found: ${spec}`);
      }
      if (!seenPaths.has(fullPath)) {
        seenPaths.add(fullPath);
        rubricPaths.push(fullPath);
        rubricHashes[spec] = sha256File(fullPath);
      }
    } else {
      addAuthoritativeSlug(spec);
    }
  }

  const resolved = resolveRubrics({
    mode: options.mode,
    rubrics: rubricPaths,
    all: false,
    exclude: options.exclude,
    hasRequirements: options.hasRequirements,
    hasConventions: options.hasConventions,
  });

  const rubricSlugs = Object.keys(rubricHashes).sort(compareCodepoint);
  return {
    resolved,
    rubricSlugs,
    rubricHashes,
    rubricsDigest: computeHashesDigest(rubricHashes),
  };
}

export interface RepoCacheKey {
  repo: string;
  commit: string;
  mode: JudgeMode;
  sources: string[];
  exclude: string[];
  rubric_hashes: Record<string, string>;
  model: string;
  conventions_hash: string | null;
  requirements_hash: string | null;
}

export function normalizeStringList(values: string[]): string[] {
  return [...new Set(values)].sort(compareCodepoint);
}

export function findMatchingRepoSnapshot(
  existing: RepoSnapshot[],
  key: RepoCacheKey,
): RepoSnapshot | null {
  const normSources = normalizeStringList(key.sources);
  const normExclude = normalizeStringList(key.exclude);
  for (let i = existing.length - 1; i >= 0; i -= 1) {
    const snap = existing[i];
    if (snap.repo.name !== key.repo) continue;
    if (snap.repo.commit !== key.commit) continue;
    if (snap.scan.mode !== key.mode) continue;
    if (snap.scan.model !== key.model) continue;
    if ((snap.scan.conventions_hash ?? null) !== key.conventions_hash) continue;
    if ((snap.scan.requirements_hash ?? null) !== key.requirements_hash) continue;
    const snapSources = normalizeStringList(snap.scan.sources);
    const snapExclude = normalizeStringList(snap.scan.exclude);
    if (snapSources.length !== normSources.length || snapSources.some((s, idx) => s !== normSources[idx])) {
      continue;
    }
    if (snapExclude.length !== normExclude.length || snapExclude.some((s, idx) => s !== normExclude[idx])) {
      continue;
    }
    if (!equalStringRecords(snap.rubric_hashes, key.rubric_hashes)) continue;
    return snap;
  }
  return null;
}

export function findMatchingFixtureSnapshot(
  existing: RubricFixturesSnapshot[],
  combinedHash: string,
  repeats: number,
  model: string | null,
): RubricFixturesSnapshot | null {
  for (let i = existing.length - 1; i >= 0; i -= 1) {
    const snap = existing[i];
    if (snap.combined_hash !== combinedHash) continue;
    if (snap.scan.repeats !== repeats) continue;
    if ((snap.scan.model ?? null) !== model) continue;
    return snap;
  }
  return null;
}

interface CostTracker {
  costUsd: number;
  hasCost: boolean;
  requests: number;
  transport: typeof fetch;
}

function createCostTrackingTransport(baseTransport: typeof fetch = fetch): CostTracker {
  const tracker: CostTracker = {
    costUsd: 0,
    hasCost: false,
    requests: 0,
    transport: async (input, init) => {
      tracker.requests += 1;
      const resp = await baseTransport(input, init);
      const text = await resp.text();
      if (resp.ok) {
        try {
          const parsed = JSON.parse(text) as { usage?: { cost?: unknown; total_cost?: unknown } };
          const cost = parsed?.usage?.cost ?? parsed?.usage?.total_cost;
          if (typeof cost === 'number' && Number.isFinite(cost) && cost >= 0) {
            tracker.costUsd += cost;
            tracker.hasCost = true;
          }
        } catch {
          // Ignore non-JSON or missing usage field; judge-code handles response validation.
        }
      }
      return new Response(text, {
        status: resp.status,
        statusText: resp.statusText,
        headers: resp.headers,
      });
    },
  };
  return tracker;
}

function sanitizeFileCheck(check: Judgment): SnapshotFileCheckScore {
  return {
    choice: check.choice,
    ...(check.model_choice !== undefined ? { model_choice: check.model_choice } : {}),
    pass_probability: typeof check.pass_probability === 'number' ? check.pass_probability : null,
    confidence: typeof check.confidence === 'number' ? check.confidence : null,
  };
}

function buildSnapshotFileEntry(path: string, checks: Record<string, Judgment>): SnapshotFileEntry {
  const entries = Object.entries(checks);
  const total = entries.length;
  const calibratedPassed = entries.filter(([, c]) => c.choice === 'pass').length;
  const rawPassed = entries.filter(([, c]) => (c.model_choice ?? c.choice) === 'pass').length;
  const probs = entries
    .map(([, c]) => c.pass_probability)
    .filter((p): p is number => typeof p === 'number' && Number.isFinite(p));
  const sanitizedChecks: Record<string, SnapshotFileCheckScore> = {};
  for (const [id, c] of entries) {
    sanitizedChecks[id] = sanitizeFileCheck(c);
  }
  return {
    path,
    pass_rate: total > 0 ? calibratedPassed / total : 0,
    raw_pass_rate: total > 0 ? rawPassed / total : 0,
    mean_pass_probability: probs.length > 0 ? probs.reduce((s, p) => s + p, 0) / probs.length : null,
    min_pass_probability: probs.length > 0 ? Math.min(...probs) : null,
    failed_count: total - calibratedPassed,
    checks: sanitizedChecks,
  };
}

function aggregateSnapshotChecksAndMetrics(
  fileEntries: SnapshotFileEntry[],
  resolved: ResolvedRubric,
): {
  checks: Record<string, SnapshotCheckSummary>;
  calibratedPassRate: number;
  rawPassRate: number;
  allFilesPassRate: number;
  meanPassProbability: number | null;
} {
  const groupByCheck = new Map<string, string>();
  for (const [group, ids] of Object.entries(resolved.groups)) {
    for (const id of ids) {
      if (!groupByCheck.has(id)) groupByCheck.set(id, group);
    }
  }

  const questionIds = Object.keys(resolved.questions);
  const totalTargets = fileEntries.length;
  const checks: Record<string, SnapshotCheckSummary> = {};
  let totalCalibratedPassed = 0;
  let totalRawPassed = 0;
  let totalPairs = 0;
  const allProbs: number[] = [];

  for (const id of questionIds) {
    const scores = fileEntries
      .map((entry) => entry.checks[id])
      .filter((c): c is SnapshotFileCheckScore => c !== undefined);
    const passed = scores.filter((c) => c.choice === 'pass').length;
    const rawPassed = scores.filter((c) => (c.model_choice ?? c.choice) === 'pass').length;
    const probs = scores
      .map((c) => c.pass_probability)
      .filter((p): p is number => typeof p === 'number' && Number.isFinite(p));
    totalCalibratedPassed += passed;
    totalRawPassed += rawPassed;
    totalPairs += scores.length;
    for (const p of probs) allProbs.push(p);

    checks[id] = {
      threshold: resolved.thresholds[id] ?? PASS_THRESHOLD,
      rubric_group: groupByCheck.get(id) ?? null,
      passed,
      raw_passed: rawPassed,
      total: scores.length,
      pass_rate: scores.length > 0 ? passed / scores.length : 0,
      raw_pass_rate: scores.length > 0 ? rawPassed / scores.length : 0,
      mean_pass_probability: probs.length > 0 ? probs.reduce((s, p) => s + p, 0) / probs.length : null,
      min_pass_probability: probs.length > 0 ? Math.min(...probs) : null,
    };
  }

  const allFilesPassedChecks = Object.values(checks).filter((c) => c.total > 0 && c.passed === c.total).length;
  return {
    checks,
    calibratedPassRate: totalPairs > 0 ? totalCalibratedPassed / totalPairs : 0,
    rawPassRate: totalPairs > 0 ? totalRawPassed / totalPairs : 0,
    allFilesPassRate: questionIds.length > 0 && totalTargets > 0 ? allFilesPassedChecks / questionIds.length : 0,
    meanPassProbability: allProbs.length > 0 ? allProbs.reduce((s, p) => s + p, 0) / allProbs.length : null,
  };
}

function defaultModelForMode(mode: JudgeMode, override: string | null): string {
  return override ?? (mode === 'file' ? DEFAULT_FILE_MODE_DECISION_MODEL : DEFAULT_DECISION_MODEL);
}

function collectMultiSourceFiles(
  repo: RepoScanConfig,
  scratchOut: string,
): { files: Record<string, string>; conventions?: string; requirements?: string } {
  const mergedFiles: Record<string, string> = {};
  let conventions: string | undefined;
  let requirements: string | undefined;

  for (let i = 0; i < repo.sources.length; i += 1) {
    const srcRel = repo.sources[i];
    const absSrc = resolve(repo.path, srcRel);
    let loaded;
    try {
      loaded = readPerFileInputs({
        source: absSrc,
        out: join(scratchOut, `collect-${i}`),
        conventions: repo.conventions ?? undefined,
        requirements: repo.requirements ?? undefined,
        allowCredentials: repo.allowCredentials,
      });
    } catch (error) {
      if (repo.sources.length > 1 && error instanceof Error) {
        throw new Error(`${srcRel}: ${error.message}`);
      }
      throw error;
    }
    if (loaded.conventions !== undefined) conventions = loaded.conventions;
    if (loaded.requirements !== undefined) requirements = loaded.requirements;
    const isFileSource = statSync(absSrc).isFile();
    for (const [relFile, content] of Object.entries(loaded.files)) {
      const repoRel = isFileSource
        ? srcRel
        : srcRel === '.'
          ? relFile
          : `${srcRel}/${relFile}`;
      mergedFiles[repoRel] = content;
    }
  }
  return { files: mergedFiles, conventions, requirements };
}

function writePrivateSnapshot(runsDir: string, fileName: string, payload: unknown): string {
  mkdirSync(runsDir, { recursive: true, mode: 0o700 });
  const fullPath = join(runsDir, fileName);
  writeFileSync(fullPath, `${JSON.stringify(payload, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  return fullPath;
}

function buildFixtureSnapshotFromReport(
  report: RubricHarnessReport,
  options: {
    judgeVersion: string;
    latestTag: string | null;
    headSha: string | null;
    rubricHashes: Record<string, string>;
    fixtureHashes: Record<string, string>;
    combinedHash: string;
    model: string | null;
    costUsd: number | null;
    requests: number;
    timestamp: string;
  },
): RubricFixturesSnapshot {
  const checks: FixtureCheckSnapshot[] = [];
  const margins: number[] = [];
  const jitters: number[] = [];

  for (const fx of report.fixtures) {
    for (const c of fx.checks) {
      const numericProbs = c.pass_probabilities.filter((p): p is number => typeof p === 'number' && Number.isFinite(p));
      const meanProb = numericProbs.length > 0
        ? numericProbs.reduce((s, p) => s + p, 0) / numericProbs.length
        : null;
      const jitter = c.min_pass_probability !== null && c.max_pass_probability !== null
        ? Number((c.max_pass_probability - c.min_pass_probability).toFixed(6))
        : null;
      let margin: number | null = null;
      if (c.pass_threshold !== null) {
        if (c.expected === 'pass' && c.min_pass_probability !== null) {
          margin = Number((c.min_pass_probability - c.pass_threshold).toFixed(6));
        } else if (c.expected === 'fail' && c.max_pass_probability !== null) {
          margin = Number((c.pass_threshold - c.max_pass_probability).toFixed(6));
        }
      }
      if (margin !== null) margins.push(margin);
      if (jitter !== null) jitters.push(jitter);
      checks.push({
        fixture_id: fx.id,
        mode: fx.mode,
        rubric: fx.rubric,
        check_id: c.check_id,
        expected: c.expected,
        passed: c.passed,
        matches: c.matches,
        repeats: c.repeats,
        pass_threshold: c.pass_threshold,
        min_pass_probability: c.min_pass_probability,
        max_pass_probability: c.max_pass_probability,
        mean_pass_probability: meanProb,
        margin,
        jitter,
      });
    }
  }

  return {
    schema_version: SNAPSHOT_SCHEMA_VERSION,
    kind: 'rubric_fixtures',
    timestamp: options.timestamp,
    judge_version: options.judgeVersion,
    agent_tooling_tag: options.latestTag,
    agent_tooling_commit: options.headSha,
    rubric_hashes: options.rubricHashes,
    fixture_hashes: options.fixtureHashes,
    combined_hash: options.combinedHash,
    scan: {
      backend: report.backend,
      model: options.model,
      repeats: report.repeats,
    },
    metrics: {
      status: report.status === 'passed' ? 'passed' : 'failed',
      fixtures_total: report.fixtures_total,
      fixtures_passed: report.fixtures_passed,
      fixture_pass_rate: report.fixtures_total > 0 ? report.fixtures_passed / report.fixtures_total : 0,
      checks_total: report.checks_total,
      checks_passed: report.checks_passed,
      check_pass_rate: report.checks_total > 0 ? report.checks_passed / report.checks_total : 0,
      min_margin: margins.length > 0 ? Math.min(...margins) : null,
      mean_margin: margins.length > 0 ? margins.reduce((s, m) => s + m, 0) / margins.length : null,
      max_jitter: jitters.length > 0 ? Math.max(...jitters) : null,
      mean_jitter: jitters.length > 0 ? jitters.reduce((s, j) => s + j, 0) / jitters.length : null,
      elapsed_ms: report.elapsed_ms,
      cost_usd: options.costUsd,
      requests: options.requests,
    },
    checks,
  };
}

export interface RunScannerOptions {
  config: ScannerConfig;
  dryRun?: boolean;
  force?: boolean;
  repoFilter?: string[];
  skipFixtures?: boolean;
  noDashboard?: boolean;
  rubricsDir?: string;
  fixturesDir?: string;
  repoRoot?: string;
  transport?: typeof fetch;
}

export async function runScanner(options: RunScannerOptions): Promise<ScanRunSummary> {
  const { config } = options;
  const dryRun = options.dryRun ?? false;
  const force = options.force ?? false;
  const skipFixtures = options.skipFixtures ?? false;
  const noDashboard = options.noDashboard ?? false;
  const rubricsDir = options.rubricsDir ?? AUTHORITATIVE_RUBRICS_DIR;
  const fixturesDir = options.fixturesDir ?? DEFAULT_FIXTURES_DIR;
  const repoRoot = options.repoRoot ?? REPO_ROOT;

  const repoFilter = options.repoFilter ?? [];
  const configuredNames = new Set(config.repos.map((r) => r.name));
  for (const name of repoFilter) {
    if (!configuredNames.has(name)) {
      throw new Error(`Unknown --repo "${name}". Configured repos: ${[...configuredNames].join(', ') || '(none)'}`);
    }
  }
  const selectedRepos = repoFilter.length > 0
    ? config.repos.filter((r) => repoFilter.includes(r.name))
    : config.repos;

  mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  const runsDir = join(config.dataDir, 'runs');
  mkdirSync(runsDir, { recursive: true, mode: 0o700 });

  const existing = loadSnapshotsFromDir(config.dataDir);
  const existingRepoSnapshots = existing.repoSnapshots.map((r) => r.snapshot);
  const existingFixtureSnapshots = existing.fixtureSnapshots.map((r) => r.snapshot);
  const agentGit = readAgentToolingGitInfo(repoRoot);

  const repoOutcomes: RepoScanOutcome[] = [];
  const errors: string[] = [];
  let totalCostUsd = 0;

  for (const repo of selectedRepos) {
    const gitInfo = readTargetRepoGitInfo(repo.path);
    const installedSkill = readInstalledJudgeCodeInfo(repo.path);
    const conventionsHash = repo.conventions ? sha256File(repo.conventions) : null;
    const requirementsHash = repo.requirements ? sha256File(repo.requirements) : null;

    for (const mode of repo.modes) {
      const model = defaultModelForMode(mode, repo.model);
      const { resolved, rubricSlugs, rubricHashes, rubricsDigest } = resolveAuthoritativeRubricsForScan({
        mode,
        all: repo.all,
        rubrics: repo.rubrics,
        exclude: repo.exclude,
        hasRequirements: repo.requirements !== null,
        hasConventions: repo.conventions !== null,
        rubricsDir,
      });

      const checkCount = Object.keys(resolved.questions).length;
      const cacheKey: RepoCacheKey = {
        repo: repo.name,
        commit: gitInfo.commit,
        mode,
        sources: repo.sources,
        exclude: repo.exclude,
        rubric_hashes: rubricHashes,
        model,
        conventions_hash: conventionsHash,
        requirements_hash: requirementsHash,
      };

      const cached = !force ? findMatchingRepoSnapshot(existingRepoSnapshots, cacheKey) : null;
      if (cached) {
        repoOutcomes.push({
          repo: repo.name,
          mode,
          status: 'skipped',
          reason: 'unchanged',
          commit_short: gitInfo.commit_short,
          dirty: gitInfo.dirty,
          file_count: cached.metrics.file_count,
          check_count: checkCount,
          calibrated_pass_rate: cached.metrics.calibrated_pass_rate,
          raw_pass_rate: cached.metrics.raw_pass_rate,
          cost_usd: 0,
        });
        continue;
      }

      const scratchRoot = mkdtempSync(join(tmpdir(), 'rubric-scan-'));
      chmodSync(scratchRoot, 0o700);
      const runStart = performance.now();
      const tracker = createCostTrackingTransport(options.transport ?? fetch);

      try {
        if (mode === 'file') {
          const collected = collectMultiSourceFiles(repo, scratchRoot);
          const fileCount = Object.keys(collected.files).length;
          if (dryRun) {
            repoOutcomes.push({
              repo: repo.name,
              mode,
              status: 'dry_run',
              reason: 'would run',
              commit_short: gitInfo.commit_short,
              dirty: gitInfo.dirty,
              file_count: fileCount,
              check_count: checkCount,
              cost_usd: 0,
            });
            continue;
          }

          const result: JudgeResult = await runDecisionJudge(
            {
              mode: 'file',
              files: collected.files,
              conventions: collected.conventions,
              requirements: collected.requirements,
              rubric: resolved,
              model,
              concurrency: repo.concurrency,
              out: join(scratchRoot, 'judge'),
              dryRun: false,
            },
            tracker.transport,
          );

          if (result.status !== 'scored' || !result.file_results) {
            throw new Error(result.error ?? 'Per-file judging failed');
          }

          const fileEntries = result.file_results
            .filter((entry) => entry.status === 'scored' && entry.checks !== null)
            .map((entry) => buildSnapshotFileEntry(entry.file, entry.checks!));
          const agg = aggregateSnapshotChecksAndMetrics(fileEntries, resolved);
          const timestamp = new Date().toISOString();
          const snapshot: RepoSnapshot = {
            schema_version: SNAPSHOT_SCHEMA_VERSION,
            kind: 'repo',
            timestamp,
            repo: {
              name: repo.name,
              branch: gitInfo.branch,
              commit: gitInfo.commit,
              commit_short: gitInfo.commit_short,
              dirty: gitInfo.dirty,
              installed_judge_code: installedSkill,
            },
            scan: {
              mode,
              sources: repo.sources,
              rubrics: rubricSlugs,
              rubric_id: resolved.rubric,
              rubric_groups: resolved.groups,
              exclude: repo.exclude,
              model,
              returned_model: result.returned_model,
              backend: 'openrouter',
              conventions_hash: conventionsHash,
              requirements_hash: requirementsHash,
            },
            judge_version: agentGit.judge_version,
            agent_tooling_tag: agentGit.latest_tag,
            agent_tooling_commit: agentGit.head_sha,
            rubric_hashes: rubricHashes,
            rubrics_digest: rubricsDigest,
            metrics: {
              file_count: fileEntries.length,
              target_count: fileEntries.length,
              check_count: checkCount,
              calibrated_pass_rate: agg.calibratedPassRate,
              raw_pass_rate: agg.rawPassRate,
              all_files_pass_rate: agg.allFilesPassRate,
              mean_pass_probability: agg.meanPassProbability,
              elapsed_ms: Math.round(performance.now() - runStart),
              cost_usd: tracker.hasCost ? Number(tracker.costUsd.toFixed(6)) : null,
              requests: tracker.requests,
              retries: result.retries ?? 0,
            },
            checks: agg.checks,
            files: fileEntries,
          };

          const fileName = `${formatUtcFileTimestamp(new Date(timestamp))}--${sanitizeSlugForFilename(repo.name)}--${mode}.json`;
          const written = writePrivateSnapshot(runsDir, fileName, snapshot);
          existingRepoSnapshots.push(snapshot);
          if (tracker.hasCost) totalCostUsd += tracker.costUsd;

          repoOutcomes.push({
            repo: repo.name,
            mode,
            status: 'scanned',
            commit_short: gitInfo.commit_short,
            dirty: gitInfo.dirty,
            file_count: fileEntries.length,
            check_count: checkCount,
            calibrated_pass_rate: agg.calibratedPassRate,
            raw_pass_rate: agg.rawPassRate,
            cost_usd: tracker.hasCost ? tracker.costUsd : 0,
            snapshot_file: written,
          });
        } else {
          // mode === 'structure' || mode === 'code'
          const fileEntries: SnapshotFileEntry[] = [];
          const returnedModels = new Set<string>();
          let totalDiscoveredFiles = 0;
          let totalRetries = 0;

          for (let srcIdx = 0; srcIdx < repo.sources.length; srcIdx += 1) {
            const srcRel = repo.sources[srcIdx];
            const absSrc = resolve(repo.path, srcRel);
            const targetOut = join(scratchRoot, `target-${srcIdx}`);

            if (mode === 'structure') {
              const loaded = readStructureInputs({
                source: absSrc,
                out: targetOut,
                conventions: repo.conventions ?? undefined,
                requirements: repo.requirements ?? undefined,
                allowCredentials: repo.allowCredentials,
              });
              totalDiscoveredFiles += loaded.manifest.total_files;
              if (dryRun) continue;

              const result = await runDecisionJudge(
                {
                  mode: 'structure',
                  structure: loaded.manifest,
                  conventions: loaded.conventions,
                  requirements: loaded.requirements,
                  rubric: resolved,
                  model,
                  out: loaded.out,
                  dryRun: false,
                },
                tracker.transport,
              );
              if (result.status !== 'scored' || !result.quality) {
                throw new Error(`${srcRel}: ${result.error ?? 'Structure judging failed'}`);
              }
              if (result.returned_model) returnedModels.add(result.returned_model);
              totalRetries += result.retries ?? 0;
              fileEntries.push(buildSnapshotFileEntry(srcRel, result.quality.checks));
            } else {
              const loaded = readInputs({
                source: absSrc,
                out: targetOut,
                conventions: repo.conventions ?? undefined,
                requirements: repo.requirements ?? undefined,
                allowCredentials: repo.allowCredentials,
              });
              totalDiscoveredFiles += Object.keys(loaded.files).length;
              if (dryRun) continue;

              const result = await runDecisionJudge(
                {
                  mode: 'code',
                  files: loaded.files,
                  conventions: loaded.conventions,
                  requirements: loaded.requirements,
                  rubric: resolved,
                  model,
                  out: loaded.out,
                  dryRun: false,
                },
                tracker.transport,
              );
              if (result.status !== 'scored' || !result.quality) {
                throw new Error(`${srcRel}: ${result.error ?? 'Code judging failed'}`);
              }
              if (result.returned_model) returnedModels.add(result.returned_model);
              totalRetries += result.retries ?? 0;
              fileEntries.push(buildSnapshotFileEntry(srcRel, result.quality.checks));
            }
          }

          if (dryRun) {
            repoOutcomes.push({
              repo: repo.name,
              mode,
              status: 'dry_run',
              reason: 'would run',
              commit_short: gitInfo.commit_short,
              dirty: gitInfo.dirty,
              file_count: totalDiscoveredFiles,
              check_count: checkCount,
              cost_usd: 0,
            });
            continue;
          }

          const agg = aggregateSnapshotChecksAndMetrics(fileEntries, resolved);
          const timestamp = new Date().toISOString();
          const snapshot: RepoSnapshot = {
            schema_version: SNAPSHOT_SCHEMA_VERSION,
            kind: 'repo',
            timestamp,
            repo: {
              name: repo.name,
              branch: gitInfo.branch,
              commit: gitInfo.commit,
              commit_short: gitInfo.commit_short,
              dirty: gitInfo.dirty,
              installed_judge_code: installedSkill,
            },
            scan: {
              mode,
              sources: repo.sources,
              rubrics: rubricSlugs,
              rubric_id: resolved.rubric,
              rubric_groups: resolved.groups,
              exclude: repo.exclude,
              model,
              returned_model: [...returnedModels].join(', ') || null,
              backend: 'openrouter',
              conventions_hash: conventionsHash,
              requirements_hash: requirementsHash,
            },
            judge_version: agentGit.judge_version,
            agent_tooling_tag: agentGit.latest_tag,
            agent_tooling_commit: agentGit.head_sha,
            rubric_hashes: rubricHashes,
            rubrics_digest: rubricsDigest,
            metrics: {
              file_count: totalDiscoveredFiles,
              target_count: fileEntries.length,
              check_count: checkCount,
              calibrated_pass_rate: agg.calibratedPassRate,
              raw_pass_rate: agg.rawPassRate,
              mean_pass_probability: agg.meanPassProbability,
              elapsed_ms: Math.round(performance.now() - runStart),
              cost_usd: tracker.hasCost ? Number(tracker.costUsd.toFixed(6)) : null,
              requests: tracker.requests,
              retries: totalRetries,
            },
            checks: agg.checks,
            files: fileEntries,
          };

          const fileName = `${formatUtcFileTimestamp(new Date(timestamp))}--${sanitizeSlugForFilename(repo.name)}--${mode}.json`;
          const written = writePrivateSnapshot(runsDir, fileName, snapshot);
          existingRepoSnapshots.push(snapshot);
          if (tracker.hasCost) totalCostUsd += tracker.costUsd;

          repoOutcomes.push({
            repo: repo.name,
            mode,
            status: 'scanned',
            commit_short: gitInfo.commit_short,
            dirty: gitInfo.dirty,
            file_count: totalDiscoveredFiles,
            check_count: checkCount,
            calibrated_pass_rate: agg.calibratedPassRate,
            raw_pass_rate: agg.rawPassRate,
            cost_usd: tracker.hasCost ? tracker.costUsd : 0,
            snapshot_file: written,
          });
        }
      } catch (error) {
        const key = process.env.OPENROUTER_API_KEY?.trim();
        const rawMsg = error instanceof Error ? error.message : String(error);
        const msg = key ? rawMsg.replaceAll(key, '[redacted]') : rawMsg;
        errors.push(`${repo.name} (${mode}): ${msg}`);
        repoOutcomes.push({
          repo: repo.name,
          mode,
          status: 'error',
          commit_short: gitInfo.commit_short,
          dirty: gitInfo.dirty,
          file_count: 0,
          check_count: checkCount,
          cost_usd: tracker.hasCost ? tracker.costUsd : 0,
          error: msg,
        });
      } finally {
        rmSync(scratchRoot, { recursive: true, force: true });
      }
    }
  }

  // Rubric fixtures health check
  let fixtureOutcome: FixtureScanOutcome;
  if (!config.fixtures.enabled || skipFixtures) {
    fixtureOutcome = {
      status: 'disabled',
      reason: skipFixtures ? 'skipped via --skip-fixtures' : 'disabled in config',
      fixtures_total: 0,
      fixtures_passed: 0,
      checks_total: 0,
      checks_passed: 0,
      cost_usd: 0,
    };
  } else {
    const rubricHashes = hashJsonDirectory(rubricsDir);
    const fixtureHashes = hashJsonDirectory(fixturesDir);
    const combinedHash = computeHashesDigest({
      ...Object.fromEntries(Object.entries(rubricHashes).map(([k, v]) => [`rubric:${k}`, v])),
      ...Object.fromEntries(Object.entries(fixtureHashes).map(([k, v]) => [`fixture:${k}`, v])),
    });
    const cachedFx = !force
      ? findMatchingFixtureSnapshot(existingFixtureSnapshots, combinedHash, config.fixtures.repeats, config.fixtures.model)
      : null;

    if (cachedFx) {
      fixtureOutcome = {
        status: 'skipped',
        reason: 'unchanged',
        fixtures_total: cachedFx.metrics.fixtures_total,
        fixtures_passed: cachedFx.metrics.fixtures_passed,
        checks_total: cachedFx.metrics.checks_total,
        checks_passed: cachedFx.metrics.checks_passed,
        cost_usd: 0,
      };
    } else {
      const tracker = createCostTrackingTransport(options.transport ?? fetch);
      try {
        const report = await runRubricHarness({
          fixturesDir,
          rubricsDir,
          repeats: config.fixtures.repeats,
          model: config.fixtures.model ?? undefined,
          concurrency: config.fixtures.concurrency,
          dryRun,
          transport: tracker.transport,
        });
        if (dryRun) {
          fixtureOutcome = {
            status: 'dry_run',
            reason: 'would run',
            fixtures_total: report.fixtures_total,
            fixtures_passed: report.fixtures_passed,
            checks_total: report.checks_total,
            checks_passed: report.checks_passed,
            cost_usd: 0,
          };
        } else {
          const timestamp = new Date().toISOString();
          const snapshot = buildFixtureSnapshotFromReport(report, {
            judgeVersion: agentGit.judge_version,
            latestTag: agentGit.latest_tag,
            headSha: agentGit.head_sha,
            rubricHashes,
            fixtureHashes,
            combinedHash,
            model: config.fixtures.model,
            costUsd: tracker.hasCost ? Number(tracker.costUsd.toFixed(6)) : null,
            requests: tracker.requests,
            timestamp,
          });
          const fileName = `${formatUtcFileTimestamp(new Date(timestamp))}--agent-tooling--rubric-fixtures.json`;
          const written = writePrivateSnapshot(runsDir, fileName, snapshot);
          if (tracker.hasCost) totalCostUsd += tracker.costUsd;
          fixtureOutcome = {
            status: 'scanned',
            fixtures_total: report.fixtures_total,
            fixtures_passed: report.fixtures_passed,
            checks_total: report.checks_total,
            checks_passed: report.checks_passed,
            cost_usd: tracker.hasCost ? tracker.costUsd : 0,
            snapshot_file: written,
          };
        }
      } catch (error) {
        const key = process.env.OPENROUTER_API_KEY?.trim();
        const rawMsg = error instanceof Error ? error.message : String(error);
        const msg = key ? rawMsg.replaceAll(key, '[redacted]') : rawMsg;
        errors.push(`rubrics/fixtures: ${msg}`);
        fixtureOutcome = {
          status: 'error',
          fixtures_total: 0,
          fixtures_passed: 0,
          checks_total: 0,
          checks_passed: 0,
          cost_usd: tracker.hasCost ? tracker.costUsd : 0,
          error: msg,
        };
      }
    }
  }

  let dashboardPath: string | null = null;
  if (!noDashboard) {
    const built = generateDashboard({
      dataDir: config.dataDir,
      outFile: config.out,
      rubricsDir,
      repoRoot,
    });
    dashboardPath = built.outPath;
  }

  return {
    dry_run: dryRun,
    repo_outcomes: repoOutcomes,
    fixture_outcome: fixtureOutcome,
    dashboard_path: dashboardPath,
    total_cost_usd: Number(totalCostUsd.toFixed(6)),
    errors,
  };
}

export function formatScanSummary(summary: ScanRunSummary): string {
  const lines: string[] = [];
  lines.push(`rubrics:scan${summary.dry_run ? ' [DRY RUN]' : ''}`);
  lines.push('');

  for (const r of summary.repo_outcomes) {
    const dirtyTag = r.dirty ? ' (dirty)' : '';
    if (r.status === 'skipped') {
      lines.push(
        `  SKIP  ${r.repo} [${r.mode}] @ ${r.commit_short}${dirtyTag} — skipped (unchanged) `
        + `(${r.file_count} files, calibrated ${((r.calibrated_pass_rate ?? 0) * 100).toFixed(1)}%)`,
      );
    } else if (r.status === 'dry_run') {
      lines.push(
        `  PLAN  ${r.repo} [${r.mode}] @ ${r.commit_short}${dirtyTag} — would scan `
        + `${r.file_count} file(s) x ${r.check_count} check(s)`,
      );
    } else if (r.status === 'scanned') {
      const costStr = r.cost_usd > 0 ? `, $${r.cost_usd.toFixed(4)}` : '';
      lines.push(
        `  DONE  ${r.repo} [${r.mode}] @ ${r.commit_short}${dirtyTag} — `
        + `${r.file_count} file(s), calibrated ${((r.calibrated_pass_rate ?? 0) * 100).toFixed(1)}% `
        + `(raw ${((r.raw_pass_rate ?? 0) * 100).toFixed(1)}%${costStr})`,
      );
    } else {
      lines.push(`  ERR   ${r.repo} [${r.mode}] @ ${r.commit_short}${dirtyTag} — ${r.error ?? 'failed'}`);
    }
  }

  const fx = summary.fixture_outcome;
  if (fx.status === 'skipped') {
    lines.push(`  SKIP  rubrics/fixtures — skipped (unchanged) (${fx.checks_passed}/${fx.checks_total} checks)`);
  } else if (fx.status === 'dry_run') {
    lines.push(`  PLAN  rubrics/fixtures — would run ${fx.fixtures_total} fixture(s) (${fx.checks_total} checks)`);
  } else if (fx.status === 'scanned') {
    const costStr = fx.cost_usd > 0 ? `, $${fx.cost_usd.toFixed(4)}` : '';
    lines.push(
      `  DONE  rubrics/fixtures — ${fx.fixtures_passed}/${fx.fixtures_total} fixtures `
      + `(${fx.checks_passed}/${fx.checks_total} checks${costStr})`,
    );
  } else if (fx.status === 'error') {
    lines.push(`  ERR   rubrics/fixtures — ${fx.error ?? 'failed'}`);
  }

  lines.push('');
  lines.push(`Total OpenRouter cost: $${summary.total_cost_usd.toFixed(4)}`);
  if (summary.dashboard_path) {
    lines.push(`Dashboard: ${summary.dashboard_path}`);
  }
  return lines.join('\n');
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      config: { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      force: { type: 'boolean', default: false },
      repo: { type: 'string', multiple: true },
      'skip-fixtures': { type: 'boolean', default: false },
      'no-dashboard': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });

  if (values.help) {
    console.log(USAGE);
    return;
  }
  if (!values.config?.trim()) {
    throw new Error(`Missing required --config <config.json>\n\n${USAGE}`);
  }

  const config = loadScannerConfig(values.config);
  const summary = await runScanner({
    config,
    dryRun: values['dry-run'],
    force: values.force,
    repoFilter: values.repo,
    skipFixtures: values['skip-fixtures'],
    noDashboard: values['no-dashboard'],
  });

  console.log(formatScanSummary(summary));
  if (summary.errors.length > 0) {
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    const key = process.env.OPENROUTER_API_KEY?.trim();
    const message = error instanceof Error ? error.message : String(error);
    console.error(key ? message.replaceAll(key, '[redacted]') : message);
    process.exitCode = 1;
  });
}
