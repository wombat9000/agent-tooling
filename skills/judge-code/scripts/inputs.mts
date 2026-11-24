import {
  closeSync, constants, fstatSync, lstatSync, openSync, readSync, readdirSync, realpathSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

const MAX_INPUT_BYTES = 128 * 1024;
export const ALLOWED_DOT_DIRS = new Set(['.server', '.client']);
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

export interface DocReadContext {
  allowCredentials?: boolean;
  key?: string;
  consumeBudget: (bytes: number) => void;
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
    if (stat.size > MAX_INPUT_BYTES) throw new Error('Selected inputs exceed 128 KiB');
    const buf = Buffer.alloc(stat.size + 1);
    let size = 0;
    while (size < buf.length) {
      const read = readSync(fd, buf, size, buf.length - size, null);
      if (!read) break;
      size += read;
    }
    ctx.consumeBudget(size);
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

export function readInputs(options: ReadInputsOptions): LoadedInputs {
  const key = process.env.OPENROUTER_API_KEY?.trim();
  let remaining = MAX_INPUT_BYTES;
  const ctx: DocReadContext = {
    allowCredentials: options.allowCredentials,
    key,
    consumeBudget(bytes) {
      if (bytes > remaining) throw new Error('Selected inputs exceed 128 KiB');
      remaining -= bytes;
    },
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

  const out = resolveOutputOutsideSource(source, sourceStat.isDirectory(), options.out);

  const requirements = options.requirements !== undefined
    ? readOptionalDoc(options.requirements, '--requirements', 'the requirements document', ctx)
    : undefined;
  const conventions = options.conventions !== undefined
    ? readOptionalDoc(options.conventions, '--conventions', 'the conventions document', ctx)
    : undefined;

  const files: Record<string, string> = {};
  function collect(dir: string, prefix = '') {
    const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const isAllowedDot = entry.isDirectory() && ALLOWED_DOT_DIRS.has(entry.name);
      if (entry.name.startsWith('.') && !isAllowedDot) continue;
      const path = join(dir, entry.name);
      const name = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory() && !EXCLUDED_DIRS.has(entry.name.toLowerCase())) {
        collect(path, name);
      } else if (entry.isFile() && isProductionSource(path)) {
        files[name] = readUtf8File(path, `source file ${name}`, ctx);
      }
    }
  }
  if (sourceStat.isDirectory()) collect(source);
  else if (isProductionSource(source)) files[basename(source)] = readUtf8File(source, 'the selected source file', ctx);

  if (Object.keys(files).length === 0) {
    throw new Error('No supported production Kotlin or TypeScript files in --source');
  }
  if (key && Object.keys(files).some((path) => path.includes(key))) {
    throw new Error('OPENROUTER_API_KEY appears in a selected source path');
  }

  return { files, requirements, conventions, out };
}
