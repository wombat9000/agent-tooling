import { lstatSync, readdirSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import {
  SKIP_DIRS,
  isHiddenNonRoutingEntry,
  isProductionSource,
  isSkippedDirPath,
  isTestOrSupportDirName,
  isTestOrSupportPath,
  isTestSource,
} from './classify-path.mts';
import {
  canonicalizeOrFallback,
  isPathInsideDir,
  readRegularFileBuffer,
  toPosixRelativeWithin,
} from './fs-read.mts';
import { compileIgnoreMatcher, type IgnoreMatcher } from './ignore.mts';

export const MAX_INPUT_BYTES = 128 * 1024;

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

interface ResolvedSourceEntry {
  path: string;
  isDirectory: boolean;
}

interface PartitionCollectorConfig {
  entries: ResolvedSourceEntry[];
  displayBaseDir?: string;
  ignoreMatcher: IgnoreMatcher;
  allowEmpty?: boolean;
  includeProduction: boolean;
  includeTests: boolean;
  readFile: (path: string, label: string, partition: 'production' | 'test') => string;
}

interface PartitionWalkState {
  productionFiles: Record<string, string>;
  testFiles: Record<string, string>;
  seenCanonical: Set<string>;
  canonicalDisplayBase?: string;
  config: PartitionCollectorConfig;
}

interface DirectoryStep {
  dir: string;
  insideTestRoot: boolean;
  prefix: string;
}

/** Resolve existing parent aliases before deciding whether the output overlaps the source. */
export function resolveOutputOutsideSource(source: string, isSourceDirectory: boolean, outArg: string): string {
  const resolveAlias = (path: string): string => {
    if (lstatSync(path, { throwIfNoEntry: false })) return realpathSync(path);
    return join(resolveAlias(dirname(path)), basename(path));
  };
  const out = resolveAlias(resolve(outArg));
  if (isSourceDirectory && isPathInsideDir(out, source)) {
    throw new Error('--out must be outside the selected source directory');
  }
  return out;
}

function decodeAndScanUtf8Text(data: Buffer, label: string, ctx: DocReadContext): string {
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
    throw new Error(
      `Possible credential in ${label}. Inspect the file and re-run with --allow-credentials if it is a false positive.`,
    );
  }
  return text;
}

function readUtf8File(path: string, label: string, ctx: DocReadContext): string {
  const result = readRegularFileBuffer({
    path,
    maxBytes: ctx.maxBytes ?? MAX_INPUT_BYTES,
    nonRegularError: 'Selected inputs must be regular files',
    onExceedsMax: (size) => ctx.consumeBudget(size, label),
    onSizeRead: (size) => ctx.consumeBudget(size, label),
  });
  return decodeAndScanUtf8Text(result!.buffer, label, ctx);
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

export function loadOptionalDocs(params: {
  options: Pick<ReadInputsOptions, 'requirements' | 'conventions' | 'allowCredentials'>;
  key?: string;
  overflowMessage: string;
}): { requirements?: string; conventions?: string; docsBytes: number } {
  let docsBytes = 0;
  const docCtx: DocReadContext = {
    allowCredentials: params.options.allowCredentials,
    key: params.key,
    consumeBudget(bytes) {
      if (docsBytes + bytes > MAX_INPUT_BYTES) throw new Error(params.overflowMessage);
      docsBytes += bytes;
    },
  };
  const requirements = params.options.requirements !== undefined
    ? readOptionalDoc(params.options.requirements, '--requirements', 'the requirements document', docCtx)
    : undefined;
  const conventions = params.options.conventions !== undefined
    ? readOptionalDoc(params.options.conventions, '--conventions', 'the conventions document', docCtx)
    : undefined;
  return { requirements, conventions, docsBytes };
}

export function assertSpecificDirectory(canonical: string, errorMessage: string): void {
  const home = realpathSync(homedir());
  if (canonical === dirname(canonical) || canonical === home) {
    throw new Error(errorMessage);
  }
}

function resolveSourcesAndOut(options: ReadInputsOptions): {
  entries: ResolvedSourceEntry[];
  out?: string;
} {
  const rawSources = options.sources ?? (options.source !== undefined ? [options.source] : []);
  if (rawSources.length === 0 && !options.allowEmpty) {
    throw new Error('Select at least one production source file or directory');
  }
  const entries: ResolvedSourceEntry[] = [];
  for (const rawSource of rawSources) {
    const sourceInput = resolve(rawSource);
    const sourceStat = lstatSync(sourceInput, { throwIfNoEntry: false });
    if (!sourceStat?.isDirectory() && !sourceStat?.isFile()) {
      throw new Error(`Select a regular source file or directory: ${rawSource}`);
    }
    const canonical = realpathSync(sourceInput);
    if (sourceStat.isDirectory()) {
      assertSpecificDirectory(canonical, 'Select a specific production file or directory');
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

function displayKeyForFile(canonicalDisplayBase: string | undefined, absFile: string, fallbackRel: string): string {
  if (canonicalDisplayBase) {
    const fromBase = toPosixRelativeWithin(canonicalDisplayBase, absFile);
    if (fromBase !== null) return fromBase;
  }
  return fallbackRel;
}

function resolveFilePartition(params: {
  checkRel: string;
  displayKey: string;
  insideTestRoot: boolean;
  includeProduction: boolean;
  includeTests: boolean;
}): 'production' | 'test' | null {
  const isTest = params.insideTestRoot
    || isTestOrSupportPath(params.checkRel)
    || (params.displayKey !== params.checkRel && isTestOrSupportPath(params.displayKey));
  if (isTest) {
    const insideTestContext = params.insideTestRoot || isTestOrSupportPath(params.displayKey);
    return params.includeTests && isTestSource(params.checkRel, insideTestContext) ? 'test' : null;
  }
  return params.includeProduction && isProductionSource(params.checkRel) ? 'production' : null;
}

function collectSingleFile(
  state: PartitionWalkState,
  candidate: { absFile: string; relInSource: string; isSingleFile: boolean; insideTestRoot: boolean },
): void {
  const canonical = realpathSync(candidate.absFile);
  if (state.seenCanonical.has(canonical)) return;
  const displayKey = displayKeyForFile(state.canonicalDisplayBase, canonical, candidate.relInSource);
  const ignoreMatcher = state.config.ignoreMatcher;
  if (ignoreMatcher.isIgnoredFile(candidate.relInSource) || ignoreMatcher.isIgnoredFile(displayKey)) {
    return;
  }
  const checkRel = candidate.isSingleFile ? displayKey : candidate.relInSource;
  if (candidate.isSingleFile && isSkippedDirPath(checkRel, state.config.includeTests)) return;

  const partition = resolveFilePartition({
    checkRel,
    displayKey,
    insideTestRoot: candidate.insideTestRoot,
    includeProduction: state.config.includeProduction,
    includeTests: state.config.includeTests,
  });
  if (!partition) return;

  state.seenCanonical.add(canonical);
  const label = candidate.isSingleFile && state.config.entries.length === 1 && !state.canonicalDisplayBase
    ? 'the selected source file'
    : `source file ${displayKey}`;
  const text = state.config.readFile(canonical, label, partition);
  if (partition === 'test') state.testFiles[displayKey] = text;
  else state.productionFiles[displayKey] = text;
}

function shouldSkipSubdirectory(
  state: PartitionWalkState,
  entry: { name: string; fullPath: string; relName: string },
): boolean {
  if (SKIP_DIRS.has(entry.name.toLowerCase())) return true;
  if (!state.config.includeTests && isTestOrSupportDirName(entry.name)) return true;
  if (state.config.ignoreMatcher.isIgnoredDir(entry.relName)) return true;
  const displayDir = state.canonicalDisplayBase ? toPosixRelativeWithin(state.canonicalDisplayBase, entry.fullPath) : null;
  return displayDir !== null && state.config.ignoreMatcher.isIgnoredDir(displayDir);
}

function collectDirectory(state: PartitionWalkState, step: DirectoryStep): void {
  const dirEntries = readdirSync(step.dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of dirEntries) {
    if (isHiddenNonRoutingEntry(entry.name, entry.isDirectory())) continue;
    const fullPath = join(step.dir, entry.name);
    const relName = step.prefix ? `${step.prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (shouldSkipSubdirectory(state, { name: entry.name, fullPath, relName })) continue;
      collectDirectory(state, {
        dir: fullPath,
        insideTestRoot: step.insideTestRoot || isTestOrSupportDirName(entry.name),
        prefix: relName,
      });
    } else if (entry.isFile()) {
      collectSingleFile(state, {
        absFile: fullPath,
        relInSource: relName,
        isSingleFile: false,
        insideTestRoot: step.insideTestRoot,
      });
    }
  }
}

function assertNonEmptyCollection(
  productionFiles: Record<string, string>,
  testFiles: Record<string, string>,
  config: Pick<PartitionCollectorConfig, 'allowEmpty' | 'includeProduction' | 'includeTests'>,
): void {
  const totalCount = Object.keys(productionFiles).length + Object.keys(testFiles).length;
  if (totalCount > 0 || config.allowEmpty) return;
  if (config.includeProduction && !config.includeTests) {
    throw new Error('No supported production Kotlin or TypeScript files found');
  }
  if (!config.includeProduction && config.includeTests) {
    throw new Error('No supported Kotlin or TypeScript test files found');
  }
  throw new Error('No supported Kotlin or TypeScript files found');
}

function collectPartitionedFiles(
  config: PartitionCollectorConfig,
): { productionFiles: Record<string, string>; testFiles: Record<string, string> } {
  const state: PartitionWalkState = {
    productionFiles: {},
    testFiles: {},
    seenCanonical: new Set<string>(),
    canonicalDisplayBase: config.displayBaseDir ? canonicalizeOrFallback(config.displayBaseDir) : undefined,
    config,
  };

  for (const entry of config.entries) {
    if (entry.isDirectory) {
      const rootIsTestDir = isTestOrSupportDirName(basename(entry.path));
      if (!config.includeTests && rootIsTestDir) continue;
      collectDirectory(state, { dir: entry.path, insideTestRoot: rootIsTestDir, prefix: '' });
    } else {
      collectSingleFile(state, {
        absFile: entry.path,
        relInSource: basename(entry.path),
        isSingleFile: true,
        insideTestRoot: false,
      });
    }
  }

  assertNonEmptyCollection(state.productionFiles, state.testFiles, config);
  return { productionFiles: state.productionFiles, testFiles: state.testFiles };
}

function createSharedBudgetContext(
  remainingStart: number,
  options: Pick<ReadInputsOptions, 'allowCredentials'>,
  key: string | undefined,
): DocReadContext {
  let remaining = remainingStart;
  return {
    allowCredentials: options.allowCredentials,
    key,
    consumeBudget(bytes) {
      if (bytes > remaining) throw new Error('Selected inputs exceed 128 KiB');
      remaining -= bytes;
    },
  };
}

function createPerFileBudgetReader(params: {
  options: Pick<ReadInputsOptions, 'allowCredentials'>;
  key?: string;
  docsBytes: number;
}): PartitionCollectorConfig['readFile'] {
  const perFileBudget = MAX_INPUT_BYTES - params.docsBytes;
  return (path, label) => readUtf8File(path, label, {
    allowCredentials: params.options.allowCredentials,
    key: params.key,
    maxBytes: perFileBudget,
    consumeBudget(bytes, fileLabel) {
      if (bytes > perFileBudget) {
        const docNote = params.docsBytes > 0 ? ` + ${params.docsBytes} bytes documents` : '';
        throw new Error(`${fileLabel} exceeds 128 KiB per-file budget (${bytes} bytes${docNote})`);
      }
    },
  });
}

function loadInputFiles(options: ReadInputsOptions, budgetMode: 'bundle' | 'per-file'): LoadedInputs {
  const key = process.env.OPENROUTER_API_KEY?.trim();
  const ignoreMatcher = compileIgnoreMatcher(options.ignore);
  const includeProduction = options.includeProduction ?? true;
  const includeTests = options.includeTests ?? false;
  const { entries, out } = resolveSourcesAndOut(options);
  const overflowMessage = budgetMode === 'per-file' ? 'Selected documents exceed 128 KiB' : 'Selected inputs exceed 128 KiB';
  const { requirements, conventions, docsBytes } = loadOptionalDocs({ options, key, overflowMessage });

  let readFile: PartitionCollectorConfig['readFile'];
  if (budgetMode === 'per-file') {
    readFile = createPerFileBudgetReader({ options, key, docsBytes });
  } else {
    const prodCtx = createSharedBudgetContext(MAX_INPUT_BYTES - docsBytes, options, key);
    const testCtx = createSharedBudgetContext(MAX_INPUT_BYTES - docsBytes, options, key);
    readFile = (path, label, partition) => readUtf8File(path, label, partition === 'test' ? testCtx : prodCtx);
  }

  const { productionFiles, testFiles } = collectPartitionedFiles({
    entries,
    displayBaseDir: options.displayBaseDir,
    ignoreMatcher,
    allowEmpty: options.allowEmpty,
    includeProduction,
    includeTests,
    readFile,
  });

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

export function readInputs(options: ReadInputsOptions): LoadedInputs {
  return loadInputFiles(options, 'bundle');
}

/**
 * Read source (and optionally test) files for file-by-file linting, applying the 128 KiB budget per individual file + optional docs.
 * Validates all selected files up front so oversized, binary, or credential-bearing files fail before any live request.
 */
export function readPerFileInputs(options: ReadInputsOptions): LoadedInputs {
  return loadInputFiles(options, 'per-file');
}
