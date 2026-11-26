#!/usr/bin/env node
/**
 * Deterministic configurable local repo rubric scanner (`pnpm rubrics:scan`).
 * Evaluates configured repos against authoritative rubrics/*.json, caches unchanged
 * (repo, commit, mode, sources, exclude, rubric_hashes, model) runs, stores sanitized
 * score-only snapshots under <dataDir>/runs/, and rebuilds the static HTML dashboard.
 */
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import {
  DEFAULT_DECISION_MODEL,
  DEFAULT_FILE_MODE_DECISION_MODEL,
  PASS_THRESHOLD,
  runDecisionJudge,
  runWithConcurrency,
  type JudgeResult,
  type Judgment,
} from '../skills/judge-code/scripts/decisions.mts';
import {
  ALLOWED_DOT_DIRS,
  SKIP_DIRS,
  compileIgnoreMatcher,
  isTestOrSupportDirName,
  isTestOrSupportPath,
  readInputs,
  readPerFileInputs,
} from '../skills/judge-code/scripts/inputs.mts';
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
  countChecksFindings,
  equalStringRecords,
  formatUtcFileTimestamp,
  hashJsonDirectory,
  loadSnapshotsFromDir,
  readAgentToolingGitInfo,
  readInstalledJudgeCodeInfo,
  readTargetRepoGitInfo,
  sanitizeSlugForFilename,
  sumFindingCounts,
  type FixtureCheckSnapshot,
  type ModuleSkipReason,
  type RepoSnapshot,
  type RubricFixturesSnapshot,
  type SnapshotCheckSummary,
  type SnapshotFileCheckScore,
  type SnapshotFileEntry,
  type SnapshotModuleEntry,
  type SnapshotModuleTarget,
} from './snapshot.mts';
import { AUTHORITATIVE_RUBRICS_DIR, sha256File } from './sync.mts';
import { DEFAULT_FIXTURES_DIR, runRubricHarness, type RubricHarnessReport } from './test-rubrics.mts';

const USAGE = `Usage: node rubrics/scan.mts --config <config.json> [options]

Scan configured local repositories and/or rubric fixtures, skip unchanged runs,
save sanitized score snapshots, and rebuild the offline HTML dashboard.

  --config FILE       Path to private scan config JSON (required)
  --dry-run           Validate config, discover files/modules, report skip/run plan, rebuild dashboard (no API calls)
  --force             Re-run even when a matching snapshot already exists
  --repo NAME         Scan only the named repo(s) (repeatable)
  --modules           Include module-level architectural scans (even if "code" is not in repo modes)
  --skip-modules      Skip module-level architectural scans even if modules/moduleRoots are configured
  --module-root DIR   Additional repo-relative module root or wildcard (repeatable; e.g. app/features/*)
  --skip-fixtures     Skip rubrics/fixtures health check even if enabled in config
  --no-dashboard      Do not rebuild the HTML dashboard after scanning
  --help, -h          Show this help
`;

export interface ModuleScanConfig {
  name: string;
  path: string;
  ignore: string[];
}

export interface RepoScanConfig {
  name: string;
  path: string;
  sources: string[];
  modes: JudgeMode[];
  modules: ModuleScanConfig[];
  moduleRoots: string[];
  moduleModel: string | null;
  all: boolean;
  rubrics: string[];
  exclude: string[];
  ignore: string[];
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
  module_count?: number;
  modules_scored?: number;
  modules_skipped?: number;
  modules_errored?: number;
  findings_total?: number;
  findings_hard?: number;
  findings_borderline?: number;
  skipped_modules?: Array<{ name: string; path: string; reason: ModuleSkipReason; bytes?: number }>;
  errored_modules?: Array<{ name: string; path: string; error: string }>;
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

export function parseModuleRootPattern(rawPattern: string, repoPath: string, label: string): string {
  const trimmed = nonempty(rawPattern, label).trim();
  if (isAbsolute(trimmed)) {
    throw new Error(`${label} must be a path relative to the repo root (got "${trimmed}")`);
  }
  const cleaned = trimmed.replaceAll('\\', '/').replace(/^(?:\.\/)+/, '').replace(/\/+$/, '') || '.';
  const segments = cleaned === '.' ? [] : cleaned.split('/');
  if (segments.some((seg) => seg === '..')) {
    throw new Error(`${label} escapes the repository root: "${trimmed}"`);
  }
  if (segments.some((seg) => seg.includes('**'))) {
    throw new Error(`${label} does not support "**" wildcards; use single-segment "*" (e.g. "app/features/*")`);
  }
  const firstWildcardIdx = segments.findIndex((seg) => seg.includes('*'));
  const staticSegments = firstWildcardIdx === -1 ? segments : segments.slice(0, firstWildcardIdx);
  const staticRel = staticSegments.length > 0 ? staticSegments.join('/') : '.';
  const resolvedBase = resolve(repoPath, staticRel);
  const relBase = relative(repoPath, resolvedBase);
  if (relBase.startsWith('..') || isAbsolute(relBase)) {
    throw new Error(`${label} escapes the repository root: "${trimmed}"`);
  }
  if (!statSync(resolvedBase, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(`${label} directory not found: ${resolvedBase}`);
  }
  return cleaned;
}

function parseRepoModules(rawModules: unknown, repoPath: string, label: string): ModuleScanConfig[] {
  if (rawModules === undefined || rawModules === null) return [];
  if (!Array.isArray(rawModules)) {
    throw new Error(`${label} must be an array`);
  }
  const seenNames = new Set<string>();
  const seenPaths = new Set<string>();
  const modules: ModuleScanConfig[] = [];

  for (let i = 0; i < rawModules.length; i += 1) {
    const item = rawModules[i];
    const itemLabel = `${label}[${i}]`;
    let relPath: string;
    let name: string;
    let ignore: string[] = [];

    if (typeof item === 'string') {
      relPath = normalizeRelativeSource(nonempty(item, itemLabel).trim(), repoPath, itemLabel);
      name = relPath === '.' ? 'root' : basename(relPath);
    } else {
      const rec = object(item, itemLabel);
      const rawPath = nonempty(rec.path, `${itemLabel}.path`).trim();
      relPath = normalizeRelativeSource(rawPath, repoPath, `${itemLabel}.path`);
      if (rec.name === undefined || rec.name === null) {
        name = relPath === '.' ? 'root' : basename(relPath);
      } else {
        name = nonempty(rec.name, `${itemLabel}.name`).trim();
        if (
          !/^[a-zA-Z0-9._/@-]+$/.test(name)
          || name.startsWith('/')
          || name.endsWith('/')
          || name.split('/').some((seg) => seg === '..' || seg === '')
        ) {
          throw new Error(`${itemLabel}.name "${name}" contains invalid characters`);
        }
      }
      if (rec.ignore !== undefined && rec.ignore !== null) {
        ignore = [...new Set(parseStringArrayField(rec.ignore, `${itemLabel}.ignore`))].sort(compareCodepoint);
        compileIgnoreMatcher(ignore);
      }
    }

    if (seenPaths.has(relPath)) {
      throw new Error(`Duplicate module path in ${label}: ${relPath}`);
    }
    if (seenNames.has(name)) {
      throw new Error(`Duplicate module name in ${label}: ${name}`);
    }
    seenPaths.add(relPath);
    seenNames.add(name);
    modules.push({ name, path: relPath, ignore });
  }

  return modules;
}

function isProductionSourceFile(relPath: string): boolean {
  const name = basename(relPath);
  if (name.startsWith('.')) return false;
  if (isTestOrSupportPath(relPath)) return false;
  if (name.endsWith('.kt')) return true;
  const isTs = /\.(?:tsx?|[cm]ts)$/.test(name) && !/\.d\.[cm]?ts$/.test(name);
  return isTs && !/\.(?:config|generated)\.[cm]?tsx?$/i.test(name);
}

export function measureModuleDirectory(
  absSource: string,
  ignore: readonly string[] = [],
): { fileCount: number; totalBytes: number } {
  const matcher = compileIgnoreMatcher(ignore);
  const rootStat = statSync(absSource, { throwIfNoEntry: false });
  if (!rootStat) return { fileCount: 0, totalBytes: 0 };
  if (rootStat.isFile()) {
    const fileName = basename(absSource);
    if (!matcher.isIgnoredFile(fileName) && isProductionSourceFile(fileName)) {
      return { fileCount: 1, totalBytes: rootStat.size };
    }
    return { fileCount: 0, totalBytes: 0 };
  }
  if (!rootStat.isDirectory()) return { fileCount: 0, totalBytes: 0 };

  let fileCount = 0;
  let totalBytes = 0;
  function walk(dir: string, prefix = ''): void {
    const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => compareCodepoint(a.name, b.name));
    for (const entry of entries) {
      const isAllowedDot = entry.isDirectory() && ALLOWED_DOT_DIRS.has(entry.name);
      if (entry.name.startsWith('.') && !isAllowedDot) continue;
      const fullPath = join(dir, entry.name);
      const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (
          SKIP_DIRS.has(entry.name.toLowerCase())
          || isTestOrSupportDirName(entry.name)
          || matcher.isIgnoredDir(relPath)
        ) {
          continue;
        }
        walk(fullPath, relPath);
      } else if (entry.isFile() && !matcher.isIgnoredFile(relPath) && isProductionSourceFile(relPath)) {
        const st = statSync(fullPath, { throwIfNoEntry: false });
        if (st?.isFile()) {
          fileCount += 1;
          totalBytes += st.size;
        }
      }
    }
  }
  walk(absSource);
  return { fileCount, totalBytes };
}

function wildcardSegmentToRegExp(segment: string): RegExp {
  const escaped = segment.replace(/[.+^$()|[\]\\{}?]/g, '\\$&').replaceAll('*', '[^/]*');
  return new RegExp(`^${escaped}$`);
}

export function discoverRepoModules(
  repo: Pick<RepoScanConfig, 'path' | 'modules' | 'moduleRoots' | 'ignore'>,
  extraModuleRoots: readonly string[] = [],
): ModuleScanConfig[] {
  const seenPaths = new Set<string>(repo.modules.map((m) => m.path));
  const normalizedExtra = extraModuleRoots.map((r, i) => parseModuleRootPattern(r, repo.path, `--module-root[${i}]`));
  const allRoots = [...new Set([...repo.moduleRoots, ...normalizedExtra])];
  const repoIgnoreMatcher = compileIgnoreMatcher(repo.ignore);

  const discovered: Array<{ path: string; candidateName: string }> = [];

  for (const root of allRoots) {
    const segments = root === '.' ? ['*'] : root.split('/');
    if (!segments.some((seg) => seg.includes('*'))) {
      segments.push('*');
    }

    const walkSegments = (absDir: string, relPrefix: string, segIdx: number, captures: string[]): void => {
      if (segIdx === segments.length) {
        if (!relPrefix || seenPaths.has(relPrefix)) return;
        const effectiveIgnore = resolveIgnorePatternsForSource(relPrefix, repo.ignore);
        const measured = measureModuleDirectory(absDir, effectiveIgnore);
        if (measured.fileCount === 0) return;
        seenPaths.add(relPrefix);
        discovered.push({
          path: relPrefix,
          candidateName: captures.length > 0 ? captures.join('/') : basename(relPrefix),
        });
        return;
      }

      const seg = segments[segIdx];
      if (!seg.includes('*')) {
        const nextRel = relPrefix ? `${relPrefix}/${seg}` : seg;
        if (repoIgnoreMatcher.isIgnoredDir(nextRel)) return;
        const nextAbs = resolve(absDir, seg);
        if (!statSync(nextAbs, { throwIfNoEntry: false })?.isDirectory()) return;
        walkSegments(nextAbs, nextRel, segIdx + 1, captures);
        return;
      }

      const segRegex = wildcardSegmentToRegExp(seg);
      let entries;
      try {
        entries = readdirSync(absDir, { withFileTypes: true });
      } catch {
        return;
      }
      entries.sort((a, b) => compareCodepoint(a.name, b.name));
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const isAllowedDot = ALLOWED_DOT_DIRS.has(entry.name);
        if (entry.name.startsWith('.') && !isAllowedDot) continue;
        if (SKIP_DIRS.has(entry.name.toLowerCase()) || isTestOrSupportDirName(entry.name)) continue;
        if (!segRegex.test(entry.name)) continue;
        const nextRel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
        if (repoIgnoreMatcher.isIgnoredDir(nextRel)) continue;
        walkSegments(join(absDir, entry.name), nextRel, segIdx + 1, [...captures, entry.name]);
      }
    };

    walkSegments(repo.path, '', 0, []);
  }

  const nameCounts = new Map<string, number>();
  for (const mod of repo.modules) {
    nameCounts.set(mod.name, (nameCounts.get(mod.name) ?? 0) + 1);
  }
  for (const item of discovered) {
    nameCounts.set(item.candidateName, (nameCounts.get(item.candidateName) ?? 0) + 1);
  }

  const resolvedDiscovered: ModuleScanConfig[] = discovered.map((item) => ({
    name: (nameCounts.get(item.candidateName) ?? 0) > 1 ? item.path : item.candidateName,
    path: item.path,
    ignore: [],
  }));

  return [...repo.modules, ...resolvedDiscovered].sort(
    (a, b) => compareCodepoint(a.name, b.name) || compareCodepoint(a.path, b.path),
  );
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
    const ignore = rec.ignore === undefined ? [] : [...new Set(parseStringArrayField(rec.ignore, `${label}.ignore`))].sort(compareCodepoint);
    compileIgnoreMatcher(ignore);
    const conventions = parseOptionalDocPath(rec.conventions, repoPath, `${label}.conventions`);
    const requirements = parseOptionalDocPath(rec.requirements, repoPath, `${label}.requirements`);
    const model = parseOptionalModel(rec.model, `${label}.model`);
    const moduleModel = parseOptionalModel(rec.moduleModel, `${label}.moduleModel`);
    const modules = parseRepoModules(rec.modules, repoPath, `${label}.modules`);
    const moduleRoots = rec.moduleRoots === undefined || rec.moduleRoots === null
      ? []
      : [...new Set(
        parseStringArrayField(rec.moduleRoots, `${label}.moduleRoots`).map((r, i) =>
          parseModuleRootPattern(r, repoPath, `${label}.moduleRoots[${i}]`),
        ),
      )].sort(compareCodepoint);
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
      modules,
      moduleRoots,
      moduleModel,
      all,
      rubrics,
      exclude,
      ignore,
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
  module_roots?: string[];
  module_targets?: SnapshotModuleTarget[];
  exclude: string[];
  ignore?: string[];
  rubric_hashes: Record<string, string>;
  model: string;
  conventions_hash: string | null;
  requirements_hash: string | null;
}

export function normalizeStringList(values: string[]): string[] {
  return [...new Set(values)].sort(compareCodepoint);
}

function canonicalModuleTargets(targets: readonly SnapshotModuleTarget[] | undefined): string {
  if (!targets || targets.length === 0) return '';
  return [...targets]
    .map((t) => ({
      name: t.name,
      path: t.path,
      ignore: normalizeStringList(t.ignore ?? []),
    }))
    .sort((a, b) => compareCodepoint(a.name, b.name) || compareCodepoint(a.path, b.path))
    .map((t) => `${t.name}|${t.path}|${t.ignore.join(',')}`)
    .join('\n');
}

export function findMatchingRepoSnapshot(
  existing: RepoSnapshot[],
  key: RepoCacheKey,
): RepoSnapshot | null {
  const normSources = normalizeStringList(key.sources);
  const normModuleRoots = normalizeStringList(key.module_roots ?? []);
  const normModuleTargets = canonicalModuleTargets(key.module_targets);
  const normExclude = normalizeStringList(key.exclude);
  const normIgnore = normalizeStringList(key.ignore ?? []);
  for (let i = existing.length - 1; i >= 0; i -= 1) {
    const snap = existing[i];
    if (snap.repo.name !== key.repo) continue;
    if (snap.repo.commit !== key.commit) continue;
    if (snap.scan.mode !== key.mode) continue;
    if (snap.scan.model !== key.model) continue;
    if ((snap.metrics.modules_errored ?? 0) > 0) continue;
    if ((snap.scan.conventions_hash ?? null) !== key.conventions_hash) continue;
    if ((snap.scan.requirements_hash ?? null) !== key.requirements_hash) continue;
    const snapSources = normalizeStringList(snap.scan.sources);
    const snapModuleRoots = normalizeStringList(snap.scan.module_roots ?? []);
    const snapModuleTargets = canonicalModuleTargets(snap.scan.module_targets);
    const snapExclude = normalizeStringList(snap.scan.exclude);
    const snapIgnore = normalizeStringList(snap.scan.ignore ?? []);
    if (snapSources.length !== normSources.length || snapSources.some((s, idx) => s !== normSources[idx])) {
      continue;
    }
    if (snapModuleRoots.length !== normModuleRoots.length || snapModuleRoots.some((s, idx) => s !== normModuleRoots[idx])) {
      continue;
    }
    if (snapModuleTargets !== normModuleTargets) {
      continue;
    }
    if (snapExclude.length !== normExclude.length || snapExclude.some((s, idx) => s !== normExclude[idx])) {
      continue;
    }
    if (snapIgnore.length !== normIgnore.length || snapIgnore.some((p, idx) => p !== normIgnore[idx])) {
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

function resolveIgnorePatternsForSource(srcRel: string, ignore: readonly string[]): string[] {
  if (ignore.length === 0 || srcRel === '.') return [...ignore];
  const prefix = `${srcRel}/`;
  const resolved: string[] = [];
  for (const pattern of ignore) {
    resolved.push(pattern);
    const normalized = pattern.replaceAll('\\', '/').replace(/^(?:\.\/)+/, '').replace(/^\/+/, '');
    if (normalized.startsWith(prefix) && normalized.length > prefix.length) {
      resolved.push(normalized.slice(prefix.length));
    }
  }
  return [...new Set(resolved)];
}

function collectMultiSourceFiles(
  repo: RepoScanConfig,
): { files: Record<string, string>; conventions?: string; requirements?: string } {
  const mergedFiles: Record<string, string> = {};
  let conventions: string | undefined;
  let requirements: string | undefined;

  for (let i = 0; i < repo.sources.length; i += 1) {
    const srcRel = repo.sources[i];
    const absSrc = resolve(repo.path, srcRel);
    const ignore = resolveIgnorePatternsForSource(srcRel, repo.ignore);
    let loaded;
    try {
      loaded = readPerFileInputs({
        source: absSrc,
        ignore,
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
  includeModules?: boolean;
  skipModules?: boolean;
  moduleRoots?: string[];
  skipFixtures?: boolean;
  noDashboard?: boolean;
  rubricsDir?: string;
  fixturesDir?: string;
  repoRoot?: string;
  transport?: typeof fetch;
}

function redactSecret(rawMsg: string): string {
  const key = process.env.OPENROUTER_API_KEY?.trim();
  return key ? rawMsg.replaceAll(key, '[redacted]') : rawMsg;
}

function formatKiB(bytes: number | undefined): string {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes)) return '';
  return `${(bytes / 1024).toFixed(1)} KiB`;
}

export async function runScanner(options: RunScannerOptions): Promise<ScanRunSummary> {
  const { config } = options;
  if (options.includeModules && options.skipModules) {
    throw new Error('Cannot combine --modules and --skip-modules');
  }
  const dryRun = options.dryRun ?? false;
  const force = options.force ?? false;
  const includeModules = options.includeModules ?? false;
  const skipModules = options.skipModules ?? false;
  const extraModuleRoots = options.moduleRoots ?? [];
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
    const hasModuleConfig = repo.modules.length > 0 || repo.moduleRoots.length > 0 || extraModuleRoots.length > 0;

    const effectiveModes: JudgeMode[] = [...repo.modes];
    if (skipModules) {
      const codeIdx = effectiveModes.indexOf('code');
      if (codeIdx !== -1) effectiveModes.splice(codeIdx, 1);
    } else if (hasModuleConfig || includeModules) {
      if (!effectiveModes.includes('code')) effectiveModes.push('code');
    }

    for (const mode of effectiveModes) {
      const model = mode === 'code'
        ? (repo.moduleModel ?? defaultModelForMode('code', repo.model))
        : defaultModelForMode(mode, repo.model);
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

      let targetModules: ModuleScanConfig[] = [];
      let effectiveModuleRoots: string[] = [];
      let moduleTargets: SnapshotModuleTarget[] | undefined;

      if (mode === 'code') {
        if (hasModuleConfig) {
          const normalizedExtra = extraModuleRoots.map((r, i) =>
            parseModuleRootPattern(r, repo.path, `--module-root[${i}]`),
          );
          effectiveModuleRoots = normalizeStringList([...repo.moduleRoots, ...normalizedExtra]);
          targetModules = discoverRepoModules(repo, extraModuleRoots);
        } else {
          const rawNames = repo.sources.map((src) => (src === '.' ? repo.name : basename(src) || src));
          const counts = new Map<string, number>();
          for (const n of rawNames) counts.set(n, (counts.get(n) ?? 0) + 1);
          targetModules = repo.sources.map((src, i) => ({
            name: (counts.get(rawNames[i]) ?? 0) > 1 ? src : rawNames[i],
            path: src,
            ignore: [],
          }));
        }

        if (targetModules.length === 0) {
          repoOutcomes.push({
            repo: repo.name,
            mode,
            status: 'skipped',
            reason: 'no modules discovered',
            commit_short: gitInfo.commit_short,
            dirty: gitInfo.dirty,
            file_count: 0,
            check_count: checkCount,
            module_count: 0,
            modules_scored: 0,
            modules_skipped: 0,
            modules_errored: 0,
            cost_usd: 0,
          });
          continue;
        }

        moduleTargets = targetModules.map((m) => ({
          name: m.name,
          path: m.path,
          ...(m.ignore.length > 0 ? { ignore: m.ignore } : {}),
        }));
      }

      const cacheKey: RepoCacheKey = {
        repo: repo.name,
        commit: gitInfo.commit,
        mode,
        sources: repo.sources,
        ...(effectiveModuleRoots.length > 0 ? { module_roots: effectiveModuleRoots } : {}),
        ...(moduleTargets ? { module_targets: moduleTargets } : {}),
        exclude: repo.exclude,
        ignore: repo.ignore,
        rubric_hashes: rubricHashes,
        model,
        conventions_hash: conventionsHash,
        requirements_hash: requirementsHash,
      };

      const cached = !force ? findMatchingRepoSnapshot(existingRepoSnapshots, cacheKey) : null;
      if (cached) {
        const cachedFindings = cached.modules
          ? sumFindingCounts(
            cached.modules
              .filter((m) => m.status === 'scored')
              .map((m) => ({ total: m.failed_count, hard: m.hard_fail_count, borderline: m.borderline_count })),
          )
          : sumFindingCounts(cached.files.map((f) => countChecksFindings(f.checks)));
        repoOutcomes.push({
          repo: repo.name,
          mode,
          status: 'skipped',
          reason: 'unchanged',
          commit_short: gitInfo.commit_short,
          dirty: gitInfo.dirty,
          file_count: cached.metrics.file_count,
          check_count: checkCount,
          ...(cached.metrics.module_count !== undefined ? { module_count: cached.metrics.module_count } : {}),
          ...(cached.metrics.modules_scored !== undefined ? { modules_scored: cached.metrics.modules_scored } : {}),
          ...(cached.metrics.modules_skipped !== undefined ? { modules_skipped: cached.metrics.modules_skipped } : {}),
          ...(cached.metrics.modules_errored !== undefined ? { modules_errored: cached.metrics.modules_errored } : {}),
          findings_total: cachedFindings.total,
          findings_hard: cachedFindings.hard,
          findings_borderline: cachedFindings.borderline,
          calibrated_pass_rate: cached.metrics.calibrated_pass_rate,
          raw_pass_rate: cached.metrics.raw_pass_rate,
          cost_usd: 0,
        });
        continue;
      }

      const runStart = performance.now();
      const tracker = createCostTrackingTransport(options.transport ?? fetch);

      try {
        if (mode === 'file') {
          const collected = collectMultiSourceFiles(repo);
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
          const findings = sumFindingCounts(fileEntries.map((f) => countChecksFindings(f.checks)));
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
              ...(repo.ignore.length > 0 ? { ignore: repo.ignore } : {}),
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
            findings_total: findings.total,
            findings_hard: findings.hard,
            findings_borderline: findings.borderline,
            calibrated_pass_rate: agg.calibratedPassRate,
            raw_pass_rate: agg.rawPassRate,
            cost_usd: tracker.hasCost ? tracker.costUsd : 0,
            snapshot_file: written,
          });
        } else if (mode === 'structure') {
          const fileEntries: SnapshotFileEntry[] = [];
          const returnedModels = new Set<string>();
          let totalDiscoveredFiles = 0;
          let totalRetries = 0;

          for (let srcIdx = 0; srcIdx < repo.sources.length; srcIdx += 1) {
            const srcRel = repo.sources[srcIdx];
            const absSrc = resolve(repo.path, srcRel);
            const ignore = resolveIgnorePatternsForSource(srcRel, repo.ignore);

            const loaded = readStructureInputs({
              source: absSrc,
              ignore,
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
                ignore: repo.ignore,
                conventions: loaded.conventions,
                requirements: loaded.requirements,
                rubric: resolved,
                model,
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
          const findings = sumFindingCounts(fileEntries.map((f) => countChecksFindings(f.checks)));
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
              ...(repo.ignore.length > 0 ? { ignore: repo.ignore } : {}),
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
            findings_total: findings.total,
            findings_hard: findings.hard,
            findings_borderline: findings.borderline,
            calibrated_pass_rate: agg.calibratedPassRate,
            raw_pass_rate: agg.rawPassRate,
            cost_usd: tracker.hasCost ? tracker.costUsd : 0,
            snapshot_file: written,
          });
        } else {
          // mode === 'code': per-module architectural scan with resilient budget/error handling
          interface ModuleRunResult {
            entry: SnapshotModuleEntry;
            fileEntry: SnapshotFileEntry | null;
            returnedModel: string | null;
            retries: number;
            fatalError: string | null;
          }

          const unscoredModuleResult = (
            mod: ModuleScanConfig,
            status: 'scored' | 'skipped' | 'error',
            details: {
              skipReason?: ModuleSkipReason;
              error?: string;
              fileCount?: number;
              bytes?: number;
              returnedModel?: string | null;
              retries?: number;
              fatalError?: string | null;
            } = {},
          ): ModuleRunResult => ({
            entry: {
              name: mod.name,
              path: mod.path,
              status,
              ...(details.skipReason ? { skip_reason: details.skipReason } : {}),
              ...(details.error ? { error: details.error } : {}),
              file_count: details.fileCount ?? 0,
              ...(details.bytes !== undefined ? { bytes: details.bytes } : {}),
              ...(mod.ignore.length > 0 ? { ignore: mod.ignore } : {}),
              pass_rate: null,
              raw_pass_rate: null,
              mean_pass_probability: null,
              min_pass_probability: null,
              failed_count: 0,
              hard_fail_count: 0,
              borderline_count: 0,
              checks: {},
            },
            fileEntry: null,
            returnedModel: details.returnedModel ?? null,
            retries: details.retries ?? 0,
            fatalError: details.fatalError ?? null,
          });

          const moduleResults = await runWithConcurrency(
            targetModules,
            repo.concurrency,
            async (mod): Promise<ModuleRunResult> => {
              const absMod = resolve(repo.path, mod.path);
              const effectiveIgnore = [
                ...new Set([
                  ...resolveIgnorePatternsForSource(mod.path, repo.ignore),
                  ...resolveIgnorePatternsForSource(mod.path, mod.ignore),
                ]),
              ];

              let loaded;
              try {
                loaded = readInputs({
                  source: absMod,
                  ignore: effectiveIgnore,
                  conventions: repo.conventions ?? undefined,
                  requirements: repo.requirements ?? undefined,
                  allowCredentials: repo.allowCredentials,
                });
              } catch (error) {
                const msg = redactSecret(error instanceof Error ? error.message : String(error));
                if (/exceed 128 KiB/i.test(msg)) {
                  const measured = measureModuleDirectory(absMod, effectiveIgnore);
                  return unscoredModuleResult(mod, 'skipped', {
                    skipReason: 'oversize',
                    error: msg,
                    fileCount: measured.fileCount,
                    bytes: measured.totalBytes,
                  });
                }
                if (/No supported production/i.test(msg)) {
                  return unscoredModuleResult(mod, 'skipped', {
                    skipReason: 'empty',
                    error: msg,
                    fileCount: 0,
                    bytes: 0,
                  });
                }
                return unscoredModuleResult(mod, 'error', {
                  error: msg,
                  fatalError: `${repo.name} (code/${mod.name}): ${msg}`,
                });
              }

              const fileCount = Object.keys(loaded.files).length;
              const totalBytes = Object.values(loaded.files).reduce(
                (sum, text) => sum + Buffer.byteLength(text, 'utf8'),
                0,
              );

              if (dryRun) {
                return unscoredModuleResult(mod, 'scored', { fileCount, bytes: totalBytes });
              }

              try {
                const result = await runDecisionJudge(
                  {
                    mode: 'code',
                    files: loaded.files,
                    ignore: effectiveIgnore,
                    conventions: loaded.conventions,
                    requirements: loaded.requirements,
                    rubric: resolved,
                    model,
                    dryRun: false,
                  },
                  tracker.transport,
                );
                if (result.status !== 'scored' || !result.quality) {
                  const errMsg = redactSecret(result.error ?? 'Code judging failed');
                  return unscoredModuleResult(mod, 'error', {
                    error: errMsg,
                    fileCount,
                    bytes: totalBytes,
                    returnedModel: result.returned_model,
                    retries: result.retries ?? 0,
                    fatalError: `${repo.name} (code/${mod.name}): ${errMsg}`,
                  });
                }

                const fileEntry = buildSnapshotFileEntry(mod.path, result.quality.checks);
                const counts = countChecksFindings(fileEntry.checks);
                return {
                  entry: {
                    name: mod.name,
                    path: mod.path,
                    status: 'scored',
                    file_count: fileCount,
                    bytes: totalBytes,
                    ...(mod.ignore.length > 0 ? { ignore: mod.ignore } : {}),
                    pass_rate: fileEntry.pass_rate,
                    raw_pass_rate: fileEntry.raw_pass_rate,
                    mean_pass_probability: fileEntry.mean_pass_probability,
                    min_pass_probability: fileEntry.min_pass_probability,
                    failed_count: counts.total,
                    hard_fail_count: counts.hard,
                    borderline_count: counts.borderline,
                    checks: fileEntry.checks,
                  },
                  fileEntry,
                  returnedModel: result.returned_model,
                  retries: result.retries ?? 0,
                  fatalError: null,
                };
              } catch (error) {
                const errMsg = redactSecret(error instanceof Error ? error.message : String(error));
                return unscoredModuleResult(mod, 'error', {
                  error: errMsg,
                  fileCount,
                  bytes: totalBytes,
                  fatalError: `${repo.name} (code/${mod.name}): ${errMsg}`,
                });
              }
            },
          );

          const moduleEntries = moduleResults.map((r) => r.entry);
          const scoredModules = moduleEntries.filter((m) => m.status === 'scored');
          const skippedModules = moduleEntries.filter((m) => m.status === 'skipped');
          const erroredModules = moduleEntries.filter((m) => m.status === 'error');
          const scoredFileEntries = moduleResults
            .map((r) => r.fileEntry)
            .filter((f): f is SnapshotFileEntry => f !== null);
          const returnedModels = new Set(
            moduleResults.map((r) => r.returnedModel).filter((m): m is string => Boolean(m)),
          );
          const totalRetries = moduleResults.reduce((sum, r) => sum + r.retries, 0);
          const totalDiscoveredFiles = scoredModules.reduce((sum, m) => sum + m.file_count, 0);
          const skippedSummary = skippedModules.map((m) => ({
            name: m.name,
            path: m.path,
            reason: m.skip_reason ?? 'oversize',
            ...(m.bytes !== undefined ? { bytes: m.bytes } : {}),
          }));
          const erroredSummary = erroredModules.map((m) => ({
            name: m.name,
            path: m.path,
            error: m.error ?? 'failed',
          }));

          for (const res of moduleResults) {
            if (res.fatalError) errors.push(res.fatalError);
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
              module_count: moduleEntries.length,
              modules_scored: scoredModules.length,
              modules_skipped: skippedModules.length,
              modules_errored: erroredModules.length,
              ...(skippedSummary.length > 0 ? { skipped_modules: skippedSummary } : {}),
              ...(erroredSummary.length > 0 ? { errored_modules: erroredSummary } : {}),
              cost_usd: 0,
            });
            continue;
          }

          if (scoredFileEntries.length === 0 && skippedModules.length === 0 && erroredModules.length > 0) {
            if (tracker.hasCost) totalCostUsd += tracker.costUsd;
            repoOutcomes.push({
              repo: repo.name,
              mode,
              status: 'error',
              commit_short: gitInfo.commit_short,
              dirty: gitInfo.dirty,
              file_count: 0,
              check_count: checkCount,
              module_count: moduleEntries.length,
              modules_scored: 0,
              modules_skipped: 0,
              modules_errored: erroredModules.length,
              errored_modules: erroredSummary,
              cost_usd: tracker.hasCost ? tracker.costUsd : 0,
              error: erroredSummary[0].error,
            });
            continue;
          }

          const agg = aggregateSnapshotChecksAndMetrics(scoredFileEntries, resolved);
          const findings = sumFindingCounts(
            scoredModules.map((m) => ({
              total: m.failed_count,
              hard: m.hard_fail_count,
              borderline: m.borderline_count,
            })),
          );
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
              ...(effectiveModuleRoots.length > 0 ? { module_roots: effectiveModuleRoots } : {}),
              ...(moduleTargets ? { module_targets: moduleTargets } : {}),
              rubrics: rubricSlugs,
              rubric_id: resolved.rubric,
              rubric_groups: resolved.groups,
              exclude: repo.exclude,
              ...(repo.ignore.length > 0 ? { ignore: repo.ignore } : {}),
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
              target_count: scoredFileEntries.length,
              check_count: checkCount,
              module_count: moduleEntries.length,
              modules_scored: scoredModules.length,
              modules_skipped: skippedModules.length,
              modules_errored: erroredModules.length,
              calibrated_pass_rate: agg.calibratedPassRate,
              raw_pass_rate: agg.rawPassRate,
              mean_pass_probability: agg.meanPassProbability,
              elapsed_ms: Math.round(performance.now() - runStart),
              cost_usd: tracker.hasCost ? Number(tracker.costUsd.toFixed(6)) : null,
              requests: tracker.requests,
              retries: totalRetries,
            },
            checks: agg.checks,
            files: scoredFileEntries,
            modules: moduleEntries,
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
            module_count: moduleEntries.length,
            modules_scored: scoredModules.length,
            modules_skipped: skippedModules.length,
            modules_errored: erroredModules.length,
            findings_total: findings.total,
            findings_hard: findings.hard,
            findings_borderline: findings.borderline,
            ...(skippedSummary.length > 0 ? { skipped_modules: skippedSummary } : {}),
            ...(erroredSummary.length > 0 ? { errored_modules: erroredSummary } : {}),
            calibrated_pass_rate: agg.calibratedPassRate,
            raw_pass_rate: agg.rawPassRate,
            cost_usd: tracker.hasCost ? tracker.costUsd : 0,
            snapshot_file: written,
          });
        }
      } catch (error) {
        const msg = redactSecret(error instanceof Error ? error.message : String(error));
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
    const isModuleRun = r.mode === 'code' && r.module_count !== undefined;
    if (r.status === 'skipped') {
      if (isModuleRun && r.reason === 'no modules discovered') {
        lines.push(`  SKIP  ${r.repo} [${r.mode}] @ ${r.commit_short}${dirtyTag} — skipped (no modules discovered)`);
      } else if (isModuleRun) {
        const findingsPart = r.findings_total !== undefined
          ? `, ${r.findings_total} finding(s) (${r.findings_hard ?? 0} error(s), ${r.findings_borderline ?? 0} warning(s))`
          : '';
        lines.push(
          `  SKIP  ${r.repo} [${r.mode}] @ ${r.commit_short}${dirtyTag} — skipped (${r.reason ?? 'unchanged'}) `
          + `(${r.modules_scored ?? 0}/${r.module_count} module(s)${findingsPart})`,
        );
      } else {
        lines.push(
          `  SKIP  ${r.repo} [${r.mode}] @ ${r.commit_short}${dirtyTag} — skipped (${r.reason ?? 'unchanged'}) `
          + `(${r.file_count} files, calibrated ${((r.calibrated_pass_rate ?? 0) * 100).toFixed(1)}%)`,
        );
      }
    } else if (r.status === 'dry_run') {
      if (isModuleRun) {
        const extraParts: string[] = [];
        if ((r.modules_skipped ?? 0) > 0) extraParts.push(`${r.modules_skipped} skipped`);
        if ((r.modules_errored ?? 0) > 0) extraParts.push(`${r.modules_errored} errored`);
        const extra = extraParts.length > 0 ? `; ${extraParts.join(', ')}` : '';
        lines.push(
          `  PLAN  ${r.repo} [${r.mode}] @ ${r.commit_short}${dirtyTag} — would scan `
          + `${r.modules_scored ?? 0}/${r.module_count} module(s) (${r.file_count} file(s) x ${r.check_count} check(s)${extra})`,
        );
      } else {
        lines.push(
          `  PLAN  ${r.repo} [${r.mode}] @ ${r.commit_short}${dirtyTag} — would scan `
          + `${r.file_count} file(s) x ${r.check_count} check(s)`,
        );
      }
    } else if (r.status === 'scanned') {
      const costStr = r.cost_usd > 0 ? `, $${r.cost_usd.toFixed(4)}` : '';
      if (isModuleRun) {
        const extraParts: string[] = [];
        if ((r.modules_skipped ?? 0) > 0) extraParts.push(`${r.modules_skipped} skipped`);
        if ((r.modules_errored ?? 0) > 0) extraParts.push(`${r.modules_errored} errored`);
        const extra = extraParts.length > 0 ? `, ${extraParts.join(', ')}` : '';
        lines.push(
          `  DONE  ${r.repo} [${r.mode}] @ ${r.commit_short}${dirtyTag} — `
          + `${r.modules_scored ?? 0}/${r.module_count} module(s), `
          + `${r.findings_total ?? 0} finding(s) (${r.findings_hard ?? 0} error(s), ${r.findings_borderline ?? 0} warning(s)${extra}${costStr})`,
        );
      } else {
        const findingsPart = r.findings_total !== undefined
          ? `, ${r.findings_total} finding(s) (${r.findings_hard ?? 0} error(s), ${r.findings_borderline ?? 0} warning(s))`
          : '';
        lines.push(
          `  DONE  ${r.repo} [${r.mode}] @ ${r.commit_short}${dirtyTag} — `
          + `${r.file_count} file(s)${findingsPart}, calibrated ${((r.calibrated_pass_rate ?? 0) * 100).toFixed(1)}% `
          + `(raw ${((r.raw_pass_rate ?? 0) * 100).toFixed(1)}%${costStr})`,
        );
      }
    } else {
      lines.push(`  ERR   ${r.repo} [${r.mode}] @ ${r.commit_short}${dirtyTag} — ${r.error ?? 'failed'}`);
    }

    for (const sk of r.skipped_modules ?? []) {
      const sizePart = sk.bytes !== undefined && sk.bytes > 0 ? ` (${formatKiB(sk.bytes)})` : '';
      lines.push(`        skip module ${sk.name} [${sk.path}]: ${sk.reason}${sizePart}`);
    }
    for (const err of r.errored_modules ?? []) {
      lines.push(`        err  module ${err.name} [${err.path}]: ${err.error}`);
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
      modules: { type: 'boolean', default: false },
      'skip-modules': { type: 'boolean', default: false },
      'module-root': { type: 'string', multiple: true },
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
    includeModules: values.modules,
    skipModules: values['skip-modules'],
    moduleRoots: values['module-root'],
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
