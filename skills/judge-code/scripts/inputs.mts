import {
  closeSync, constants, fstatSync, lstatSync, openSync, readSync, readdirSync, realpathSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

export const MAX_INPUT_BYTES = 128 * 1024;
export const ALLOWED_DOT_DIRS = new Set(['.server', '.client']);
export const SKIP_DIRS = new Set([
  'node_modules', 'vendor', 'build', 'dist', 'out', 'target', 'coverage', 'generated',
]);
export const TEST_SUPPORT_DIRS = new Set([
  'test', 'tests', 'testing', '__tests__', '__mocks__', '__fixtures__', 'testfixtures',
  'fixtures', 'androidtest', 'e2e',
]);
const SENSITIVE_CONTENT = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b(?:sk-or-v1-|sk-(?:proj|svcacct)-|gh[pousr]_|github_pat_|xox[baprs]-)[a-z0-9_-]{16,}/i,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/,
  /(?:api[_-]?key|access[_-]?token|password|client[_-]?secret)['"]?\s*[:=]\s*['"][^\s'"]{8,}['"]/i,
];

export interface ReadInputsOptions {
  source?: string;
  sources?: string[];
  displayBaseDir?: string;
  out?: string;
  ignore?: string[];
  requirements?: string;
  conventions?: string;
  allowCredentials?: boolean;
  allowEmpty?: boolean;
  includeProduction?: boolean;
  includeTests?: boolean;
}

export interface IgnoreMatcher {
  patterns: string[];
  isIgnoredFile: (relPath: string) => boolean;
  isIgnoredDir: (relPath: string) => boolean;
}

export interface LoadedInputs {
  files: Record<string, string>;
  testFiles?: Record<string, string>;
  requirements?: string;
  conventions?: string;
  out?: string;
}

export interface DocReadContext {
  allowCredentials?: boolean;
  key?: string;
  maxBytes?: number;
  consumeBudget: (bytes: number, label: string) => void;
}

export function isPlaywrightConfigFilename(fileName: string): boolean {
  return /^playwright\.config\.[cm]?[jt]s$/i.test(fileName);
}

export function isTestOrSupportDirName(dirName: string): boolean {
  return TEST_SUPPORT_DIRS.has(dirName.toLowerCase());
}

export function isTestOrSupportFilename(fileName: string): boolean {
  const lower = fileName.toLowerCase();
  if (isPlaywrightConfigFilename(fileName)) return true;
  if (lower === 'conftest.py' || /^test_[^/]+\.py$/.test(lower)) return true;
  if (/\.(?:test|spec|mock)\.[^.]+$/i.test(fileName)) return true;
  if (/_(?:test|spec)\.[^.]+$/i.test(fileName)) return true;
  if (/(?:Test|Tests|Spec)\.[^.]+$/.test(fileName)) return true;
  return false;
}

/**
 * Classify whether a source-relative path belongs to tests or test support using
 * universal cross-language directory and filename conventions.
 */
export function isTestOrSupportPath(relPath: string): boolean {
  const normalized = relPath.replaceAll('\\', '/');
  const parts = normalized.split('/');
  if (parts.slice(0, -1).some((segment) => isTestOrSupportDirName(segment))) {
    return true;
  }
  const fileName = parts[parts.length - 1];
  return fileName ? isTestOrSupportFilename(fileName) : false;
}

function globToRegExpSource(glob: string): string {
  let regex = '';
  let i = 0;
  while (i < glob.length) {
    if (glob.startsWith('**/', i)) {
      regex += '(?:.*/)?';
      i += 3;
      continue;
    }
    if (glob.startsWith('/**', i) && i + 3 === glob.length) {
      regex += '/.*';
      i += 3;
      continue;
    }
    if (glob.startsWith('**', i)) {
      regex += '.*';
      i += 2;
      continue;
    }
    const ch = glob[i];
    if (ch === '*') {
      regex += '[^/]*';
      i += 1;
    } else if (ch === '?') {
      regex += '[^/]';
      i += 1;
    } else if (ch === '[') {
      const closeIdx = glob.indexOf(']', i + 1);
      if (closeIdx > i + 1 && !glob.slice(i + 1, closeIdx).includes('/')) {
        let content = glob.slice(i + 1, closeIdx);
        if (content.startsWith('!')) content = `^${content.slice(1)}`;
        regex += `[${content.replaceAll('\\', '\\\\')}]`;
        i = closeIdx + 1;
      } else {
        regex += '\\[';
        i += 1;
      }
    } else if (ch === '{') {
      const closeIdx = glob.indexOf('}', i + 1);
      const inner = closeIdx !== -1 ? glob.slice(i + 1, closeIdx) : '';
      if (closeIdx !== -1 && inner.includes(',') && !inner.includes('{')) {
        const alternatives = inner.split(',').map((part) => globToRegExpSource(part));
        regex += `(?:${alternatives.join('|')})`;
        i = closeIdx + 1;
      } else {
        regex += '\\{';
        i += 1;
      }
    } else {
      regex += ch.replace(/[.+^$()|[\]\\{}]/g, '\\$&');
      i += 1;
    }
  }
  return regex;
}

function globToRegExp(glob: string, rawPattern: string): RegExp {
  try {
    return new RegExp(`^${globToRegExpSource(glob)}$`);
  } catch {
    throw new Error(`Invalid --ignore pattern: ${rawPattern}`);
  }
}

function parentPrefixes(normalizedPath: string): string[] {
  const parts = normalizedPath.split('/');
  const prefixes: string[] = [];
  for (let i = 1; i < parts.length; i += 1) {
    prefixes.push(parts.slice(0, i).join('/'));
  }
  return prefixes;
}

/**
 * Compile repeatable `--ignore <glob>` patterns for matching source-relative paths and directories.
 * Patterns without `/` match basenames or any directory segment; patterns with `/` match relative paths.
 */
export function compileIgnoreMatcher(rawPatterns: readonly string[] = []): IgnoreMatcher {
  const patterns: string[] = [];
  const rules: Array<{
    dirOnly: boolean;
    hasSlash: boolean;
    regex: RegExp;
    dirPrefixRegex?: RegExp;
  }> = [];

  for (const raw of rawPatterns) {
    if (!raw.trim()) {
      throw new Error('Invalid --ignore pattern: pattern must be nonempty');
    }
    let normalized = raw.replaceAll('\\', '/');
    while (normalized.startsWith('./')) normalized = normalized.slice(2);
    normalized = normalized.replace(/^\/+/, '');
    const dirOnly = normalized.endsWith('/');
    if (dirOnly) normalized = normalized.replace(/\/+$/, '');
    if (!normalized) {
      throw new Error(`Invalid --ignore pattern: ${raw}`);
    }
    patterns.push(raw);

    const hasSlash = normalized.includes('/');
    const regex = globToRegExp(normalized, raw);
    let dirPrefixRegex: RegExp | undefined;
    if (!dirOnly && hasSlash && normalized.endsWith('/**')) {
      const prefix = normalized.slice(0, -3);
      if (prefix) dirPrefixRegex = globToRegExp(prefix, raw);
    }
    rules.push({ dirOnly, hasSlash, regex, dirPrefixRegex });
  }

  const matchesDir = (normalizedDir: string): boolean => {
    const dirBase = basename(normalizedDir);
    for (const rule of rules) {
      if (rule.dirOnly) {
        if (rule.hasSlash ? rule.regex.test(normalizedDir) : rule.regex.test(dirBase)) return true;
        continue;
      }
      if (!rule.hasSlash) {
        if (rule.regex.test(dirBase)) return true;
      } else if (rule.dirPrefixRegex?.test(normalizedDir) || rule.regex.test(normalizedDir)) {
        return true;
      }
    }
    return false;
  };

  const matchesFile = (normalizedFile: string): boolean => {
    const fileBase = basename(normalizedFile);
    const parents = parentPrefixes(normalizedFile);
    for (const rule of rules) {
      if (rule.dirOnly) {
        if (parents.some((parent) => (rule.hasSlash ? rule.regex.test(parent) : rule.regex.test(basename(parent))))) {
          return true;
        }
        continue;
      }
      if (!rule.hasSlash) {
        if (rule.regex.test(fileBase) || parents.some((parent) => rule.regex.test(basename(parent)))) {
          return true;
        }
      } else if (
        rule.regex.test(normalizedFile)
        || parents.some((parent) => Boolean(rule.dirPrefixRegex?.test(parent) || rule.regex.test(parent)))
      ) {
        return true;
      }
    }
    return false;
  };

  return {
    patterns,
    isIgnoredDir: (relPath: string) => {
      if (rules.length === 0) return false;
      const normalized = relPath.replaceAll('\\', '/').replace(/\/+$/, '');
      return normalized ? matchesDir(normalized) : false;
    },
    isIgnoredFile: (relPath: string) => {
      if (rules.length === 0) return false;
      const normalized = relPath.replaceAll('\\', '/');
      return normalized ? matchesFile(normalized) : false;
    },
  };
}

function isSupportedCodeFilename(name: string): boolean {
  if (name.startsWith('.')) return false;
  if (name.endsWith('.kt')) return true;
  const isTs = /\.(?:tsx?|[cm]ts)$/.test(name) && !/\.d\.[cm]?ts$/.test(name);
  return isTs && !/\.generated\.[cm]?tsx?$/i.test(name);
}

export function isProductionSource(relPath: string): boolean {
  const name = basename(relPath);
  if (!isSupportedCodeFilename(name)) return false;
  if (isTestOrSupportPath(relPath)) return false;
  return !/\.config\.[cm]?tsx?$/i.test(name);
}

export function isTestSource(relPath: string, insideTestRoot = false): boolean {
  const name = basename(relPath);
  if (name.startsWith('.')) return false;
  if (isPlaywrightConfigFilename(name)) return true;
  if (!isSupportedCodeFilename(name)) return false;
  if (/\.config\.[cm]?tsx?$/i.test(name)) return false;
  return insideTestRoot || isTestOrSupportPath(relPath);
}

/** Resolve existing parent aliases before deciding whether the output overlaps the source. */
export function resolveOutputOutsideSource(source: string, isSourceDirectory: boolean, outArg: string): string {
  const resolveAlias = (path: string): string => {
    if (lstatSync(path, { throwIfNoEntry: false })) return realpathSync(path);
    return join(resolveAlias(dirname(path)), basename(path));
  };
  const out = resolveAlias(resolve(outArg));
  const fromSource = relative(source, out);
  if (isSourceDirectory && !isAbsolute(fromSource) && fromSource !== '..' && !fromSource.startsWith(`..${sep}`)) {
    throw new Error('--out must be outside the selected source directory');
  }
  return out;
}

function readUtf8File(path: string, label: string, ctx: DocReadContext): string {
  const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
  const fd = openSync(path, flags);
  let data: Buffer;
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new Error('Selected inputs must be regular files');
    const maxBytes = ctx.maxBytes ?? MAX_INPUT_BYTES;
    if (stat.size > maxBytes) {
      ctx.consumeBudget(stat.size, label);
    }
    const buf = Buffer.alloc(stat.size + 1);
    let size = 0;
    while (size < buf.length) {
      const read = readSync(fd, buf, size, buf.length - size, null);
      if (!read) break;
      size += read;
    }
    ctx.consumeBudget(size, label);
    data = buf.subarray(0, size);
  } finally {
    closeSync(fd);
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(data);
  } catch {
    throw new Error(`Invalid UTF-8 in ${label}`);
  }
  if (text.includes('\0')) throw new Error(`Expected text in ${label}`);
  if (ctx.key && text.includes(ctx.key)) {
    throw new Error(`OPENROUTER_API_KEY appears in ${label}. Remove the key before judging.`);
  }
  if (!ctx.allowCredentials && SENSITIVE_CONTENT.some((pattern) => pattern.test(text))) {
    throw new Error(`Possible credential in ${label}. Inspect the file and re-run with --allow-credentials if it is a false positive.`);
  }
  return text;
}

export function readOptionalDoc(arg: string, flag: string, label: string, ctx: DocReadContext): string {
  const input = resolve(arg);
  if (!lstatSync(input, { throwIfNoEntry: false })?.isFile()) {
    throw new Error(`Select a regular Markdown or text file with ${flag}`);
  }
  const docPath = realpathSync(input);
  if (!/\.(?:md|markdown|txt)$/i.test(docPath) || basename(docPath).startsWith('.')) {
    throw new Error(`Select a regular Markdown or text file with ${flag}`);
  }
  const text = readUtf8File(docPath, label, ctx);
  if (!text.trim()) throw new Error(`${flag} document is empty`);
  return text;
}

interface ResolvedSourceEntry {
  path: string;
  isDirectory: boolean;
}

function resolveSourcesAndOut(options: ReadInputsOptions): {
  entries: ResolvedSourceEntry[];
  out?: string;
} {
  const rawSources = options.sources ?? (options.source !== undefined ? [options.source] : []);
  if (rawSources.length === 0 && !options.allowEmpty) {
    throw new Error('Select at least one production source file or directory');
  }
  const home = realpathSync(homedir());
  const entries: ResolvedSourceEntry[] = [];
  for (const rawSource of rawSources) {
    const sourceInput = resolve(rawSource);
    const sourceStat = lstatSync(sourceInput, { throwIfNoEntry: false });
    if (!sourceStat?.isDirectory() && !sourceStat?.isFile()) {
      throw new Error(`Select a regular source file or directory: ${rawSource}`);
    }
    const canonical = realpathSync(sourceInput);
    if (sourceStat.isDirectory() && (canonical === dirname(canonical) || canonical === home)) {
      throw new Error('Select a specific production file or directory');
    }
    entries.push({ path: canonical, isDirectory: sourceStat.isDirectory() });
  }

  let out: string | undefined;
  if (options.out !== undefined) {
    if (entries.length === 0) {
      out = resolve(options.out);
    } else {
      for (const entry of entries) {
        out = resolveOutputOutsideSource(entry.path, entry.isDirectory, options.out);
      }
    }
  }
  return { entries, out };
}

function toPosixRelative(fromDir: string, absPath: string): string | null {
  const rel = relative(fromDir, absPath);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    return null;
  }
  return rel.split(sep).join('/');
}

function isSkippedDirPath(relPath: string, includeTests: boolean): boolean {
  const parts = relPath.replaceAll('\\', '/').split('/');
  for (let i = 0; i < parts.length - 1; i += 1) {
    const seg = parts[i];
    if (seg.startsWith('.') && !ALLOWED_DOT_DIRS.has(seg)) return true;
    if (SKIP_DIRS.has(seg.toLowerCase())) return true;
    if (!includeTests && isTestOrSupportDirName(seg)) return true;
  }
  return false;
}

type FilePartition = 'production' | 'test';

function collectPartitionedFiles(
  entries: ResolvedSourceEntry[],
  options: {
    displayBaseDir?: string;
    ignoreMatcher: IgnoreMatcher;
    allowEmpty?: boolean;
    includeProduction: boolean;
    includeTests: boolean;
  },
  readFile: (path: string, label: string, partition: FilePartition) => string,
): { productionFiles: Record<string, string>; testFiles: Record<string, string> } {
  const productionFiles: Record<string, string> = {};
  const testFiles: Record<string, string> = {};
  const seenCanonical = new Set<string>();
  const canonicalDisplayBase = options.displayBaseDir
    ? (() => {
      try {
        return realpathSync(options.displayBaseDir);
      } catch {
        return resolve(options.displayBaseDir);
      }
    })()
    : undefined;

  const displayKeyFor = (absFile: string, fallbackRel: string): string => {
    if (canonicalDisplayBase) {
      const fromBase = toPosixRelative(canonicalDisplayBase, absFile);
      if (fromBase !== null) return fromBase;
    }
    return fallbackRel;
  };

  const addFile = (absFile: string, relInSource: string, isSingleFile: boolean, insideTestRoot: boolean) => {
    const canonical = realpathSync(absFile);
    if (seenCanonical.has(canonical)) return;
    const displayKey = displayKeyFor(canonical, relInSource);
    const matchTargets = [relInSource, displayKey];
    if (matchTargets.some((t) => options.ignoreMatcher.isIgnoredFile(t))) {
      return;
    }
    const checkRel = isSingleFile ? displayKey : relInSource;
    if (isSingleFile && isSkippedDirPath(checkRel, options.includeTests)) return;

    const isTest = insideTestRoot
      || isTestOrSupportPath(checkRel)
      || (displayKey !== checkRel && isTestOrSupportPath(displayKey));

    let partition: FilePartition | null = null;
    if (isTest) {
      if (options.includeTests && isTestSource(checkRel, insideTestRoot || isTestOrSupportPath(displayKey))) {
        partition = 'test';
      }
    } else if (options.includeProduction && isProductionSource(checkRel)) {
      partition = 'production';
    }
    if (!partition) return;

    seenCanonical.add(canonical);
    const label = isSingleFile && entries.length === 1 && !canonicalDisplayBase
      ? 'the selected source file'
      : `source file ${displayKey}`;
    const text = readFile(canonical, label, partition);
    if (partition === 'test') {
      testFiles[displayKey] = text;
    } else {
      productionFiles[displayKey] = text;
    }
  };

  function collectDir(rootDir: string, dir: string, insideTestRoot: boolean, prefix = '') {
    const dirEntries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of dirEntries) {
      const isAllowedDot = entry.isDirectory() && ALLOWED_DOT_DIRS.has(entry.name);
      if (entry.name.startsWith('.') && !isAllowedDot) continue;
      const fullPath = join(dir, entry.name);
      const relName = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        const displayDir = canonicalDisplayBase ? toPosixRelative(canonicalDisplayBase, fullPath) : null;
        if (
          SKIP_DIRS.has(entry.name.toLowerCase())
          || (!options.includeTests && isTestOrSupportDirName(entry.name))
          || options.ignoreMatcher.isIgnoredDir(relName)
          || (displayDir !== null && options.ignoreMatcher.isIgnoredDir(displayDir))
        ) {
          continue;
        }
        collectDir(rootDir, fullPath, insideTestRoot || isTestOrSupportDirName(entry.name), relName);
      } else if (entry.isFile()) {
        addFile(fullPath, relName, false, insideTestRoot);
      }
    }
  }

  for (const entry of entries) {
    if (entry.isDirectory) {
      const rootIsTestDir = isTestOrSupportDirName(basename(entry.path));
      if (!options.includeTests && rootIsTestDir) {
        continue;
      }
      collectDir(entry.path, entry.path, rootIsTestDir);
    } else {
      addFile(entry.path, basename(entry.path), true, false);
    }
  }

  const totalCount = Object.keys(productionFiles).length + Object.keys(testFiles).length;
  if (totalCount === 0 && !options.allowEmpty) {
    if (options.includeProduction && !options.includeTests) {
      throw new Error('No supported production Kotlin or TypeScript files found');
    }
    if (!options.includeProduction && options.includeTests) {
      throw new Error('No supported Kotlin or TypeScript test files found');
    }
    throw new Error('No supported Kotlin or TypeScript files found');
  }
  return { productionFiles, testFiles };
}

export function readInputs(options: ReadInputsOptions): LoadedInputs {
  const key = process.env.OPENROUTER_API_KEY?.trim();
  const ignoreMatcher = compileIgnoreMatcher(options.ignore);
  const includeProduction = options.includeProduction ?? true;
  const includeTests = options.includeTests ?? false;

  let docsBytes = 0;
  const docCtx: DocReadContext = {
    allowCredentials: options.allowCredentials,
    key,
    consumeBudget(bytes) {
      if (docsBytes + bytes > MAX_INPUT_BYTES) throw new Error('Selected inputs exceed 128 KiB');
      docsBytes += bytes;
    },
  };

  const { entries, out } = resolveSourcesAndOut(options);

  const requirements = options.requirements !== undefined
    ? readOptionalDoc(options.requirements, '--requirements', 'the requirements document', docCtx)
    : undefined;
  const conventions = options.conventions !== undefined
    ? readOptionalDoc(options.conventions, '--conventions', 'the conventions document', docCtx)
    : undefined;

  let prodRemaining = MAX_INPUT_BYTES - docsBytes;
  let testRemaining = MAX_INPUT_BYTES - docsBytes;
  const prodCtx: DocReadContext = {
    allowCredentials: options.allowCredentials,
    key,
    consumeBudget(bytes) {
      if (bytes > prodRemaining) throw new Error('Selected inputs exceed 128 KiB');
      prodRemaining -= bytes;
    },
  };
  const testCtx: DocReadContext = {
    allowCredentials: options.allowCredentials,
    key,
    consumeBudget(bytes) {
      if (bytes > testRemaining) throw new Error('Selected inputs exceed 128 KiB');
      testRemaining -= bytes;
    },
  };

  const { productionFiles, testFiles } = collectPartitionedFiles(
    entries,
    {
      displayBaseDir: options.displayBaseDir,
      ignoreMatcher,
      allowEmpty: options.allowEmpty,
      includeProduction,
      includeTests,
    },
    (path, label, partition) => readUtf8File(path, label, partition === 'test' ? testCtx : prodCtx),
  );

  if (key && [...Object.keys(productionFiles), ...Object.keys(testFiles)].some((path) => path.includes(key))) {
    throw new Error('OPENROUTER_API_KEY appears in a selected source path');
  }

  return {
    files: productionFiles,
    ...(includeTests ? { testFiles } : {}),
    requirements,
    conventions,
    out,
  };
}

/**
 * Read source (and optionally test) files for file-by-file linting, applying the 128 KiB budget per individual file + optional docs.
 * Validates all selected files up front so oversized, binary, or credential-bearing files fail before any live request.
 */
export function readPerFileInputs(options: ReadInputsOptions): LoadedInputs {
  const key = process.env.OPENROUTER_API_KEY?.trim();
  const ignoreMatcher = compileIgnoreMatcher(options.ignore);
  const includeProduction = options.includeProduction ?? true;
  const includeTests = options.includeTests ?? false;
  const { entries, out } = resolveSourcesAndOut(options);

  let docsBytes = 0;
  const docCtx: DocReadContext = {
    allowCredentials: options.allowCredentials,
    key,
    consumeBudget(bytes) {
      if (docsBytes + bytes > MAX_INPUT_BYTES) {
        throw new Error('Selected documents exceed 128 KiB');
      }
      docsBytes += bytes;
    },
  };

  const requirements = options.requirements !== undefined
    ? readOptionalDoc(options.requirements, '--requirements', 'the requirements document', docCtx)
    : undefined;
  const conventions = options.conventions !== undefined
    ? readOptionalDoc(options.conventions, '--conventions', 'the conventions document', docCtx)
    : undefined;

  const perFileBudget = MAX_INPUT_BYTES - docsBytes;
  const { productionFiles, testFiles } = collectPartitionedFiles(
    entries,
    {
      displayBaseDir: options.displayBaseDir,
      ignoreMatcher,
      allowEmpty: options.allowEmpty,
      includeProduction,
      includeTests,
    },
    (path, label) => {
      const fileCtx: DocReadContext = {
        allowCredentials: options.allowCredentials,
        key,
        maxBytes: perFileBudget,
        consumeBudget(bytes, fileLabel) {
          if (bytes > perFileBudget) {
            const docNote = docsBytes > 0 ? ` + ${docsBytes} bytes documents` : '';
            throw new Error(`${fileLabel} exceeds 128 KiB per-file budget (${bytes} bytes${docNote})`);
          }
        },
      };
      return readUtf8File(path, label, fileCtx);
    },
  );

  if (key && [...Object.keys(productionFiles), ...Object.keys(testFiles)].some((path) => path.includes(key))) {
    throw new Error('OPENROUTER_API_KEY appears in a selected source path');
  }

  return {
    files: productionFiles,
    ...(includeTests ? { testFiles } : {}),
    requirements,
    conventions,
    out,
  };
}
