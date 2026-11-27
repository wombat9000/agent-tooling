import { lstatSync, readdirSync, realpathSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import {
  SKIP_DIRS,
  isHiddenNonRoutingEntry,
  isTestOrSupportPath,
} from './classify-path.mts';
import {
  MAX_INPUT_BYTES,
  assertSpecificDirectory,
  loadOptionalDocs,
  resolveOutputOutsideSource,
} from './files.mts';
import { decodeStrictUtf8Text, readRegularFileBuffer } from './fs-read.mts';
import { compileIgnoreMatcher, type IgnoreMatcher } from './ignore.mts';

const MAX_LOCAL_FILE_BYTES = 512 * 1024;
const MAX_EXPORTS = 15;
const MAX_LOCAL_IMPORTS = 20;
const MAX_EXTERNAL_IMPORTS = 12;

export interface DirectoryCount {
  source_files: number;
  test_files: number;
  other_files: number;
  subdirs: number;
}

export interface SourceFileStructureEntry {
  kind: 'source';
  lines: number;
  package?: string;
  exports: string[];
  local_imports: string[];
  external_imports: string[];
}

export interface TestFileStructureEntry {
  kind: 'test';
}

export type FileStructureEntry = SourceFileStructureEntry | TestFileStructureEntry;

export interface StructureManifest {
  root_name: string;
  total_files: number;
  directory_summary: Record<string, DirectoryCount>;
  files: Record<string, FileStructureEntry>;
  other_files?: string[];
}

export interface ReadStructureOptions {
  source: string;
  out?: string;
  ignore?: string[];
  requirements?: string;
  conventions?: string;
  allowCredentials?: boolean;
}

export interface LoadedStructureInputs {
  manifest: StructureManifest;
  requirements?: string;
  conventions?: string;
  out?: string;
}

interface StructureScanResult {
  directorySummary: Record<string, DirectoryCount>;
  files: Record<string, FileStructureEntry>;
  otherFiles: string[];
  sourceFileCount: number;
  testFileCount: number;
}

function isCodeFile(name: string): boolean {
  return name.endsWith('.kt')
    || (/\.(?:[cm]?[jt]sx?)$/.test(name) && !/\.d\.[cm]?ts$/.test(name));
}

function uniqueCapped(values: Iterable<string>, limit: number): string[] {
  const seen = new Set<string>();
  for (const value of values) {
    if (!value || seen.has(value)) continue;
    seen.add(value);
    if (seen.size >= limit) break;
  }
  return [...seen].sort();
}

function stripBlockComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '');
}

function extractTypeScriptExports(clean: string): string[] {
  const exports: string[] = [];
  const declRe = /^\s*export\s+(?:default\s+)?(?:declare\s+)?(?:async\s+)?(?:function\*?|class|const|let|var|type|interface|enum)\s+([A-Za-z_$][A-Za-z0-9_$]*)/gm;
  for (const match of clean.matchAll(declRe)) exports.push(match[1]);
  for (const match of clean.matchAll(/^\s*export\s+(?:type\s+)?\{([^}]+)\}/gm)) {
    for (const part of match[1].split(',')) {
      const trimmed = part.trim().replace(/^type\s+/, '');
      if (!trimmed) continue;
      const alias = /\bas\s+([A-Za-z_$][A-Za-z0-9_$]*)$/.exec(trimmed)?.[1];
      const name = alias ?? /^([A-Za-z_$][A-Za-z0-9_$]*)/.exec(trimmed)?.[1];
      if (name) exports.push(name);
    }
  }
  return exports;
}

function extractTypeScriptImports(clean: string): { localImports: string[]; externalImports: string[] } {
  const localImports: string[] = [];
  const externalImports: string[] = [];
  for (const match of clean.matchAll(/(?:from\s+|^\s*import\s+)['"]([^'"]+)['"]/gm)) {
    const spec = match[1];
    if (spec.startsWith('./') || spec.startsWith('../') || spec.startsWith('~/') || spec.startsWith('@/')) {
      localImports.push(spec);
    } else {
      externalImports.push(spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]);
    }
  }
  return { localImports, externalImports };
}

function extractTypeScriptMetadata(text: string): Omit<SourceFileStructureEntry, 'kind' | 'lines'> {
  const clean = stripBlockComments(text);
  const { localImports, externalImports } = extractTypeScriptImports(clean);
  return {
    exports: uniqueCapped(extractTypeScriptExports(clean), MAX_EXPORTS),
    local_imports: uniqueCapped(localImports, MAX_LOCAL_IMPORTS),
    external_imports: uniqueCapped(externalImports, MAX_EXTERNAL_IMPORTS),
  };
}

function extractKotlinMetadata(text: string): Omit<SourceFileStructureEntry, 'kind' | 'lines'> {
  const clean = stripBlockComments(text);
  const pkg = /^\s*package\s+([A-Za-z0-9_.]+)/m.exec(clean)?.[1];
  const pkgRoot = pkg ? pkg.split('.').slice(0, 2).join('.') : undefined;

  const exports: string[] = [];
  const declRe = /^(?:(?:public|internal)\s+)?(?:(?:data|sealed|enum|value|inner|abstract|open|annotation|suspend|inline)\s+)*(?:class|interface|object|fun|typealias)\s+(?:<[^>]+>\s+)?(?:[A-Za-z0-9_.<>?]+\.)?([A-Za-z_][A-Za-z0-9_]*)/gm;
  for (const match of clean.matchAll(declRe)) exports.push(match[1]);

  const localImports: string[] = [];
  const externalImports: string[] = [];
  for (const match of clean.matchAll(/^\s*import\s+([A-Za-z0-9_.*]+)/gm)) {
    const imp = match[1];
    if (pkgRoot && imp.startsWith(`${pkgRoot}.`)) {
      localImports.push(imp.slice(pkgRoot.length + 1));
    } else if (!imp.startsWith('java.') && !imp.startsWith('kotlin.')) {
      externalImports.push(imp.split('.').slice(0, 3).join('.'));
    }
  }
  return {
    ...(pkg ? { package: pkg } : {}),
    exports: uniqueCapped(exports, MAX_EXPORTS),
    local_imports: uniqueCapped(localImports, MAX_LOCAL_IMPORTS),
    external_imports: uniqueCapped(externalImports, MAX_EXTERNAL_IMPORTS),
  };
}

function readLocalSource(path: string): string | null {
  try {
    const result = readRegularFileBuffer({ path, maxBytes: MAX_LOCAL_FILE_BYTES });
    return result ? decodeStrictUtf8Text(result.buffer) : null;
  } catch {
    return null;
  }
}

function buildSourceFileEntry(fullPath: string, fileName: string): SourceFileStructureEntry {
  const text = readLocalSource(fullPath);
  const lines = text === null ? 0 : text.split(/\r?\n/).length;
  const meta = text === null
    ? { exports: [], local_imports: [], external_imports: [] }
    : fileName.endsWith('.kt')
      ? extractKotlinMetadata(text)
      : extractTypeScriptMetadata(text);
  return { kind: 'source', lines, ...meta };
}

function validateStructureRoot(sourceArg: string): string {
  const sourceInput = resolve(sourceArg);
  if (!lstatSync(sourceInput, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error('Select a regular directory for structure mode');
  }
  const source = realpathSync(sourceInput);
  assertSpecificDirectory(source, 'Select a specific project or feature directory');
  return source;
}

function recordFileEntry(
  state: StructureScanResult,
  counts: DirectoryCount,
  file: { fullPath: string; relPath: string; fileName: string },
): void {
  if (!isCodeFile(file.fileName)) {
    counts.other_files += 1;
    state.otherFiles.push(file.relPath);
    return;
  }
  if (isTestOrSupportPath(file.relPath)) {
    counts.test_files += 1;
    state.testFileCount += 1;
    state.files[file.relPath] = { kind: 'test' };
    return;
  }
  counts.source_files += 1;
  state.sourceFileCount += 1;
  state.files[file.relPath] = buildSourceFileEntry(file.fullPath, file.fileName);
}

function scanStructureDirectory(rootDir: string, ignoreMatcher: IgnoreMatcher): StructureScanResult {
  const state: StructureScanResult = {
    directorySummary: {},
    files: {},
    otherFiles: [],
    sourceFileCount: 0,
    testFileCount: 0,
  };

  function walk(dir: string, prefix = ''): void {
    const counts: DirectoryCount = { source_files: 0, test_files: 0, other_files: 0, subdirs: 0 };
    state.directorySummary[prefix || '.'] = counts;

    const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (isHiddenNonRoutingEntry(entry.name, entry.isDirectory())) continue;
      const fullPath = join(dir, entry.name);
      const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name.toLowerCase()) || ignoreMatcher.isIgnoredDir(relPath)) continue;
        counts.subdirs += 1;
        walk(fullPath, relPath);
      } else if (entry.isFile() && !ignoreMatcher.isIgnoredFile(relPath)) {
        recordFileEntry(state, counts, { fullPath, relPath, fileName: entry.name });
      }
    }
  }

  walk(rootDir);
  return state;
}

function formatOversizeManifestMessage(params: {
  serializedBytes: number;
  docBytes: number;
  totalFiles: number;
  scan: StructureScanResult;
}): string {
  const { serializedBytes, docBytes, totalFiles, scan } = params;
  const fileBreakdown = `${totalFiles} files: ${scan.sourceFileCount} source, ${scan.testFileCount} test, ${scan.otherFiles.length} other`;
  const guidance = 'Narrow the target directory to a smaller subtree or exclude paths with --ignore.';
  if (docBytes > 0) {
    return `Structural manifest and documents exceed 128 KiB (${serializedBytes + docBytes} / ${MAX_INPUT_BYTES} bytes: ${serializedBytes} manifest + ${docBytes} documents; ${fileBreakdown}). ${guidance}`;
  }
  return `Structural manifest exceeds 128 KiB (${serializedBytes} / ${MAX_INPUT_BYTES} bytes; ${fileBreakdown}). ${guidance}`;
}

function assertManifestWithinBudget(params: {
  manifest: StructureManifest;
  scan: StructureScanResult;
  docsBytes: number;
  key?: string;
}): void {
  const serialized = JSON.stringify(params.manifest);
  const serializedBytes = Buffer.byteLength(serialized, 'utf8');
  if (serializedBytes > MAX_INPUT_BYTES - params.docsBytes) {
    throw new Error(formatOversizeManifestMessage({
      serializedBytes,
      docBytes: params.docsBytes,
      totalFiles: params.manifest.total_files,
      scan: params.scan,
    }));
  }
  if (params.key && serialized.includes(params.key)) {
    throw new Error('OPENROUTER_API_KEY appears in the structural manifest');
  }
}

export function readStructureInputs(options: ReadStructureOptions): LoadedStructureInputs {
  const key = process.env.OPENROUTER_API_KEY?.trim();
  const ignoreMatcher = compileIgnoreMatcher(options.ignore);
  const source = validateStructureRoot(options.source);
  const out = options.out !== undefined ? resolveOutputOutsideSource(source, true, options.out) : undefined;
  const { requirements, conventions, docsBytes } = loadOptionalDocs({
    options,
    key,
    overflowMessage: 'Selected inputs exceed 128 KiB',
  });

  const scan = scanStructureDirectory(source, ignoreMatcher);
  if (scan.sourceFileCount + scan.testFileCount === 0) {
    throw new Error('No supported Kotlin, TypeScript, or JavaScript files found');
  }

  const manifest: StructureManifest = {
    root_name: basename(source),
    total_files: scan.sourceFileCount + scan.testFileCount + scan.otherFiles.length,
    directory_summary: scan.directorySummary,
    files: scan.files,
    ...(scan.otherFiles.length > 0 ? { other_files: scan.otherFiles.slice(0, 100) } : {}),
  };
  assertManifestWithinBudget({ manifest, scan, docsBytes, key });
  return { manifest, requirements, conventions, out };
}
