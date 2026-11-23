import {
  closeSync, constants, fstatSync, lstatSync, openSync, readSync, readdirSync, realpathSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { isProductionSource } from './code-judge.mts';

const MAX_INPUT_BYTES = 128 * 1024;
const EXCLUDED_DIRS = new Set([
  '__tests__', '__mocks__', '__fixtures__', 'test', 'tests', 'androidtest', 'testfixtures',
  'fixtures', 'node_modules', 'vendor', 'build', 'dist', 'out', 'target', 'coverage', 'generated',
  'secrets', 'credentials', '.git', '.ssh', '.aws', '.cache',
]);
const SENSITIVE_NAME = /(?:^|[._-])(?:secrets?|credentials?|env|passwords?|[a-z0-9]+_token)(?:$|[._-])/i;
const SENSITIVE_CONTENT = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b(?:sk-or-v1-|sk-(?:proj|svcacct)-|gh[pousr]_|github_pat_|xox[baprs]-)[a-z0-9_-]{16,}/i,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/,
  /(?:api[_-]?key|access[_-]?token|password|client[_-]?secret)['"]?\s*[:=]\s*['"][^\s'"]{8,}['"]/i,
];

function excludedDirectory(name: string): boolean {
  return EXCLUDED_DIRS.has(name.toLowerCase()) || SENSITIVE_NAME.test(name);
}

function supportedSource(file: string): boolean {
  const name = basename(file);
  return !name.startsWith('.') && !SENSITIVE_NAME.test(name) && isProductionSource(name)
    && !/(?:Test|Tests|Spec|\.(?:test|spec))\.kt$/.test(name)
    && !/\.(?:config|generated|mock|spec|test)\.[cm]?tsx?$/i.test(name);
}

/** Resolve existing parent aliases before deciding whether the output overlaps the source. */
function outputPath(path: string): string {
  if (lstatSync(path, { throwIfNoEntry: false })) return realpathSync(path);
  return join(outputPath(dirname(path)), basename(path));
}

export function readInputs(sourceArg: string, requirementsArg: string, outArg: string) {
  const key = process.env.OPENROUTER_API_KEY?.trim();
  let remaining = MAX_INPUT_BYTES;
  const readText = (path: string, label: string): string => {
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    let data: Buffer;
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile()) throw new Error('Selected inputs must be regular files');
      if (stat.size > remaining) throw new Error('Selected requirements and source exceed 128 KiB');
      const buf = Buffer.alloc(remaining + 1);
      let size = 0;
      while (size < buf.length) {
        const read = readSync(fd, buf, size, buf.length - size, null);
        if (!read) break;
        size += read;
      }
      if (size > remaining) throw new Error('Selected requirements and source exceed 128 KiB');
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
    if ((key && text.includes(key)) || SENSITIVE_CONTENT.some((pattern) => pattern.test(text))) {
      throw new Error(`Possible credential in ${label}. Choose a shareable input.`);
    }
    return text;
  };

  const sourceInput = resolve(sourceArg);
  const sourceStat = lstatSync(sourceInput, { throwIfNoEntry: false });
  if (!sourceStat?.isDirectory() && !sourceStat?.isFile()) {
    throw new Error('Select a regular source file or directory with --source');
  }
  const source = realpathSync(sourceInput);
  if ([source, sourceInput].some((path) => path.split(sep).slice(0, -1).some(excludedDirectory))
    || (sourceStat.isDirectory() && (source === dirname(source) || source === realpathSync(homedir())
      || basename(source).startsWith('.') || excludedDirectory(basename(source))))) {
    throw new Error('Select a specific production module with --source');
  }
  const requirementsInput = resolve(requirementsArg);
  if (!lstatSync(requirementsInput, { throwIfNoEntry: false })?.isFile()) {
    throw new Error('Select a regular Markdown or text requirements document with --requirements');
  }
  const requirementsPath = realpathSync(requirementsInput);
  if (!/\.(?:md|markdown|txt)$/i.test(requirementsPath)
    || basename(requirementsPath).startsWith('.') || SENSITIVE_NAME.test(basename(requirementsPath))
    || requirementsPath.split(sep).slice(0, -1).some(excludedDirectory)) {
    throw new Error('Select a regular Markdown or text requirements document with --requirements');
  }

  const out = outputPath(resolve(outArg));
  const fromSource = relative(source, out);
  if (sourceStat.isDirectory() && !isAbsolute(fromSource) && fromSource !== '..' && !fromSource.startsWith(`..${sep}`)) {
    throw new Error('--out must be outside the selected source directory');
  }
  const requirements = readText(requirementsPath, 'the requirements document');
  if (!requirements.trim()) throw new Error('The requirements document is empty');

  const files: Record<string, string> = {};
  function collect(dir: string, prefix = '') {
    const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const path = join(dir, entry.name);
      const name = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory() && !entry.name.startsWith('.') && !excludedDirectory(entry.name)) collect(path, name);
      else if (entry.isFile() && supportedSource(path)) files[name] = readText(path, `source file ${name}`);
    }
  }
  if (sourceStat.isDirectory()) collect(source);
  else if (supportedSource(source)) files[basename(source)] = readText(source, 'the selected source file');
  if (Object.keys(files).length === 0) throw new Error('No supported production Kotlin or TypeScript files in --source');
  if (key && Object.keys(files).some((path) => path.includes(key))) {
    throw new Error('Possible credential in a selected source path');
  }
  return { files, requirements, out };
}
