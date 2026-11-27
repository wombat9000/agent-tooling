import { basename } from 'node:path';

export const ALLOWED_DOT_DIRS = new Set(['.server', '.client']);
export const SKIP_DIRS = new Set([
  'node_modules', 'vendor', 'build', 'dist', 'out', 'target', 'coverage', 'generated',
]);
export const TEST_SUPPORT_DIRS = new Set([
  'test', 'tests', 'testing', '__tests__', '__mocks__', '__fixtures__', 'testfixtures',
  'fixtures', 'androidtest', 'e2e',
]);

const PLAYWRIGHT_CONFIG_RE = /^playwright\.config\.[cm]?[jt]s$/i;
const PYTHON_TEST_RE = /^test_[^/]+\.py$/;
const DOT_TEST_SUFFIX_RE = /\.(?:test|spec|mock)\.[^.]+$/i;
const UNDERSCORE_TEST_SUFFIX_RE = /_(?:test|spec)\.[^.]+$/i;
const CAMEL_TEST_SUFFIX_RE = /(?:Test|Tests|Spec)\.[^.]+$/;
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

export function isProductionSource(relPath: string): boolean {
  const name = basename(relPath);
  if (!isSupportedCodeFilename(name)) return false;
  if (isTestOrSupportPath(relPath)) return false;
  return !CONFIG_TS_RE.test(name);
}

export function isTestSource(relPath: string, insideTestRoot = false): boolean {
  const name = basename(relPath);
  if (name.startsWith('.')) return false;
  if (isPlaywrightConfigFilename(name)) return true;
  if (!isSupportedCodeFilename(name)) return false;
  if (CONFIG_TS_RE.test(name)) return false;
  return insideTestRoot || isTestOrSupportPath(relPath);
}

export function isHiddenNonRoutingEntry(name: string, isDirectory: boolean): boolean {
  if (!name.startsWith('.')) return false;
  return !(isDirectory && ALLOWED_DOT_DIRS.has(name));
}

export function isSkippedDirPath(relPath: string, includeTests: boolean): boolean {
  const parts = relPath.replaceAll('\\', '/').split('/');
  for (let i = 0; i < parts.length - 1; i += 1) {
    const segment = parts[i];
    if (isHiddenNonRoutingEntry(segment, true)) return true;
    if (SKIP_DIRS.has(segment.toLowerCase())) return true;
    if (!includeTests && isTestOrSupportDirName(segment)) return true;
  }
  return false;
}
