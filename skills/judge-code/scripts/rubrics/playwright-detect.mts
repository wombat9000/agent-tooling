import { lstatSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, posix, resolve } from 'node:path';
import { isPlaywrightConfigFilename } from '../inputs/classify-path.mts';
import {
  canonicalizeOrFallback,
  decodeStrictUtf8Text,
  isPathInsideDir,
  readRegularFileBuffer,
} from '../inputs/fs-read.mts';
import { extractRelativeRuntimeImports, hasRuntimeImport } from './import-scan.mts';

export const PLAYWRIGHT_PACKAGES = ['@playwright/test', 'playwright'] as const;

const JS_TS_EXT_RE = /\.(?:tsx?|[cm]?[jt]sx?)$/i;
const PLAYWRIGHT_CONFIG_FILENAMES = [
  'playwright.config.ts',
  'playwright.config.mts',
  'playwright.config.js',
  'playwright.config.mjs',
  'playwright.config.cts',
  'playwright.config.cjs',
] as const;
const EXTENSION_FALLBACKS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'] as const;
const MAX_TRANSITIVE_HOPS = 2;
const MAX_ANCESTOR_LEVELS = 3;
const MAX_FIXTURE_READ_BYTES = 128 * 1024;

export interface PlaywrightFileInput {
  filePath: string;
  content: string;
}

export interface PlaywrightSignals {
  isPlaywright: boolean;
  isPlaywrightConfig: boolean;
}

export interface PlaywrightDetectionContext {
  absPath?: string;
  baseDir?: string;
  repoRoot?: string;
  bundleFiles?: Readonly<Record<string, string>>;
  filePaths?: Readonly<Record<string, string>>;
}

interface ImportTarget {
  bundleKey?: string;
  absPath?: string;
  content: string;
}

function toPosixPath(filePath: string): string {
  return filePath.replaceAll('\\', '/');
}

function candidateModulePaths(rawTarget: string): string[] {
  if (/\.js$/i.test(rawTarget)) {
    const stem = rawTarget.slice(0, -3);
    return [`${stem}.ts`, `${stem}.tsx`, rawTarget, `${stem}.jsx`];
  }
  if (/\.jsx$/i.test(rawTarget)) {
    const stem = rawTarget.slice(0, -4);
    return [`${stem}.tsx`, rawTarget];
  }
  if (/\.mjs$/i.test(rawTarget)) {
    const stem = rawTarget.slice(0, -4);
    return [`${stem}.mts`, rawTarget];
  }
  if (/\.cjs$/i.test(rawTarget)) {
    const stem = rawTarget.slice(0, -4);
    return [`${stem}.cts`, rawTarget];
  }
  if (/\.(?:tsx?|[cm]ts)$/i.test(rawTarget)) {
    return [rawTarget];
  }
  return [
    ...EXTENSION_FALLBACKS.map((ext) => `${rawTarget}${ext}`),
    ...EXTENSION_FALLBACKS.map((ext) => `${rawTarget}/index${ext}`),
  ];
}

function resolveFileAbsPath(filePath: string, context?: PlaywrightDetectionContext): string | undefined {
  if (context?.absPath) return context.absPath;
  const mapped = context?.filePaths?.[filePath];
  if (mapped) return mapped;
  if (isAbsolute(filePath)) return filePath;
  if (context?.baseDir) return resolve(context.baseDir, filePath);
  return undefined;
}

function readDiskFileBounded(absPath: string, canonicalRepoRoot?: string): { canonical: string; content: string } | null {
  const stat = lstatSync(absPath, { throwIfNoEntry: false });
  if (!stat?.isFile()) return null;
  const canonical = canonicalizeOrFallback(absPath);
  if (canonicalRepoRoot && !isPathInsideDir(canonical, canonicalRepoRoot)) return null;
  try {
    const read = readRegularFileBuffer({ path: canonical, maxBytes: MAX_FIXTURE_READ_BYTES });
    if (!read) return null;
    const text = decodeStrictUtf8Text(read.buffer);
    return text === null ? null : { canonical, content: text };
  } catch {
    return null;
  }
}

function resolveRelativeTarget(params: {
  specifier: string;
  currentBundleKey?: string;
  currentAbsPath?: string;
  context?: PlaywrightDetectionContext;
  canonicalRepoRoot?: string;
}): ImportTarget | null {
  const { specifier, currentBundleKey, currentAbsPath, context, canonicalRepoRoot } = params;
  if (context?.bundleFiles && currentBundleKey !== undefined) {
    const baseDir = posix.dirname(toPosixPath(currentBundleKey));
    const joined = posix.normalize(baseDir === '.' ? specifier : `${baseDir}/${specifier}`);
    if (!joined.startsWith('../') && joined !== '..') {
      for (const candidate of candidateModulePaths(joined)) {
        const content = context.bundleFiles[candidate];
        if (content !== undefined) {
          return {
            bundleKey: candidate,
            absPath: context.filePaths?.[candidate],
            content,
          };
        }
      }
    }
  }

  if (currentAbsPath !== undefined) {
    const rawTarget = resolve(dirname(currentAbsPath), specifier);
    for (const candidate of candidateModulePaths(rawTarget)) {
      const diskFile = readDiskFileBounded(candidate, canonicalRepoRoot);
      if (diskFile) {
        return { absPath: diskFile.canonical, content: diskFile.content };
      }
    }
  }
  return null;
}

function hasTransitivePlaywrightImport(
  file: PlaywrightFileInput,
  context?: PlaywrightDetectionContext,
): boolean {
  const canonicalRepoRoot = context?.repoRoot ? canonicalizeOrFallback(context.repoRoot) : undefined;
  const initialAbs = resolveFileAbsPath(file.filePath, context);
  const visited = new Set<string>();
  const startKey = initialAbs ? canonicalizeOrFallback(initialAbs) : toPosixPath(file.filePath);
  visited.add(startKey);

  let frontier: Array<{ bundleKey?: string; absPath?: string; content: string }> = [{
    bundleKey: context?.bundleFiles ? toPosixPath(file.filePath) : undefined,
    absPath: initialAbs,
    content: file.content,
  }];

  for (let hop = 0; hop < MAX_TRANSITIVE_HOPS && frontier.length > 0; hop += 1) {
    const nextFrontier: typeof frontier = [];
    for (const node of frontier) {
      for (const specifier of extractRelativeRuntimeImports(node.content)) {
        const resolved = resolveRelativeTarget({
          specifier,
          currentBundleKey: node.bundleKey,
          currentAbsPath: node.absPath,
          context,
          canonicalRepoRoot,
        });
        if (!resolved) continue;
        const visitKey = resolved.absPath ?? resolved.bundleKey ?? '';
        if (!visitKey || visited.has(visitKey)) continue;
        visited.add(visitKey);
        if (hasRuntimeImport(resolved.content, PLAYWRIGHT_PACKAGES)) {
          return true;
        }
        nextFrontier.push(resolved);
      }
    }
    frontier = nextFrontier;
  }
  return false;
}

/**
 * Walk upward from `startDir` (up to `maxLevels` parent directories) to find `playwright.config.{ts,mts,js,mjs,cts,cjs}`.
 * Stops after checking a directory that contains `package.json` or matches `stopDir` (such as repo root).
 */
export function findAncestorPlaywrightConfig(
  startDir: string,
  options: { stopDir?: string; maxLevels?: number } = {},
): string | null {
  const maxLevels = options.maxLevels ?? MAX_ANCESTOR_LEVELS;
  const canonicalStopDir = options.stopDir ? canonicalizeOrFallback(options.stopDir) : undefined;
  let currentDir = canonicalizeOrFallback(startDir);

  for (let level = 0; level <= maxLevels; level += 1) {
    for (const filename of PLAYWRIGHT_CONFIG_FILENAMES) {
      const candidate = join(currentDir, filename);
      if (lstatSync(candidate, { throwIfNoEntry: false })?.isFile()) {
        return canonicalizeOrFallback(candidate);
      }
    }
    if (canonicalStopDir && currentDir === canonicalStopDir) break;
    if (lstatSync(join(currentDir, 'package.json'), { throwIfNoEntry: false })?.isFile()) break;
    const parent = dirname(currentDir);
    if (parent === currentDir) break;
    if (canonicalStopDir && !isPathInsideDir(parent, canonicalStopDir)) break;
    currentDir = parent;
  }
  return null;
}

function hasBundleAncestorPlaywrightConfig(
  filePath: string,
  bundleFiles?: Readonly<Record<string, string>>,
): boolean {
  if (!bundleFiles) return false;
  const normalizedTarget = toPosixPath(filePath);
  return Object.keys(bundleFiles).some((key) => {
    const normalizedKey = toPosixPath(key);
    if (!isPlaywrightConfigFilename(basename(normalizedKey))) return false;
    const configDir = posix.dirname(normalizedKey);
    return configDir === '.' || normalizedTarget.startsWith(`${configDir}/`);
  });
}

/** Return true if a file has a `playwright.config.*` in its own or an ancestor project directory (or bundle). */
export function hasAncestorPlaywrightConfig(
  filePath: string,
  context?: PlaywrightDetectionContext,
): boolean {
  if (hasBundleAncestorPlaywrightConfig(filePath, context?.bundleFiles)) {
    return true;
  }
  const absPath = resolveFileAbsPath(filePath, context);
  if (!absPath) return false;
  const startDir = dirname(absPath);
  if (!lstatSync(startDir, { throwIfNoEntry: false })?.isDirectory()) return false;
  return findAncestorPlaywrightConfig(startDir, { stopDir: context?.repoRoot }) !== null;
}

/**
 * Stage 0 deterministic Playwright detection:
 * 1. `playwright.config.*` filename
 * 2. Direct runtime import of `@playwright/test` / `playwright`
 * 3. Transitive 1–2 hop local fixture import resolving to `@playwright/test` / `playwright`
 */
export function detectPlaywrightSignals(
  file: PlaywrightFileInput,
  context?: PlaywrightDetectionContext,
): PlaywrightSignals {
  const isPlaywrightConfig = isPlaywrightConfigFilename(basename(file.filePath));
  if (isPlaywrightConfig) {
    return { isPlaywright: true, isPlaywrightConfig: true };
  }
  if (!JS_TS_EXT_RE.test(file.filePath)) {
    return { isPlaywright: false, isPlaywrightConfig: false };
  }
  if (hasRuntimeImport(file.content, PLAYWRIGHT_PACKAGES)) {
    return { isPlaywright: true, isPlaywrightConfig: false };
  }
  if (hasTransitivePlaywrightImport(file, context)) {
    return { isPlaywright: true, isPlaywrightConfig: false };
  }
  return { isPlaywright: false, isPlaywrightConfig: false };
}
