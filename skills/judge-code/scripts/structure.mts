import {
  closeSync, constants, fstatSync, lstatSync, openSync, readSync, readdirSync, realpathSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import {
  ALLOWED_DOT_DIRS,
  SKIP_DIRS,
  compileIgnoreMatcher,
  isTestOrSupportPath,
  readOptionalDoc,
  resolveOutputOutsideSource,
} from './inputs.mts';

const MAX_MANIFEST_BYTES = 128 * 1024;
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
  out: string;
  ignore?: string[];
  requirements?: string;
  conventions?: string;
  allowCredentials?: boolean;
}

export interface LoadedStructureInputs {
  manifest: StructureManifest;
  requirements?: string;
  conventions?: string;
  out: string;
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

function extractTypeScriptMetadata(text: string): Omit<SourceFileStructureEntry, 'kind' | 'lines'> {
  const clean = stripBlockComments(text);
  const exports: string[] = [];
  const localImports: string[] = [];
  const externalImports: string[] = [];

  for (const match of clean.matchAll(/^\s*export\s+(?:default\s+)?(?:declare\s+)?(?:async\s+)?(?:function\*?|class|const|let|var|type|interface|enum)\s+([A-Za-z_$][A-Za-z0-9_$]*)/gm)) {
    exports.push(match[1]);
  }
  for (const match of clean.matchAll(/^\s*export\s+(?:type\s+)?\{([^}]+)\}/gm)) {
    for (const part of match[1].split(',')) {
      const trimmed = part.trim().replace(/^type\s+/, '');
      if (!trimmed) continue;
      const alias = /\bas\s+([A-Za-z_$][A-Za-z0-9_$]*)$/.exec(trimmed)?.[1];
      const name = alias ?? /^([A-Za-z_$][A-Za-z0-9_$]*)/.exec(trimmed)?.[1];
      if (name) exports.push(name);
    }
  }

  for (const match of clean.matchAll(/(?:from\s+|^\s*import\s+)['"]([^'"]+)['"]/gm)) {
    const spec = match[1];
    if (spec.startsWith('./') || spec.startsWith('../') || spec.startsWith('~/') || spec.startsWith('@/')) {
      localImports.push(spec);
    } else {
      const pkg = spec.startsWith('@')
        ? spec.split('/').slice(0, 2).join('/')
        : spec.split('/')[0];
      externalImports.push(pkg);
    }
  }

  return {
    exports: uniqueCapped(exports, MAX_EXPORTS),
    local_imports: uniqueCapped(localImports, MAX_LOCAL_IMPORTS),
    external_imports: uniqueCapped(externalImports, MAX_EXTERNAL_IMPORTS),
  };
}

function extractKotlinMetadata(text: string): Omit<SourceFileStructureEntry, 'kind' | 'lines'> {
  const clean = stripBlockComments(text);
  const pkg = /^\s*package\s+([A-Za-z0-9_.]+)/m.exec(clean)?.[1];
  const pkgRoot = pkg ? pkg.split('.').slice(0, 2).join('.') : undefined;

  const exports: string[] = [];
  const localImports: string[] = [];
  const externalImports: string[] = [];

  for (const match of clean.matchAll(/^(?:(?:public|internal)\s+)?(?:(?:data|sealed|enum|value|inner|abstract|open|annotation|suspend|inline)\s+)*(?:class|interface|object|fun|typealias)\s+(?:<[^>]+>\s+)?(?:[A-Za-z0-9_.<>?]+\.)?([A-Za-z_][A-Za-z0-9_]*)/gm)) {
    exports.push(match[1]);
  }

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
  const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
  const fd = openSync(path, flags);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_LOCAL_FILE_BYTES) return null;
    const buf = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < buf.length) {
      const n = readSync(fd, buf, offset, buf.length - offset, null);
      if (!n) break;
      offset += n;
    }
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buf.subarray(0, offset));
    return text.includes('\0') ? null : text;
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

export function readStructureInputs(options: ReadStructureOptions): LoadedStructureInputs {
  const key = process.env.OPENROUTER_API_KEY?.trim();
  const ignoreMatcher = compileIgnoreMatcher(options.ignore);
  const sourceInput = resolve(options.source);
  const sourceStat = lstatSync(sourceInput, { throwIfNoEntry: false });
  if (!sourceStat?.isDirectory()) {
    throw new Error('Select a regular directory with --source for structure mode');
  }
  const source = realpathSync(sourceInput);
  if (source === dirname(source) || source === realpathSync(homedir())) {
    throw new Error('Select a specific project or feature directory with --source');
  }

  const out = resolveOutputOutsideSource(source, true, options.out);

  let docBudget = MAX_MANIFEST_BYTES;
  const consumeBudget = (bytes: number) => {
    if (bytes > docBudget) throw new Error('Selected inputs exceed 128 KiB');
    docBudget -= bytes;
  };
  const requirements = options.requirements !== undefined
    ? readOptionalDoc(options.requirements, '--requirements', 'the requirements document', {
      allowCredentials: options.allowCredentials,
      key,
      consumeBudget,
    })
    : undefined;
  const conventions = options.conventions !== undefined
    ? readOptionalDoc(options.conventions, '--conventions', 'the conventions document', {
      allowCredentials: options.allowCredentials,
      key,
      consumeBudget,
    })
    : undefined;

  const directorySummary: Record<string, DirectoryCount> = {};
  const files: Record<string, FileStructureEntry> = {};
  const otherFiles: string[] = [];
  let sourceFileCount = 0;
  let testFileCount = 0;

  function walk(dir: string, prefix = '') {
    const dirKey = prefix || '.';
    const counts: DirectoryCount = { source_files: 0, test_files: 0, other_files: 0, subdirs: 0 };
    directorySummary[dirKey] = counts;

    const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const isAllowedDot = entry.isDirectory() && ALLOWED_DOT_DIRS.has(entry.name);
      if (entry.name.startsWith('.') && !isAllowedDot) continue;
      const fullPath = join(dir, entry.name);
      const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;

      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name.toLowerCase()) || ignoreMatcher.isIgnoredDir(relPath)) continue;
        counts.subdirs += 1;
        walk(fullPath, relPath);
      } else if (entry.isFile()) {
        if (ignoreMatcher.isIgnoredFile(relPath)) continue;
        if (isCodeFile(entry.name)) {
          const kind = isTestOrSupportPath(relPath) ? 'test' : 'source';
          if (kind === 'test') {
            counts.test_files += 1;
            testFileCount += 1;
            // Compact test/test-support entries keep paths, role classification, and directory topology
            // while omitting verbose per-test export/import/line metadata so large repos stay under 128 KiB.
            files[relPath] = { kind: 'test' };
          } else {
            counts.source_files += 1;
            sourceFileCount += 1;
            const text = readLocalSource(fullPath);
            const lines = text === null ? 0 : text.split(/\r?\n/).length;
            const meta = text === null
              ? { exports: [], local_imports: [], external_imports: [] }
              : entry.name.endsWith('.kt')
                ? extractKotlinMetadata(text)
                : extractTypeScriptMetadata(text);
            files[relPath] = { kind: 'source', lines, ...meta };
          }
        } else {
          counts.other_files += 1;
          otherFiles.push(relPath);
        }
      }
    }
  }

  walk(source);

  const otherFileCount = otherFiles.length;
  const totalFiles = sourceFileCount + testFileCount + otherFileCount;
  if (sourceFileCount + testFileCount === 0) {
    throw new Error('No supported Kotlin, TypeScript, or JavaScript files found in --source');
  }

  const manifest: StructureManifest = {
    root_name: basename(source),
    total_files: totalFiles,
    directory_summary: directorySummary,
    files,
    ...(otherFiles.length > 0 ? { other_files: otherFiles.slice(0, 100) } : {}),
  };

  const serialized = JSON.stringify(manifest);
  const serializedBytes = Buffer.byteLength(serialized, 'utf8');
  if (serializedBytes > docBudget) {
    const docBytes = MAX_MANIFEST_BYTES - docBudget;
    const fileBreakdown = `${totalFiles} files: ${sourceFileCount} source, ${testFileCount} test, ${otherFileCount} other`;
    if (docBytes > 0) {
      const totalBytes = serializedBytes + docBytes;
      throw new Error(
        `Structural manifest and documents exceed 128 KiB (${totalBytes} / ${MAX_MANIFEST_BYTES} bytes: `
        + `${serializedBytes} manifest + ${docBytes} documents; ${fileBreakdown}). `
        + 'Narrow --source to a smaller subtree or exclude paths with --ignore.',
      );
    }
    throw new Error(
      `Structural manifest exceeds 128 KiB (${serializedBytes} / ${MAX_MANIFEST_BYTES} bytes; ${fileBreakdown}). `
      + 'Narrow --source to a smaller subtree or exclude paths with --ignore.',
    );
  }
  if (key && serialized.includes(key)) {
    throw new Error('OPENROUTER_API_KEY appears in the structural manifest');
  }

  return { manifest, requirements, conventions, out };
}
