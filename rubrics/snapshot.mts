/**
 * Shared snapshot schemas, authoritative rubric catalog loading, git metadata helpers,
 * and safe escaping utilities for rubrics/scan.mts and rubrics/dashboard.mts.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PASS_THRESHOLD,
  parsePassThreshold,
  type CheckScope,
  type JudgeMode,
} from '../skills/judge-code/scripts/rubrics.mts';
import type { JudgeBackend } from '../skills/judge-code/scripts/decisions.mts';
import { AUTHORITATIVE_RUBRICS_DIR, sha256File } from './sync.mts';

export const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
export const SNAPSHOT_SCHEMA_VERSION = 1 as const;

export interface InstalledSkillInfo {
  ref: string | null;
  source: string | null;
  computed_hash: string | null;
  skill_path: string | null;
}

export interface SnapshotCheckSummary {
  threshold: number;
  rubric_group: string | null;
  passed: number;
  raw_passed: number;
  total: number;
  pass_rate: number;
  raw_pass_rate: number;
  mean_pass_probability: number | null;
  min_pass_probability: number | null;
}

export interface SnapshotFileCheckScore {
  choice: 'pass' | 'fail';
  model_choice?: 'pass' | 'borderline' | 'fail';
  pass_probability: number | null;
  confidence: number | null;
}

export interface SnapshotFileEntry {
  path: string;
  pass_rate: number;
  raw_pass_rate: number;
  mean_pass_probability: number | null;
  min_pass_probability: number | null;
  failed_count: number;
  checks: Record<string, SnapshotFileCheckScore>;
}

export interface RepoSnapshot {
  schema_version: 1;
  kind: 'repo';
  timestamp: string;
  repo: {
    name: string;
    branch: string | null;
    commit: string;
    commit_short: string;
    dirty: boolean;
    installed_judge_code: InstalledSkillInfo | null;
  };
  scan: {
    mode: JudgeMode;
    sources: string[];
    rubrics: string[];
    rubric_id: string;
    rubric_groups: Record<string, string[]>;
    exclude: string[];
    ignore?: string[];
    model: string;
    returned_model: string | null;
    backend: JudgeBackend;
    conventions_hash: string | null;
    requirements_hash: string | null;
  };
  judge_version: string;
  agent_tooling_tag: string | null;
  agent_tooling_commit: string | null;
  rubric_hashes: Record<string, string>;
  rubrics_digest: string;
  metrics: {
    file_count: number;
    target_count: number;
    check_count: number;
    calibrated_pass_rate: number;
    raw_pass_rate: number;
    all_files_pass_rate?: number;
    mean_pass_probability: number | null;
    elapsed_ms: number;
    cost_usd: number | null;
    requests: number;
    retries: number;
  };
  checks: Record<string, SnapshotCheckSummary>;
  files: SnapshotFileEntry[];
}

export interface FixtureCheckSnapshot {
  fixture_id: string;
  mode: JudgeMode;
  rubric: string;
  check_id: string;
  expected: 'pass' | 'fail';
  passed: boolean;
  matches: number;
  repeats: number;
  pass_threshold: number | null;
  min_pass_probability: number | null;
  max_pass_probability: number | null;
  mean_pass_probability: number | null;
  margin: number | null;
  jitter: number | null;
}

export interface RubricFixturesSnapshot {
  schema_version: 1;
  kind: 'rubric_fixtures';
  timestamp: string;
  judge_version: string;
  agent_tooling_tag: string | null;
  agent_tooling_commit: string | null;
  rubric_hashes: Record<string, string>;
  fixture_hashes: Record<string, string>;
  combined_hash: string;
  scan: {
    backend: JudgeBackend;
    model: string | null;
    repeats: number;
  };
  metrics: {
    status: 'passed' | 'failed';
    fixtures_total: number;
    fixtures_passed: number;
    fixture_pass_rate: number;
    checks_total: number;
    checks_passed: number;
    check_pass_rate: number;
    min_margin: number | null;
    mean_margin: number | null;
    max_jitter: number | null;
    mean_jitter: number | null;
    elapsed_ms: number;
    cost_usd: number | null;
    requests: number;
  };
  checks: FixtureCheckSnapshot[];
}

export type DashboardSnapshot = RepoSnapshot | RubricFixturesSnapshot;

export interface LoadedSnapshotRecord<T extends DashboardSnapshot = DashboardSnapshot> {
  file: string;
  snapshot: T;
}

export interface CatalogCheckInfo {
  id: string;
  rubric_slug: string;
  rubric_id: string;
  target: string;
  scope: CheckScope | 'test' | 'review';
  pass_threshold: number;
  instructions: string;
  criteria: { pass: string; fail: string };
}

export interface CatalogRubricInfo {
  slug: string;
  id: string;
  target: string;
  sha256: string;
  checks: CatalogCheckInfo[];
}

export interface AgentToolingGitInfo {
  judge_version: string;
  latest_tag: string | null;
  head_sha: string | null;
  head_short: string | null;
}

export interface RubricCatalog {
  agent_tooling: AgentToolingGitInfo;
  rubrics: CatalogRubricInfo[];
  checks_by_id: Record<string, CatalogCheckInfo>;
  rubric_hashes: Record<string, string>;
}

export function compareCodepoint(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

export function sha256String(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export function computeHashesDigest(hashes: Record<string, string>): string {
  const canonical = Object.keys(hashes)
    .sort(compareCodepoint)
    .map((key) => `${key}:${hashes[key]}`)
    .join('\n');
  return sha256String(canonical);
}

export function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function safeJsonForScript(value: unknown): string {
  return JSON.stringify(value)
    .replaceAll('<', '\\u003c')
    .replaceAll('>', '\\u003e')
    .replaceAll('&', '\\u0026')
    .replaceAll('\u2028', '\\u2028')
    .replaceAll('\u2029', '\\u2029');
}

function runGitReadOnly(cwd: string, args: string[]): string | null {
  const proc = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    timeout: 5_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (proc.error || proc.status !== 0) return null;
  return proc.stdout.trim();
}

export function readAgentToolingGitInfo(repoRoot: string = REPO_ROOT): AgentToolingGitInfo {
  const headSha = runGitReadOnly(repoRoot, ['rev-parse', 'HEAD']);
  const headShort = headSha ? headSha.slice(0, 7) : null;
  const tagsRaw = runGitReadOnly(repoRoot, ['tag', '-l', '--sort=-v:refname']);
  const latestTag = tagsRaw ? (tagsRaw.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? null) : null;
  const described = runGitReadOnly(repoRoot, ['describe', '--tags', '--always']);
  const judgeVersion = described || latestTag || headShort || 'unknown';
  return {
    judge_version: judgeVersion,
    latest_tag: latestTag,
    head_sha: headSha,
    head_short: headShort,
  };
}

export interface TargetRepoGitInfo {
  commit: string;
  commit_short: string;
  branch: string | null;
  dirty: boolean;
}

export function readTargetRepoGitInfo(repoPath: string): TargetRepoGitInfo {
  const commit = runGitReadOnly(repoPath, ['rev-parse', 'HEAD']) ?? 'unknown';
  const commitShort = commit === 'unknown' ? 'unknown' : commit.slice(0, 7);
  const symbolicBranch = runGitReadOnly(repoPath, ['symbolic-ref', '--short', 'HEAD']);
  const fallbackBranch = symbolicBranch ?? runGitReadOnly(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const branch = fallbackBranch && fallbackBranch !== 'HEAD' ? fallbackBranch : null;
  const porcelain = runGitReadOnly(repoPath, ['status', '--porcelain']);
  const dirty = porcelain !== null && porcelain.length > 0;
  return { commit, commit_short: commitShort, branch, dirty };
}

export function readInstalledJudgeCodeInfo(repoPath: string): InstalledSkillInfo | null {
  const lockPath = join(repoPath, 'skills-lock.json');
  if (!statSync(lockPath, { throwIfNoEntry: false })?.isFile()) return null;
  try {
    const parsed = JSON.parse(readFileSync(lockPath, 'utf8')) as Record<string, unknown>;
    const skills = parsed?.skills;
    if (!skills || typeof skills !== 'object' || Array.isArray(skills)) return null;
    const entry = (skills as Record<string, unknown>)['judge-code'];
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
    const rec = entry as Record<string, unknown>;
    const strOrNull = (val: unknown): string | null =>
      typeof val === 'string' && val.trim().length > 0 ? val.trim() : null;
    return {
      ref: strOrNull(rec.ref),
      source: strOrNull(rec.source),
      computed_hash: strOrNull(rec.computedHash ?? rec.computed_hash),
      skill_path: strOrNull(rec.skillPath ?? rec.skill_path),
    };
  } catch {
    return null;
  }
}

export function loadRubricCatalog(
  rubricsDir: string = AUTHORITATIVE_RUBRICS_DIR,
  repoRoot: string = REPO_ROOT,
): RubricCatalog {
  const agentTooling = readAgentToolingGitInfo(repoRoot);
  const rubrics: CatalogRubricInfo[] = [];
  const checksById: Record<string, CatalogCheckInfo> = {};
  const rubricHashes: Record<string, string> = {};

  if (!statSync(rubricsDir, { throwIfNoEntry: false })?.isDirectory()) {
    return { agent_tooling: agentTooling, rubrics, checks_by_id: checksById, rubric_hashes: rubricHashes };
  }

  const files = readdirSync(rubricsDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => entry.name)
    .sort(compareCodepoint);

  for (const file of files) {
    const slug = file.slice(0, -'.json'.length);
    const fullPath = join(rubricsDir, file);
    const hash = sha256File(fullPath);
    rubricHashes[slug] = hash;

    const raw = JSON.parse(readFileSync(fullPath, 'utf8')) as Record<string, unknown>;
    const id = typeof raw.rubric === 'string' ? raw.rubric : slug;
    const target = typeof raw.target === 'string' ? raw.target : 'production_code';
    const rawQuestions = raw.questions && typeof raw.questions === 'object' && !Array.isArray(raw.questions)
      ? (raw.questions as Record<string, unknown>)
      : {};

    const checks: CatalogCheckInfo[] = [];
    for (const [checkId, qVal] of Object.entries(rawQuestions)) {
      if (!qVal || typeof qVal !== 'object' || Array.isArray(qVal)) continue;
      const q = qVal as Record<string, unknown>;
      const rawScope = q.scope;
      let scope: CatalogCheckInfo['scope'];
      if (target === 'project_structure') scope = 'structure';
      else if (target === 'test_code') scope = 'test';
      else if (target === 'review') scope = 'review';
      else scope = rawScope === 'file' ? 'file' : 'module';

      const passThreshold = q.pass_threshold !== undefined
        ? parsePassThreshold(q.pass_threshold, checkId)
        : PASS_THRESHOLD;
      const criteria = q.criteria && typeof q.criteria === 'object' && !Array.isArray(q.criteria)
        ? (q.criteria as Record<string, unknown>)
        : {};
      const info: CatalogCheckInfo = {
        id: checkId,
        rubric_slug: slug,
        rubric_id: id,
        target,
        scope,
        pass_threshold: passThreshold,
        instructions: typeof q.instructions === 'string' ? q.instructions : '',
        criteria: {
          pass: typeof criteria.pass === 'string' ? criteria.pass : '',
          fail: typeof criteria.fail === 'string' ? criteria.fail : '',
        },
      };
      checks.push(info);
      if (!(checkId in checksById)) {
        checksById[checkId] = info;
      }
    }

    rubrics.push({ slug, id, target, sha256: hash, checks });
  }

  return {
    agent_tooling: agentTooling,
    rubrics,
    checks_by_id: checksById,
    rubric_hashes: rubricHashes,
  };
}

export function hashJsonDirectory(dir: string): Record<string, string> {
  if (!statSync(dir, { throwIfNoEntry: false })?.isDirectory()) return {};
  const hashes: Record<string, string> = {};
  const files = readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => entry.name)
    .sort(compareCodepoint);
  for (const file of files) {
    hashes[file.slice(0, -'.json'.length)] = sha256File(join(dir, file));
  }
  return hashes;
}

export function isValidSnapshot(value: unknown): value is DashboardSnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const rec = value as Record<string, unknown>;
  if (rec.kind === 'repo') {
    return typeof rec.timestamp === 'string'
      && Boolean(rec.repo && typeof rec.repo === 'object')
      && Boolean(rec.scan && typeof rec.scan === 'object')
      && Boolean(rec.metrics && typeof rec.metrics === 'object');
  }
  if (rec.kind === 'rubric_fixtures') {
    return typeof rec.timestamp === 'string'
      && Boolean(rec.metrics && typeof rec.metrics === 'object')
      && Array.isArray(rec.checks);
  }
  return false;
}

export interface LoadSnapshotsResult {
  repoSnapshots: LoadedSnapshotRecord<RepoSnapshot>[];
  fixtureSnapshots: LoadedSnapshotRecord<RubricFixturesSnapshot>[];
  warnings: string[];
}

export function loadSnapshotsFromDir(dataDir: string): LoadSnapshotsResult {
  const runsDir = join(dataDir, 'runs');
  const repoSnapshots: LoadedSnapshotRecord<RepoSnapshot>[] = [];
  const fixtureSnapshots: LoadedSnapshotRecord<RubricFixturesSnapshot>[] = [];
  const warnings: string[] = [];

  if (!statSync(runsDir, { throwIfNoEntry: false })?.isDirectory()) {
    return { repoSnapshots, fixtureSnapshots, warnings };
  }

  const files = readdirSync(runsDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => entry.name)
    .sort(compareCodepoint);

  for (const file of files) {
    const fullPath = join(runsDir, file);
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(fullPath, 'utf8'));
    } catch (error) {
      warnings.push(`Skipped invalid JSON ${file}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    if (!isValidSnapshot(parsed)) {
      warnings.push(`Skipped unrecognized snapshot ${file}`);
      continue;
    }
    if (parsed.kind === 'repo') {
      repoSnapshots.push({ file, snapshot: parsed });
    } else {
      fixtureSnapshots.push({ file, snapshot: parsed });
    }
  }

  const byChronological = <T extends DashboardSnapshot>(
    a: LoadedSnapshotRecord<T>,
    b: LoadedSnapshotRecord<T>,
  ): number => compareCodepoint(a.snapshot.timestamp, b.snapshot.timestamp) || compareCodepoint(a.file, b.file);

  repoSnapshots.sort(byChronological);
  fixtureSnapshots.sort(byChronological);

  return { repoSnapshots, fixtureSnapshots, warnings };
}

export function equalStringRecords(a: Record<string, string>, b: Record<string, string>): boolean {
  const keysA = Object.keys(a).sort(compareCodepoint);
  const keysB = Object.keys(b).sort(compareCodepoint);
  if (keysA.length !== keysB.length) return false;
  for (let i = 0; i < keysA.length; i += 1) {
    const key = keysA[i];
    if (key !== keysB[i] || a[key] !== b[key]) return false;
  }
  return true;
}

export function diffRubricHashes(
  prev: Record<string, string>,
  curr: Record<string, string>,
): { added: string[]; removed: string[]; modified: string[] } {
  const allKeys = [...new Set([...Object.keys(prev), ...Object.keys(curr)])].sort(compareCodepoint);
  const added: string[] = [];
  const removed: string[] = [];
  const modified: string[] = [];
  for (const key of allKeys) {
    if (!(key in prev)) added.push(key);
    else if (!(key in curr)) removed.push(key);
    else if (prev[key] !== curr[key]) modified.push(key);
  }
  return { added, removed, modified };
}

export function formatUtcFileTimestamp(date: Date = new Date()): string {
  return date.toISOString().replace(/:/g, '-').replace(/\./g, '-');
}

export function sanitizeSlugForFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_');
}
