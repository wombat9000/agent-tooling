import { spawnSync } from 'node:child_process';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { compileIgnoreMatcher } from './inputs.mts';
import { nonempty, object } from './rubrics.mts';

export const CONFIG_FILENAME = '.judge-code.json';
export const DEFAULT_CONVENTIONS_FILENAME = 'AGENTS.md';

export interface ConfigModuleEntry {
  name?: string;
  path: string;
  ignore: string[];
}

export interface LoadedJudgeConfig {
  path: string | null;
  baseDir: string;
  ignore: string[];
  exclude: string[];
  conventions?: string | false;
  modules: ConfigModuleEntry[];
}

export interface ResolvedConventions {
  path?: string;
  source: 'cli' | 'config' | 'auto' | 'none';
}

export interface ChangedFilesResult {
  repoRoot: string;
  baseRef: string | null;
  files: string[];
}

function runGit(cwd: string, args: string[]): { ok: boolean; stdout: string; stderr: string } {
  const proc = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    timeout: 15_000,
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

function isInsideDir(candidate: string, root: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

/**
 * Find the repository/project root for auto-discovering `.judge-code.json` and `AGENTS.md`.
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
    if (!proc.error && proc.status === 0 && proc.stdout.trim()) {
      try {
        return realpathSync(proc.stdout.trim());
      } catch {
        return resolve(proc.stdout.trim());
      }
    }
  }
  const canonicalCwd = (() => {
    try {
      return realpathSync(cwd);
    } catch {
      return resolve(cwd);
    }
  })();
  const canonicalProbe = (() => {
    try {
      return realpathSync(probeDir);
    } catch {
      return probeDir;
    }
  })();
  return isInsideDir(canonicalProbe, canonicalCwd) ? canonicalCwd : canonicalProbe;
}

function parseStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array of strings`);
  return value.map((item, idx) => nonempty(item, `${label}[${idx}]`).trim());
}

function parseConfigModules(value: unknown, baseDir: string): ConfigModuleEntry[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error('config.modules must be an array');
  return value.map((entry, idx) => {
    const label = `config.modules[${idx}]`;
    if (typeof entry === 'string') {
      const rawPath = nonempty(entry, label).trim();
      return {
        path: isAbsolute(rawPath) ? resolve(rawPath) : resolve(baseDir, rawPath),
        ignore: [],
      };
    }
    const rec = object(entry, label);
    const rawPath = nonempty(rec.path, `${label}.path`).trim();
    const name = rec.name === undefined || rec.name === null
      ? undefined
      : nonempty(rec.name, `${label}.name`).trim();
    const ignore = rec.ignore === undefined || rec.ignore === null
      ? []
      : parseStringArray(rec.ignore, `${label}.ignore`);
    compileIgnoreMatcher(ignore);
    return {
      ...(name !== undefined ? { name } : {}),
      path: isAbsolute(rawPath) ? resolve(rawPath) : resolve(baseDir, rawPath),
      ignore,
    };
  });
}

function parseConfigFile(configPath: string): LoadedJudgeConfig {
  const resolvedPath = resolve(configPath);
  const stat = lstatSync(resolvedPath, { throwIfNoEntry: false });
  if (!stat?.isFile()) {
    throw new Error(`Config file not found or not a regular file: ${configPath}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(resolvedPath, 'utf8'));
  } catch (error) {
    throw new Error(`Invalid JSON in ${configPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const raw = object(parsed, configPath);
  const allowedKeys = new Set(['$schema', 'ignore', 'exclude', 'conventions', 'modules']);
  for (const key of Object.keys(raw)) {
    if (!allowedKeys.has(key)) {
      throw new Error(`Unknown field "${key}" in ${configPath}`);
    }
  }

  const baseDir = dirname(realpathSync(resolvedPath));
  const ignore = raw.ignore === undefined || raw.ignore === null
    ? []
    : parseStringArray(raw.ignore, 'config.ignore');
  compileIgnoreMatcher(ignore);

  const exclude = raw.exclude === undefined || raw.exclude === null
    ? []
    : parseStringArray(raw.exclude, 'config.exclude');

  let conventions: string | false | undefined;
  if (raw.conventions === false) {
    conventions = false;
  } else if (raw.conventions === undefined || raw.conventions === null) {
    conventions = undefined;
  } else if (typeof raw.conventions === 'string') {
    const trimmed = nonempty(raw.conventions, 'config.conventions').trim();
    conventions = isAbsolute(trimmed) ? resolve(trimmed) : resolve(baseDir, trimmed);
  } else {
    throw new Error('config.conventions must be a file path string or false');
  }

  const modules = parseConfigModules(raw.modules, baseDir);

  return {
    path: resolvedPath,
    baseDir,
    ignore,
    exclude,
    conventions,
    modules,
  };
}

/**
 * Load an explicit `--config <path>` or auto-discover `<repoRoot>/.judge-code.json` when present.
 */
export function loadJudgeConfig(options: { configPath?: string; repoRoot: string }): LoadedJudgeConfig {
  if (options.configPath !== undefined) {
    return parseConfigFile(options.configPath);
  }
  const candidate = join(options.repoRoot, CONFIG_FILENAME);
  const stat = lstatSync(candidate, { throwIfNoEntry: false });
  if (!stat?.isFile()) {
    return {
      path: null,
      baseDir: options.repoRoot,
      ignore: [],
      exclude: [],
      modules: [],
    };
  }
  return parseConfigFile(candidate);
}

/**
 * Resolve conventions document with precedence:
 * 1. `--no-conventions` -> disabled
 * 2. `--conventions <path>` -> explicit CLI path
 * 3. `.judge-code.json` `conventions: false` -> disabled
 * 4. `.judge-code.json` `conventions: "<path>"` -> config path
 * 5. `<repoRoot>/AGENTS.md` (if present as a regular non-empty file) -> auto-loaded
 */
export function resolveConventionsPath(options: {
  cliConventions?: string;
  noConventions?: boolean;
  config: LoadedJudgeConfig;
  repoRoot: string;
}): ResolvedConventions {
  if (options.noConventions && options.cliConventions !== undefined) {
    throw new Error('Cannot combine --conventions and --no-conventions');
  }
  if (options.noConventions) {
    return { source: 'none' };
  }
  if (options.cliConventions !== undefined) {
    return { path: options.cliConventions, source: 'cli' };
  }
  if (options.config.conventions === false) {
    return { source: 'none' };
  }
  if (typeof options.config.conventions === 'string') {
    return { path: options.config.conventions, source: 'config' };
  }
  const candidate = join(options.repoRoot, DEFAULT_CONVENTIONS_FILENAME);
  const stat = lstatSync(candidate, { throwIfNoEntry: false });
  if (stat?.isFile() && stat.size > 0) {
    try {
      const content = readFileSync(candidate, 'utf8');
      if (content.trim().length > 0) {
        return { path: candidate, source: 'auto' };
      }
    } catch {
      // Ignore unreadable auto-discovered AGENTS.md; explicit --conventions still errors.
    }
  }
  return { source: 'none' };
}

function splitNul(output: string): string[] {
  return output.split('\0').filter((entry) => entry.length > 0);
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

  let baseRef: string | null = null;
  if (options.baseRef !== undefined) {
    const verified = runGit(repoRoot, ['rev-parse', '--verify', '--quiet', `${options.baseRef}^{commit}`]);
    if (!verified.ok) {
      throw new Error(`Unknown git base ref for --changed: ${options.baseRef}`);
    }
    baseRef = options.baseRef;
  } else {
    const hasMain = runGit(repoRoot, ['rev-parse', '--verify', '--quiet', 'main^{commit}']).ok;
    if (hasMain) {
      baseRef = 'main';
    } else if (runGit(repoRoot, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']).ok) {
      baseRef = 'HEAD';
    }
  }

  const changedRelPaths = new Set<string>();
  if (baseRef !== null) {
    const mergeBaseProc = runGit(repoRoot, ['merge-base', baseRef, 'HEAD']);
    const diffTarget = mergeBaseProc.ok && mergeBaseProc.stdout.trim()
      ? mergeBaseProc.stdout.trim()
      : baseRef;
    const diffProc = runGit(repoRoot, ['diff', '--name-only', '-z', '--diff-filter=ACMR', diffTarget]);
    if (!diffProc.ok) {
      throw new Error(`git diff failed for --changed (${diffTarget}): ${diffProc.stderr}`);
    }
    for (const rel of splitNul(diffProc.stdout)) changedRelPaths.add(rel);
  } else {
    // Unborn HEAD (no commits yet): check staged additions.
    const stagedProc = runGit(repoRoot, ['diff', '--name-only', '-z', '--cached', '--diff-filter=ACMR']);
    if (stagedProc.ok) {
      for (const rel of splitNul(stagedProc.stdout)) changedRelPaths.add(rel);
    }
  }

  const untrackedProc = runGit(repoRoot, ['ls-files', '--others', '--exclude-standard', '-z']);
  if (untrackedProc.ok) {
    for (const rel of splitNul(untrackedProc.stdout)) changedRelPaths.add(rel);
  }

  const resolvedFilters = (options.pathFilters ?? []).map((filterPath) => {
    const abs = resolve(options.cwd, filterPath);
    const st = lstatSync(abs, { throwIfNoEntry: false });
    if (!st?.isDirectory() && !st?.isFile()) {
      throw new Error(`Path not found: ${filterPath}`);
    }
    return { abs: realpathSync(abs), isDir: st.isDirectory() };
  });

  const files: string[] = [];
  for (const rel of [...changedRelPaths].sort((a, b) => a.localeCompare(b))) {
    const abs = join(repoRoot, ...rel.split('/'));
    const st = lstatSync(abs, { throwIfNoEntry: false });
    if (!st?.isFile()) continue; // Skip deleted files and symlinks.
    const canonical = realpathSync(abs);
    if (resolvedFilters.length > 0) {
      const matches = resolvedFilters.some((f) => (f.isDir ? isInsideDir(canonical, f.abs) : canonical === f.abs));
      if (!matches) continue;
    }
    files.push(canonical);
  }

  return { repoRoot, baseRef, files };
}
