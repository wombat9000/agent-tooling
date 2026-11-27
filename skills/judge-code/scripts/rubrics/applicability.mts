import { basename } from 'node:path';
import { isPlaywrightConfigFilename } from '../inputs/classify-path.mts';
import {
  nonempty,
  object,
  type CheckScope,
  type ChoiceQuestion,
  type ResolvedRubric,
  type RubricApplicability,
  type RubricTarget,
} from './types.mts';

const VALID_APPLIES_TO_KEYS = new Set(['extensions', 'runtime_imports']);
const EXTENSION_RE = /^\.[a-z0-9]+$/i;
const PACKAGE_SPECIFIER_RE = /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+(?:\/[a-z0-9._-]+)*$/i;
const IMPORT_CLAUSE_SYNTAX_RE = /^(?:type\s+)?(?:[A-Za-z_$][\w$]*(?:\s*,\s*(?:\*\s+as\s+[A-Za-z_$][\w$]*|\{[^}]*\}))?|\*\s+as\s+[A-Za-z_$][\w$]*|\{[^}]*\})$/;
const EXPORT_CLAUSE_SYNTAX_RE = /^(?:type\s+)?(?:\*(?:\s+as\s+[A-Za-z_$][\w$]*)?|\{[^}]*\})$/;

function parseExtensionsList(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${label}.applies_to.extensions must be a nonempty array of file extensions`);
  }
  return [...new Set(value.map((item, idx) => {
    const ext = nonempty(item, `${label}.applies_to.extensions[${idx}]`).trim().toLowerCase();
    if (!EXTENSION_RE.test(ext)) {
      throw new Error(`Invalid extension in ${label}.applies_to.extensions[${idx}]: ${String(item)}. Expected leading dot (e.g. ".tsx").`);
    }
    return ext;
  }))];
}

function parseRuntimeImportsList(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${label}.applies_to.runtime_imports must be a nonempty array of package specifiers`);
  }
  return [...new Set(value.map((item, idx) => {
    const pkg = nonempty(item, `${label}.applies_to.runtime_imports[${idx}]`).trim();
    if (!PACKAGE_SPECIFIER_RE.test(pkg)) {
      throw new Error(`Invalid package specifier in ${label}.applies_to.runtime_imports[${idx}]: ${String(item)}`);
    }
    return pkg;
  }))];
}

export function parseApplicability(
  value: unknown,
  label: string,
  target: RubricTarget,
): RubricApplicability | undefined {
  if (value === undefined) return undefined;
  if (target === 'project_structure') {
    throw new Error(`${label}.applies_to is not supported for project_structure rubrics`);
  }
  const raw = object(value, `${label}.applies_to`);
  for (const key of Object.keys(raw)) {
    if (!VALID_APPLIES_TO_KEYS.has(key)) {
      throw new Error(`Unknown key in ${label}.applies_to: ${key}. Expected extensions and/or runtime_imports.`);
    }
  }
  const extensions = raw.extensions !== undefined ? parseExtensionsList(raw.extensions, label) : undefined;
  const runtimeImports = raw.runtime_imports !== undefined
    ? parseRuntimeImportsList(raw.runtime_imports, label)
    : undefined;
  if (!extensions && !runtimeImports) {
    throw new Error(`${label}.applies_to must specify at least one of extensions or runtime_imports`);
  }
  return {
    ...(extensions ? { extensions } : {}),
    ...(runtimeImports ? { runtime_imports: runtimeImports } : {}),
  };
}

export function formatApplicability(appliesTo: RubricApplicability): string {
  const parts: string[] = [];
  if (appliesTo.extensions?.length) {
    parts.push(appliesTo.extensions.map((ext) => `*${ext}`).join(', '));
  }
  if (appliesTo.runtime_imports?.length) {
    parts.push(`imports: ${appliesTo.runtime_imports.join(', ')}`);
  }
  return parts.join(' | ');
}

function scanBlockComment(source: string, start: number): { text: string; nextIndex: number } {
  let i = start + 2;
  let newlines = '';
  while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) {
    if (source[i] === '\n') newlines += '\n';
    i += 1;
  }
  return { text: `${newlines} `, nextIndex: i < source.length ? i + 2 : i };
}

function scanQuotedString(source: string, start: number): { text: string; nextIndex: number } {
  const quote = source[start];
  let out = quote;
  let i = start + 1;
  while (i < source.length && source[i] !== quote && source[i] !== '\n') {
    if (source[i] === '\\' && i + 1 < source.length) {
      out += source[i] + source[i + 1];
      i += 2;
      continue;
    }
    out += source[i];
    i += 1;
  }
  if (i < source.length) {
    out += source[i];
    i += 1;
  }
  return { text: out, nextIndex: i };
}

function scanTemplateLiteral(source: string, start: number): { text: string; nextIndex: number } {
  let newlines = '';
  let i = start + 1;
  while (i < source.length && source[i] !== '`') {
    if (source[i] === '\\' && i + 1 < source.length) {
      i += 2;
      continue;
    }
    if (source[i] === '\n') newlines += '\n';
    i += 1;
  }
  return { text: `\`\`${newlines}`, nextIndex: i < source.length ? i + 1 : i };
}

function stripCommentsAndTemplates(source: string): string {
  let out = '';
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    const next = i + 1 < source.length ? source[i + 1] : '';
    if (ch === '/' && next === '/') {
      i += 2;
      while (i < source.length && source[i] !== '\n') i += 1;
    } else if (ch === '/' && next === '*') {
      const token = scanBlockComment(source, i);
      out += token.text;
      i = token.nextIndex;
    } else if (ch === '\'' || ch === '"') {
      const token = scanQuotedString(source, i);
      out += token.text;
      i = token.nextIndex;
    } else if (ch === '`') {
      const token = scanTemplateLiteral(source, i);
      out += token.text;
      i = token.nextIndex;
    } else {
      out += ch;
      i += 1;
    }
  }
  return out;
}

function matchesImportPackage(specifier: string, packages: readonly string[]): boolean {
  return packages.some((pkg) => specifier === pkg || specifier.startsWith(`${pkg}/`));
}

function isRuntimeNamedList(braceBlock: string): boolean {
  const inner = braceBlock.slice(1, -1).trim();
  if (!inner) return false;
  const items = inner.split(',').map((part) => part.trim()).filter(Boolean);
  return items.some((item) => !/^type\s+/.test(item));
}

function isRuntimeClause(rawClause: string, syntaxRe: RegExp): boolean {
  const clause = rawClause.trim();
  if (!syntaxRe.test(clause)) return false;
  if (/^type\s+(?:[*{$A-Za-z_])/.test(clause)) return false;
  if (clause.startsWith('{') && clause.endsWith('}')) {
    return isRuntimeNamedList(clause);
  }
  return true;
}

/** Return true if a TS/JS source file contains a runtime (non-type-only) import/re-export from any target package. */
export function hasRuntimeImport(content: string, packages: readonly string[]): boolean {
  if (packages.length === 0) return false;
  const clean = stripCommentsAndTemplates(content);

  for (const match of clean.matchAll(/^\s*import\s+['"]([^'"]+)['"]/gm)) {
    if (matchesImportPackage(match[1], packages)) return true;
  }
  for (const match of clean.matchAll(/^\s*import\s+([^;'"]+?)\s+from\s+['"]([^'"]+)['"]/gm)) {
    if (matchesImportPackage(match[2], packages) && isRuntimeClause(match[1], IMPORT_CLAUSE_SYNTAX_RE)) {
      return true;
    }
  }
  for (const match of clean.matchAll(/^\s*export\s+([^;'"]+?)\s+from\s+['"]([^'"]+)['"]/gm)) {
    if (matchesImportPackage(match[2], packages) && isRuntimeClause(match[1], EXPORT_CLAUSE_SYNTAX_RE)) {
      return true;
    }
  }
  return false;
}

export function matchesFileApplicability(
  filePath: string,
  content: string,
  appliesTo: RubricApplicability | undefined,
): boolean {
  if (!appliesTo) return true;
  const lower = filePath.toLowerCase();
  if (appliesTo.extensions?.some((ext) => lower.endsWith(ext))) {
    return true;
  }
  if (appliesTo.runtime_imports?.length) {
    const isPlaywrightRule = appliesTo.runtime_imports.some((pkg) => pkg === '@playwright/test' || pkg === 'playwright');
    if (isPlaywrightConfigFilename(basename(filePath)) && isPlaywrightRule) {
      return true;
    }
    if (/\.(?:tsx?|[cm]ts)$/.test(lower)) {
      return hasRuntimeImport(content, appliesTo.runtime_imports);
    }
  }
  return false;
}

export function narrowResolvedRubric(rubric: ResolvedRubric, keepCheckIds: ReadonlySet<string>): ResolvedRubric {
  const questions: Record<string, ChoiceQuestion> = {};
  const scopes: Record<string, CheckScope> = {};
  const thresholds: Record<string, number> = {};
  const appliesTo: Record<string, RubricApplicability> = {};

  for (const id of Object.keys(rubric.questions)) {
    if (!keepCheckIds.has(id)) continue;
    questions[id] = rubric.questions[id];
    scopes[id] = rubric.scopes[id];
    thresholds[id] = rubric.thresholds[id];
    if (rubric.appliesTo?.[id]) appliesTo[id] = rubric.appliesTo[id];
  }

  const groups: Record<string, string[]> = {};
  const groupRubricIds: Record<string, string> = {};
  const activeRubricIds: string[] = [];
  for (const [group, ids] of Object.entries(rubric.groups)) {
    const remaining = ids.filter((id) => id in questions);
    if (remaining.length === 0) continue;
    groups[group] = remaining;
    const rubricId = rubric.groupRubricIds?.[group] ?? (group === 'conventions' ? 'repo-conventions' : group);
    groupRubricIds[group] = rubricId;
    if (!activeRubricIds.includes(rubricId)) activeRubricIds.push(rubricId);
  }

  const unchanged = Object.keys(questions).length === Object.keys(rubric.questions).length;
  return {
    rubric: unchanged ? rubric.rubric : activeRubricIds.join('+'),
    target: rubric.target,
    questions,
    scopes,
    thresholds,
    ...(Object.keys(appliesTo).length > 0 ? { appliesTo } : {}),
    groups,
    ...(Object.keys(groupRubricIds).length > 0 ? { groupRubricIds } : {}),
    excluded: rubric.excluded,
    skippedModuleChecks: rubric.skippedModuleChecks,
  };
}

/**
 * Filter a resolved rubric against a file map (single file in file mode, or module bundle in module mode).
 * Checks with `applies_to` remain active if ANY file in `files` satisfies their applicability rule.
 */
export function filterRubricForFiles(
  rubric: ResolvedRubric,
  files: Record<string, string>,
): ResolvedRubric {
  if (!rubric.appliesTo || Object.keys(rubric.appliesTo).length === 0) {
    return rubric;
  }
  const entries = Object.entries(files);
  const applicabilityCache = new Map<RubricApplicability, boolean>();
  const keep = new Set<string>();

  for (const id of Object.keys(rubric.questions)) {
    const rule = rubric.appliesTo[id];
    if (!rule) {
      keep.add(id);
      continue;
    }
    let matched = applicabilityCache.get(rule);
    if (matched === undefined) {
      matched = entries.some(([filePath, content]) => matchesFileApplicability(filePath, content, rule));
      applicabilityCache.set(rule, matched);
    }
    if (matched) keep.add(id);
  }

  return keep.size === Object.keys(rubric.questions).length
    ? rubric
    : narrowResolvedRubric(rubric, keep);
}
