import { spawnSync } from 'node:child_process';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { canonicalizeOrFallback, isPathInsideDir } from './fs-read.mts';

export const DEFAULT_CONVENTIONS_FILENAME = 'AGENTS.md';

export interface ResolvedConventions {
  path?: string;
  source: 'cli' | 'auto' | 'none';
}

export interface ChangedFilesResult {
  repoRoot: string;
  baseRef: string | null;
  files: string[];
}

interface ResolvedPathFilter {
  abs: string;
  isDir: boolean;
}

function runGit(cwd: string, args: string[], timeoutMs = 15_000): { ok: boolean; stdout: string; stderr: string } {
  const proc = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    timeout: timeoutMs,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (proc.error) {
    const code = (proc.error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      throw new Error('git is required for --changed but was not found in PATH');
    }
    throw new Error(`git failed: ${proc.error.message}`);
  }
  return {
    ok: proc.status === 0,
    stdout: proc.stdout ?? '',
    stderr: (proc.stderr ?? '').trim(),
  };
}

function splitNul(output: string): string[] {
  return output.split('\0').filter((entry) => entry.length > 0);
}

/**
 * Find the repository/project root for auto-discovering `AGENTS.md`.
 * Uses `git rev-parse --show-toplevel` when inside a git repo; otherwise stays bounded to `cwd`
 * (or `startDir` if outside `cwd`) so unrelated parent directories are never walked.
 */
export function findRepoRoot(startDir: string, cwd: string = process.cwd()): string {
  const resolvedStart = resolve(startDir);
  const startStat = lstatSync(resolvedStart, { throwIfNoEntry: false });
  const probeDir = startStat?.isFile() ? dirname(resolvedStart) : resolvedStart;
  if (lstatSync(probeDir, { throwIfNoEntry: false })?.isDirectory()) {
    const proc = spawnSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: probeDir,
      encoding: 'utf8',
      timeout: 5_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const topLevel = proc.stdout?.trim();
    if (!proc.error && proc.status === 0 && topLevel) {
      return canonicalizeOrFallback(topLevel, resolve(topLevel));
    }
  }
  const canonicalCwd = canonicalizeOrFallback(cwd, resolve(cwd));
  const canonicalProbe = canonicalizeOrFallback(probeDir, probeDir);
  return isPathInsideDir(canonicalProbe, canonicalCwd) ? canonicalCwd : canonicalProbe;
}

/**
 * Resolve conventions document with precedence:
 * 1. `--no-conventions` -> disabled
 * 2. `--conventions <path>` -> explicit CLI path
 * 3. `<repoRoot>/AGENTS.md` (if present as a regular non-empty file) -> auto-loaded
 */
export function resolveConventionsPath(options: {
  cliConventions?: string;
  noConventions?: boolean;
  repoRoot: string;
}): ResolvedConventions {
  if (options.noConventions && options.cliConventions !== undefined) {
    throw new Error('Cannot combine --conventions and --no-conventions');
  }
  if (options.noConventions) return { source: 'none' };
  if (options.cliConventions !== undefined) {
    return { path: options.cliConventions, source: 'cli' };
  }
  const candidate = join(options.repoRoot, DEFAULT_CONVENTIONS_FILENAME);
  const stat = lstatSync(candidate, { throwIfNoEntry: false });
  if (stat?.isFile() && stat.size > 0) {
    try {
      if (readFileSync(candidate, 'utf8').trim().length > 0) {
        return { path: candidate, source: 'auto' };
      }
    } catch {
      // Ignore unreadable auto-discovered AGENTS.md; explicit --conventions still errors.
    }
  }
  return { source: 'none' };
}

function resolveDiffBaseRef(repoRoot: string, explicitBaseRef?: string): string | null {
  if (explicitBaseRef !== undefined) {
    const verified = runGit(repoRoot, ['rev-parse', '--verify', '--quiet', `${explicitBaseRef}^{commit}`]);
    if (!verified.ok) {
      throw new Error(`Unknown git base ref for --changed: ${explicitBaseRef}`);
    }
    return explicitBaseRef;
  }
  if (runGit(repoRoot, ['rev-parse', '--verify', '--quiet', 'main^{commit}']).ok) {
    return 'main';
  }
  if (runGit(repoRoot, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']).ok) {
    return 'HEAD';
  }
  return null;
}

function collectChangedRelPaths(repoRoot: string, baseRef: string | null): Set<string> {
  const changedRelPaths = new Set<string>();
  if (baseRef !== null) {
    const mergeBaseProc = runGit(repoRoot, ['merge-base', baseRef, 'HEAD']);
    const diffTarget = mergeBaseProc.ok && mergeBaseProc.stdout.trim() ? mergeBaseProc.stdout.trim() : baseRef;
    const diffProc = runGit(repoRoot, ['diff', '--name-only', '-z', '--diff-filter=ACMR', diffTarget]);
    if (!diffProc.ok) {
      throw new Error(`git diff failed for --changed (${diffTarget}): ${diffProc.stderr}`);
    }
    for (const rel of splitNul(diffProc.stdout)) changedRelPaths.add(rel);
  } else {
    const stagedProc = runGit(repoRoot, ['diff', '--name-only', '-z', '--cached', '--diff-filter=ACMR']);
    if (stagedProc.ok) {
      for (const rel of splitNul(stagedProc.stdout)) changedRelPaths.add(rel);
    }
  }
  const untrackedProc = runGit(repoRoot, ['ls-files', '--others', '--exclude-standard', '-z']);
  if (untrackedProc.ok) {
    for (const rel of splitNul(untrackedProc.stdout)) changedRelPaths.add(rel);
  }
  return changedRelPaths;
}

function resolvePathFilters(cwd: string, pathFilters?: string[]): ResolvedPathFilter[] {
  return (pathFilters ?? []).map((filterPath) => {
    const abs = resolve(cwd, filterPath);
    const stat = lstatSync(abs, { throwIfNoEntry: false });
    if (!stat?.isDirectory() && !stat?.isFile()) {
      throw new Error(`Path not found: ${filterPath}`);
    }
    return { abs: realpathSync(abs), isDir: stat.isDirectory() };
  });
}

function collectMatchingExistingFiles(
  repoRoot: string,
  changedRelPaths: ReadonlySet<string>,
  filters: readonly ResolvedPathFilter[],
): string[] {
  const files: string[] = [];
  for (const rel of [...changedRelPaths].sort((a, b) => a.localeCompare(b))) {
    const abs = join(repoRoot, ...rel.split('/'));
    if (!lstatSync(abs, { throwIfNoEntry: false })?.isFile()) continue;
    const canonical = realpathSync(abs);
    if (filters.length > 0) {
      const matchesFilter = filters.some((filter) => (
        filter.isDir ? isPathInsideDir(canonical, filter.abs) : canonical === filter.abs
      ));
      if (!matchesFilter) continue;
    }
    files.push(canonical);
  }
  return files;
}

/**
 * Resolve git-modified and untracked regular files relative to a base ref (default `main` or `HEAD` fallback).
 */
export function resolveGitChangedFiles(options: {
  cwd: string;
  baseRef?: string;
  pathFilters?: string[];
}): ChangedFilesResult {
  const top = runGit(options.cwd, ['rev-parse', '--show-toplevel']);
  if (!top.ok || !top.stdout.trim()) {
    throw new Error('--changed requires a git repository');
  }
  const repoRoot = realpathSync(top.stdout.trim());
  const baseRef = resolveDiffBaseRef(repoRoot, options.baseRef);
  const changedRelPaths = collectChangedRelPaths(repoRoot, baseRef);
  const filters = resolvePathFilters(options.cwd, options.pathFilters);
  const files = collectMatchingExistingFiles(repoRoot, changedRelPaths, filters);
  return { repoRoot, baseRef, files };
}
