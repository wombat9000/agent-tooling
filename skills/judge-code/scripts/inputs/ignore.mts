import { basename } from 'node:path';

export interface IgnoreMatcher {
  patterns: string[];
  isIgnoredFile: (relPath: string) => boolean;
  isIgnoredDir: (relPath: string) => boolean;
}

interface CompiledIgnoreRule {
  dirOnly: boolean;
  hasSlash: boolean;
  regex: RegExp;
  dirPrefixRegex?: RegExp;
}

interface NormalizedFilePath {
  fullPath: string;
  baseName: string;
  parents: readonly string[];
}

function consumeCharClass(glob: string, start: number): { fragment: string; nextIndex: number } {
  const closeIdx = glob.indexOf(']', start + 1);
  if (closeIdx > start + 1 && !glob.slice(start + 1, closeIdx).includes('/')) {
    let content = glob.slice(start + 1, closeIdx);
    if (content.startsWith('!')) content = `^${content.slice(1)}`;
    return { fragment: `[${content.replaceAll('\\', '\\\\')}]`, nextIndex: closeIdx + 1 };
  }
  return { fragment: '\\[', nextIndex: start + 1 };
}

function consumeBraceGroup(glob: string, start: number): { fragment: string; nextIndex: number } {
  const closeIdx = glob.indexOf('}', start + 1);
  const inner = closeIdx !== -1 ? glob.slice(start + 1, closeIdx) : '';
  if (closeIdx !== -1 && inner.includes(',') && !inner.includes('{')) {
    const alternatives = inner.split(',').map((part) => globToRegExpSource(part));
    return { fragment: `(?:${alternatives.join('|')})`, nextIndex: closeIdx + 1 };
  }
  return { fragment: '\\{', nextIndex: start + 1 };
}

function globToRegExpSource(glob: string): string {
  let regex = '';
  let i = 0;
  while (i < glob.length) {
    if (glob.startsWith('**/', i)) {
      regex += '(?:.*/)?';
      i += 3;
    } else if (glob.startsWith('/**', i) && i + 3 === glob.length) {
      regex += '/.*';
      i += 3;
    } else if (glob.startsWith('**', i)) {
      regex += '.*';
      i += 2;
    } else if (glob[i] === '*') {
      regex += '[^/]*';
      i += 1;
    } else if (glob[i] === '?') {
      regex += '[^/]';
      i += 1;
    } else if (glob[i] === '[') {
      const token = consumeCharClass(glob, i);
      regex += token.fragment;
      i = token.nextIndex;
    } else if (glob[i] === '{') {
      const token = consumeBraceGroup(glob, i);
      regex += token.fragment;
      i = token.nextIndex;
    } else {
      regex += glob[i].replace(/[.+^$()|[\]\\{}]/g, '\\$&');
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

function compileIgnoreRule(raw: string): CompiledIgnoreRule {
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

  const hasSlash = normalized.includes('/');
  const regex = globToRegExp(normalized, raw);
  let dirPrefixRegex: RegExp | undefined;
  if (!dirOnly && hasSlash && normalized.endsWith('/**')) {
    const prefix = normalized.slice(0, -3);
    if (prefix) dirPrefixRegex = globToRegExp(prefix, raw);
  }
  return { dirOnly, hasSlash, regex, dirPrefixRegex };
}

function ruleMatchesDir(rule: CompiledIgnoreRule, normalizedDir: string, dirBase: string): boolean {
  if (rule.dirOnly) {
    return rule.hasSlash ? rule.regex.test(normalizedDir) : rule.regex.test(dirBase);
  }
  if (!rule.hasSlash) {
    return rule.regex.test(dirBase);
  }
  return Boolean(rule.dirPrefixRegex?.test(normalizedDir) || rule.regex.test(normalizedDir));
}

function ruleMatchesFile(rule: CompiledIgnoreRule, target: NormalizedFilePath): boolean {
  if (rule.dirOnly) {
    return target.parents.some((parent) => (
      rule.hasSlash ? rule.regex.test(parent) : rule.regex.test(basename(parent))
    ));
  }
  if (!rule.hasSlash) {
    return rule.regex.test(target.baseName) || target.parents.some((parent) => rule.regex.test(basename(parent)));
  }
  return rule.regex.test(target.fullPath)
    || target.parents.some((parent) => Boolean(rule.dirPrefixRegex?.test(parent) || rule.regex.test(parent)));
}

/**
 * Compile repeatable `--ignore <glob>` patterns for matching source-relative paths and directories.
 * Patterns without `/` match basenames or any directory segment; patterns with `/` match relative paths.
 */
export function compileIgnoreMatcher(rawPatterns: readonly string[] = []): IgnoreMatcher {
  const patterns = [...rawPatterns];
  const rules = patterns.map((raw) => compileIgnoreRule(raw));

  return {
    patterns,
    isIgnoredDir: (relPath: string) => {
      if (rules.length === 0) return false;
      const normalized = relPath.replaceAll('\\', '/').replace(/\/+$/, '');
      if (!normalized) return false;
      const dirBase = basename(normalized);
      return rules.some((rule) => ruleMatchesDir(rule, normalized, dirBase));
    },
    isIgnoredFile: (relPath: string) => {
      if (rules.length === 0) return false;
      const fullPath = relPath.replaceAll('\\', '/');
      if (!fullPath) return false;
      const target: NormalizedFilePath = {
        fullPath,
        baseName: basename(fullPath),
        parents: parentPrefixes(fullPath),
      };
      return rules.some((rule) => ruleMatchesFile(rule, target));
    },
  };
}
