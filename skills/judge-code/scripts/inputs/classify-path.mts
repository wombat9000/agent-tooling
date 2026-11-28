import { basename } from 'node:path';

/**
 * Language and build-tool path classification rules for routing Kotlin/TypeScript files
 * into production-code analysis, test-code analysis, or build-artifact exclusion.
 */
export type DirectoryDisposition = 'skip' | 'test' | 'production';
export type SourcePartition = 'production' | 'test' | null;

/** Framework routing dot-directories (React Router / Remix) that contain executable source code. */
export const ALLOWED_DOT_DIRS: ReadonlySet<string> = new Set(['.server', '.client']);

/** Dependency, build-output, and generated directories excluded from static analysis. */
export const SKIP_DIRS: ReadonlySet<string> = new Set([
  'node_modules', 'vendor', 'build', 'dist', 'out', 'target', 'coverage', 'generated',
]);

/** Language and test-runner convention directories routed to the test-code analysis partition. */
export const TEST_SUPPORT_DIRS: ReadonlySet<string> = new Set([
  'test', 'tests', 'testing', '__tests__', '__mocks__', '__fixtures__', 'testfixtures',
  'testsupport', 'test-support', 'fixtures', 'androidtest', 'e2e',
]);

const PLAYWRIGHT_CONFIG_RE = /^playwright\.config\.[cm]?[jt]s$/i;
const PYTHON_TEST_RE = /^test_[^/]+\.py$/;
const STANDALONE_TEST_SUPPORT_RE = /^test[-_]support\.[^.]+$/i;
const DOT_TEST_SUFFIX_RE = /\.(?:test|spec|mock|test-support)\.[^.]+$/i;
const UNDERSCORE_TEST_SUFFIX_RE = /_(?:test|spec|test_support)\.[^.]+$/i;
const CAMEL_TEST_SUFFIX_RE = /(?:Test|Tests|Spec|TestSupport)\.[^.]+$/;
const TS_CODE_EXT_RE = /\.(?:tsx?|[cm]ts)$/;
const TS_DECLARATION_RE = /\.d\.[cm]?ts$/;
const GENERATED_TS_RE = /\.generated\.[cm]?tsx?$/i;
const CONFIG_TS_RE = /\.config\.[cm]?tsx?$/i;

export function isPlaywrightConfigFilename(fileName: string): boolean {
  return PLAYWRIGHT_CONFIG_RE.test(fileName);
}

export function isTestOrSupportDirName(dirName: string): boolean {
  return TEST_SUPPORT_DIRS.has(dirName.toLowerCase());
}

export function isTestOrSupportFilename(fileName: string): boolean {
  const lower = fileName.toLowerCase();
  if (isPlaywrightConfigFilename(fileName)) return true;
  if (lower === 'conftest.py' || PYTHON_TEST_RE.test(lower)) return true;
  if (STANDALONE_TEST_SUPPORT_RE.test(fileName)) return true;
  if (DOT_TEST_SUFFIX_RE.test(fileName)) return true;
  if (UNDERSCORE_TEST_SUFFIX_RE.test(fileName)) return true;
  return CAMEL_TEST_SUFFIX_RE.test(fileName);
}

/**
 * Classify whether a source-relative path belongs to tests or test support using
 * universal cross-language directory and filename conventions.
 */
export function isTestOrSupportPath(relPath: string): boolean {
  const parts = relPath.replaceAll('\\', '/').split('/');
  if (parts.slice(0, -1).some((segment) => isTestOrSupportDirName(segment))) {
    return true;
  }
  const fileName = parts[parts.length - 1];
  return fileName ? isTestOrSupportFilename(fileName) : false;
}

export function isSupportedCodeFilename(name: string): boolean {
  if (name.startsWith('.')) return false;
  if (name.endsWith('.kt')) return true;
  const isTypeScript = TS_CODE_EXT_RE.test(name) && !TS_DECLARATION_RE.test(name);
  return isTypeScript && !GENERATED_TS_RE.test(name);
}

export function classifySourceFile(relPath: string, insideTestRoot = false): SourcePartition {
  const name = basename(relPath);
  if (name.startsWith('.')) return null;
  if (isPlaywrightConfigFilename(name)) return 'test';
  if (!isSupportedCodeFilename(name)) return null;
  if (CONFIG_TS_RE.test(name)) return null;
  return insideTestRoot || isTestOrSupportPath(relPath) ? 'test' : 'production';
}

export function isProductionSource(relPath: string): boolean {
  return classifySourceFile(relPath) === 'production';
}

export function isTestSource(relPath: string, insideTestRoot = false): boolean {
  return classifySourceFile(relPath, insideTestRoot) === 'test';
}

export function isHiddenNonRoutingEntry(name: string, isDirectory: boolean): boolean {
  if (!name.startsWith('.')) return false;
  return !(isDirectory && ALLOWED_DOT_DIRS.has(name));
}

/** Route a directory segment to scanner skip, test-partition traversal, or production traversal. */
export function classifyDirectoryName(name: string, includeTests: boolean): DirectoryDisposition {
  if (isHiddenNonRoutingEntry(name, true)) return 'skip';
  if (SKIP_DIRS.has(name.toLowerCase())) return 'skip';
  if (isTestOrSupportDirName(name)) return includeTests ? 'test' : 'skip';
  return 'production';
}

export function isSkippedDirPath(relPath: string, includeTests: boolean): boolean {
  const parts = relPath.replaceAll('\\', '/').split('/');
  for (let i = 0; i < parts.length - 1; i += 1) {
    if (classifyDirectoryName(parts[i], includeTests) === 'skip') return true;
  }
  return false;
}
