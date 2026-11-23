import {
  closeSync, constants, fstatSync, lstatSync, openSync, readSync, readdirSync, realpathSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

const MAX_INPUT_BYTES = 128 * 1024;
const EXCLUDED_DIRS = new Set([
  '__tests__', '__mocks__', '__fixtures__', 'test', 'tests', 'androidtest', 'testfixtures',
  'fixtures', 'node_modules', 'vendor', 'build', 'dist', 'out', 'target', 'coverage', 'generated',
]);
const SENSITIVE_CONTENT = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b(?:sk-or-v1-|sk-(?:proj|svcacct)-|gh[pousr]_|github_pat_|xox[baprs]-)[a-z0-9_-]{16,}/i,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/,
  /(?:api[_-]?key|access[_-]?token|password|client[_-]?secret)['"]?\s*[:=]\s*['"][^\s'"]{8,}['"]/i,
];

export interface ReadInputsOptions {
  source: string;
  out: string;
  requirements?: string;
  conventions?: string;
  allowCredentials?: boolean;
}

export interface LoadedInputs {
  files: Record<string, string>;
  requirements?: string;
  conventions?: string;
  out: string;
}

function isProductionSource(file: string): boolean {
  const name = basename(file);
  if (name.startsWith('.')) return false;
  if (name.endsWith('.kt')) {
    return !/(?:Test|Tests|Spec|\.(?:test|spec))\.kt$/.test(name);
  }
  const isTs = /\.(?:tsx?|[cm]ts)$/.test(name) && !/\.d\.[cm]?ts$/.test(name);
  return isTs && !/\.(?:config|generated|mock|spec|test)\.[cm]?tsx?$/i.test(name);
}

/** Resolve existing parent aliases before deciding whether the output overlaps the source. */
function outputPath(path: string): string {
  if (lstatSync(path, { throwIfNoEntry: false })) return realpathSync(path);
  return join(outputPath(dirname(path)), basename(path));
}

export function readInputs(options: ReadInputsOptions): LoadedInputs {
  const key = process.env.OPENROUTER_API_KEY?.trim();
  let remaining = MAX_INPUT_BYTES;

  const readText = (path: string, label: string): string => {
    const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
    const fd = openSync(path, flags);
    let data: Buffer;
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile()) throw new Error('Selected inputs must be regular files');
      if (stat.size > remaining) throw new Error('Selected inputs exceed 128 KiB');
      const buf = Buffer.alloc(remaining + 1);
      let size = 0;
      while (size < buf.length) {
        const read = readSync(fd, buf, size, buf.length - size, null);
        if (!read) break;
        size += read;
      }
      if (size > remaining) throw new Error('Selected inputs exceed 128 KiB');
      remaining -= size;
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
    if (key && text.includes(key)) {
      throw new Error(`OPENROUTER_API_KEY appears in ${label}. Remove the key before judging.`);
    }
    if (!options.allowCredentials && SENSITIVE_CONTENT.some((pattern) => pattern.test(text))) {
      throw new Error(`Possible credential in ${label}. Inspect the file and re-run with --allow-credentials if it is a false positive.`);
    }
    return text;
  };

  const readDoc = (arg: string, flag: string, label: string): string => {
    const input = resolve(arg);
    if (!lstatSync(input, { throwIfNoEntry: false })?.isFile()) {
      throw new Error(`Select a regular Markdown or text file with ${flag}`);
    }
    const docPath = realpathSync(input);
    if (!/\.(?:md|markdown|txt)$/i.test(docPath) || basename(docPath).startsWith('.')) {
      throw new Error(`Select a regular Markdown or text file with ${flag}`);
    }
    const text = readText(docPath, label);
    if (!text.trim()) throw new Error(`${flag} document is empty`);
    return text;
  };

  const sourceInput = resolve(options.source);
  const sourceStat = lstatSync(sourceInput, { throwIfNoEntry: false });
  if (!sourceStat?.isDirectory() && !sourceStat?.isFile()) {
    throw new Error('Select a regular source file or directory with --source');
  }
  const source = realpathSync(sourceInput);
  if (sourceStat.isDirectory() && (source === dirname(source) || source === realpathSync(homedir()))) {
    throw new Error('Select a specific production module with --source');
  }

  const out = outputPath(resolve(options.out));
  const fromSource = relative(source, out);
  if (sourceStat.isDirectory() && !isAbsolute(fromSource) && fromSource !== '..' && !fromSource.startsWith(`..${sep}`)) {
    throw new Error('--out must be outside the selected source directory');
  }

  const requirements = options.requirements !== undefined
    ? readDoc(options.requirements, '--requirements', 'the requirements document')
    : undefined;
  const conventions = options.conventions !== undefined
    ? readDoc(options.conventions, '--conventions', 'the conventions document')
    : undefined;

  const files: Record<string, string> = {};
  function collect(dir: string, prefix = '') {
    const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const path = join(dir, entry.name);
      const name = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory() && !EXCLUDED_DIRS.has(entry.name.toLowerCase())) {
        collect(path, name);
      } else if (entry.isFile() && isProductionSource(path)) {
        files[name] = readText(path, `source file ${name}`);
      }
    }
  }
  if (sourceStat.isDirectory()) collect(source);
  else if (isProductionSource(source)) files[basename(source)] = readText(source, 'the selected source file');

  if (Object.keys(files).length === 0) {
    throw new Error('No supported production Kotlin or TypeScript files in --source');
  }
  if (key && Object.keys(files).some((path) => path.includes(key))) {
    throw new Error('OPENROUTER_API_KEY appears in a selected source path');
  }

  return { files, requirements, conventions, out };
}
