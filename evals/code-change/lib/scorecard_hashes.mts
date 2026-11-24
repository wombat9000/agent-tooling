/** Deterministic content hashing (working tree and historical git refs) and staleness checks. */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  canonicalJson,
  compareCodepoint,
  type ScorecardCondition,
  type ScorecardHashes,
  type ScorecardTarget,
} from './scorecard_schema.mts';

export const HASH_LENGTH = 12;

export type StaleReason = 'skill' | 'task' | 'rubric' | 'task_missing' | 'skill_missing';

export interface StalenessResult {
  status: 'current' | 'stale';
  reasons: StaleReason[];
  currentHashes: {
    skill_hash: string | null;
    task_hash: string | null;
    rubric_hash: string | null;
  };
}

export interface ResolvedRubricInfo {
  rubric: string;
  target: ScorecardTarget;
  hash: string;
  groups?: Record<string, string[]>;
  questions: Record<string, {
    type: 'choice';
    instructions: string;
    criteria: { pass: string; fail: string };
  }>;
}

const COMMON_EXCLUDED_SEGMENTS = new Set([
  '.DS_Store',
  '.git',
  '.idea',
  '.pnpm-store',
  'node_modules',
  '__pycache__',
]);

const TASK_EXCLUDED_SEGMENTS = new Set([
  ...COMMON_EXCLUDED_SEGMENTS,
  '.gradle',
  'build',
  'dist',
]);

function isExcludedPath(relPath: string, kind: 'skill' | 'task'): boolean {
  const normalized = relPath.replaceAll('\\', '/');
  const segments = normalized.split('/');
  const excludedDirs = kind === 'task' ? TASK_EXCLUDED_SEGMENTS : COMMON_EXCLUDED_SEGMENTS;
  for (const seg of segments) {
    if (excludedDirs.has(seg)) return true;
  }
  if (/\.py[cod]$/.test(normalized)) return true;
  if (kind === 'task' && normalized === 'tests/grade_review.mts') return true;
  return false;
}

/** Hash an ordered list of (relativePath, contentBuffer) entries into a 12-char SHA-256 hex string. */
export function hashFileEntries(entries: Array<{ path: string; content: Buffer }>): string {
  const sorted = [...entries].sort((a, b) => compareCodepoint(a.path, b.path));
  const hash = createHash('sha256');
  for (const entry of sorted) {
    hash.update(entry.path, 'utf8');
    hash.update('\0');
    hash.update(String(entry.content.length), 'utf8');
    hash.update('\0');
    hash.update(entry.content);
    hash.update('\n');
  }
  return hash.digest('hex').slice(0, HASH_LENGTH);
}

function collectWorkingTreeFiles(
  baseDir: string,
  kind: 'skill' | 'task',
  prefix = '',
): Array<{ path: string; content: Buffer }> {
  const out: Array<{ path: string; content: Buffer }> = [];
  const dir = prefix ? join(baseDir, prefix) : baseDir;
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => compareCodepoint(a.name, b.name))) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (isExcludedPath(rel, kind)) continue;
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      out.push(...collectWorkingTreeFiles(baseDir, kind, rel));
    } else if (entry.isFile()) {
      out.push({ path: rel, content: readFileSync(join(baseDir, rel)) });
    }
  }
  return out;
}

function gitExecBuffer(repoRoot: string, args: string[]): Buffer {
  return execFileSync('git', args, {
    cwd: repoRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  });
}

function gitExecText(repoRoot: string, args: string[]): string {
  return gitExecBuffer(repoRoot, args).toString('utf8');
}

/** Resolve a git ref to its full commit SHA and 7-char short SHA. */
export function resolveGitRef(repoRoot: string, ref: string): { full: string; short: string } {
  const full = gitExecText(repoRoot, ['rev-parse', '--verify', `${ref}^{commit}`]).trim();
  const short = gitExecText(repoRoot, ['rev-parse', '--short=7', full]).trim();
  return { full, short };
}

function collectGitTreeFiles(
  repoRoot: string,
  ref: string,
  repoRelPrefix: string,
  kind: 'skill' | 'task',
): Array<{ path: string; content: Buffer }> {
  const prefix = repoRelPrefix.replace(/\/+$/, '');
  const raw = gitExecBuffer(repoRoot, ['ls-tree', '-r', '-z', ref, '--', prefix]);
  if (raw.length === 0) return [];
  const records = raw.toString('utf8').split('\0').filter(Boolean);
  const out: Array<{ path: string; content: Buffer }> = [];
  for (const record of records) {
    const tabIdx = record.indexOf('\t');
    if (tabIdx === -1) continue;
    const meta = record.slice(0, tabIdx).split(' ');
    const oid = meta[2];
    const type = meta[1];
    if (type !== 'blob') continue;
    const fullPath = record.slice(tabIdx + 1);
    if (!fullPath.startsWith(`${prefix}/`)) continue;
    const rel = fullPath.slice(prefix.length + 1);
    if (isExcludedPath(rel, kind)) continue;
    const content = gitExecBuffer(repoRoot, ['cat-file', 'blob', oid]);
    out.push({ path: rel, content });
  }
  return out;
}

function readGitFileText(repoRoot: string, ref: string, repoRelPath: string): string | null {
  try {
    return gitExecText(repoRoot, ['show', `${ref}:${repoRelPath}`]);
  } catch {
    return null;
  }
}

export function computeSkillHash(repoRoot: string, skill: string, gitRef?: string): string | null {
  const repoRel = `skills/${skill}`;
  if (gitRef) {
    const entries = collectGitTreeFiles(repoRoot, gitRef, repoRel, 'skill');
    return entries.length > 0 ? hashFileEntries(entries) : null;
  }
  const dir = join(repoRoot, repoRel);
  if (!statSync(dir, { throwIfNoEntry: false })?.isDirectory()) return null;
  const entries = collectWorkingTreeFiles(dir, 'skill');
  return entries.length > 0 ? hashFileEntries(entries) : null;
}

export function computeTaskHash(repoRoot: string, skill: string, task: string, gitRef?: string): string | null {
  const repoRel = `evals/${skill}/tasks/${task}`;
  if (gitRef) {
    const entries = collectGitTreeFiles(repoRoot, gitRef, repoRel, 'task');
    return entries.length > 0 ? hashFileEntries(entries) : null;
  }
  const dir = join(repoRoot, repoRel);
  if (!statSync(dir, { throwIfNoEntry: false })?.isDirectory()) return null;
  const entries = collectWorkingTreeFiles(dir, 'task');
  return entries.length > 0 ? hashFileEntries(entries) : null;
}

interface TextReader {
  readText(repoRelPath: string): string | null;
}

function makeTextReader(repoRoot: string, gitRef?: string): TextReader {
  if (gitRef) {
    return { readText: (repoRelPath) => readGitFileText(repoRoot, gitRef, repoRelPath) };
  }
  return {
    readText: (repoRelPath) => {
      const fullPath = join(repoRoot, repoRelPath);
      if (!existsSync(fullPath) || !statSync(fullPath).isFile()) return null;
      return readFileSync(fullPath, 'utf8');
    },
  };
}

function parseExtendsField(value: unknown): string[] {
  if (typeof value === 'string' && value.trim()) return [value];
  if (Array.isArray(value) && value.length > 0 && value.every((v) => typeof v === 'string' && v.trim())) {
    return value as string[];
  }
  throw new Error('Invalid extends field in rubric');
}

function resolveRawRubric(
  reader: TextReader,
  skill: string,
  rubricRelPath: string,
): { raw: Record<string, unknown>; groups?: Record<string, string[]> } | null {
  const text = reader.readText(rubricRelPath);
  if (text === null) return null;
  const raw = JSON.parse(text) as Record<string, unknown>;
  if (raw.extends === undefined) return { raw };

  const names = parseExtendsField(raw.extends);
  const baseRubrics: string[] = [];
  const mergedQuestions: Record<string, unknown> = {};
  const questionOwner = new Map<string, string>();
  const groups: Record<string, string[]> = {};
  let baseTarget: unknown;

  for (const name of names) {
    const sharedText = reader.readText(`evals/${skill}/rubrics/${name}.json`);
    if (sharedText === null) {
      throw new Error(`Missing shared rubric evals/${skill}/rubrics/${name}.json`);
    }
    const base = JSON.parse(sharedText) as Record<string, unknown>;
    baseRubrics.push(String(base.rubric));
    if (base.target !== undefined) baseTarget = base.target;
    const baseQuestions = (base.questions ?? {}) as Record<string, unknown>;
    const groupIds: string[] = [];
    for (const [id, q] of Object.entries(baseQuestions)) {
      questionOwner.set(id, name);
      mergedQuestions[id] = q;
      groupIds.push(id);
    }
    groups[name] = groupIds;
  }

  const taskQuestions = (raw.questions ?? {}) as Record<string, unknown>;
  const extraIds = Object.keys(taskQuestions).filter((id) => !questionOwner.has(id));
  if (extraIds.length > 0) groups.task = extraIds;

  return {
    raw: {
      rubric: raw.rubric ?? baseRubrics.join('+'),
      target: raw.target ?? baseTarget,
      questions: { ...mergedQuestions, ...taskQuestions },
    },
    groups,
  };
}

/** Resolve the rubric for (skill, task, target) from working tree or gitRef, and compute its canonical hash. */
export function resolveRubricForTarget(
  repoRoot: string,
  skill: string,
  task: string,
  target: ScorecardTarget,
  gitRef?: string,
): ResolvedRubricInfo | null {
  const reader = makeTextReader(repoRoot, gitRef);
  let loaded: { raw: Record<string, unknown>; groups?: Record<string, string[]> } | null = null;

  if (target === 'test_code') {
    loaded = resolveRawRubric(reader, skill, `evals/${skill}/tasks/${task}/tests/judge-tests.json`);
    if (!loaded) {
      // Fall back to shared testing-core.json (current default) or legacy testing.json at older refs.
      for (const fallbackSlug of ['testing-core', 'testing']) {
        const text = reader.readText(`evals/${skill}/rubrics/${fallbackSlug}.json`);
        if (text !== null) {
          const parsed = JSON.parse(text) as Record<string, unknown>;
          const qIds = Object.keys((parsed.questions ?? {}) as Record<string, unknown>);
          loaded = { raw: parsed, groups: { [fallbackSlug]: qIds } };
          break;
        }
      }
    }
  } else {
    loaded = resolveRawRubric(reader, skill, `evals/${skill}/tasks/${task}/tests/judge.json`);
  }

  if (!loaded) return null;
  const resolvedTarget: ScorecardTarget =
    loaded.raw.target === 'production_code' || loaded.raw.target === 'test_code' || loaded.raw.target === 'review'
      ? loaded.raw.target
      : 'review';
  const rubricId = String(loaded.raw.rubric ?? '');
  const rawQuestions = (loaded.raw.questions ?? {}) as Record<string, {
    type: 'choice';
    instructions: string;
    criteria: { pass: string; fail: string };
  }>;

  const canonicalPayload = {
    rubric: rubricId,
    target: resolvedTarget,
    ...(loaded.groups ? { groups: loaded.groups } : {}),
    questions: rawQuestions,
  };
  const hash = createHash('sha256')
    .update(canonicalJson(canonicalPayload), 'utf8')
    .digest('hex')
    .slice(0, HASH_LENGTH);

  return {
    rubric: rubricId,
    target: resolvedTarget,
    hash,
    ...(loaded.groups ? { groups: loaded.groups } : {}),
    questions: rawQuestions,
  };
}

export function computeRubricHash(
  repoRoot: string,
  skill: string,
  task: string,
  target: ScorecardTarget,
  gitRef?: string,
): string | null {
  return resolveRubricForTarget(repoRoot, skill, task, target, gitRef)?.hash ?? null;
}

/**
 * Compute staleness for a recorded entry against the current working tree.
 * - `skill` entries require skill_hash, task_hash, and rubric_hash to match.
 * - `baseline` entries require only task_hash and rubric_hash to match (skill edits never mark baselines stale).
 */
export function evaluateStaleness(
  condition: ScorecardCondition,
  recorded: ScorecardHashes,
  current: {
    skill_hash: string | null;
    task_hash: string | null;
    rubric_hash: string | null;
  },
): StalenessResult {
  const reasons: StaleReason[] = [];
  if (condition === 'skill') {
    if (current.skill_hash === null) {
      reasons.push('skill_missing');
    } else if (recorded.skill_hash !== current.skill_hash) {
      reasons.push('skill');
    }
  }
  if (current.task_hash === null) {
    reasons.push('task_missing');
  } else if (recorded.task_hash !== current.task_hash) {
    reasons.push('task');
  }
  if (current.rubric_hash === null || recorded.rubric_hash !== current.rubric_hash) {
    if (!reasons.includes('task_missing')) {
      reasons.push('rubric');
    }
  }
  return {
    status: reasons.length === 0 ? 'current' : 'stale',
    reasons,
    currentHashes: current,
  };
}
