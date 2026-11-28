import { hasRuntimeImport } from './import-scan.mts';
import {
  PLAYWRIGHT_PACKAGES,
  detectPlaywrightSignals,
  type PlaywrightDetectionContext,
} from './playwright-detect.mts';
import {
  nonempty,
  object,
  type CheckScope,
  type ChoiceQuestion,
  type ResolvedRubric,
  type RubricApplicability,
  type RubricTarget,
} from './types.mts';

export { hasRuntimeImport };

const VALID_APPLIES_TO_KEYS = new Set(['extensions', 'runtime_imports']);
const EXTENSION_RE = /^\.[a-z0-9]+$/i;
const PACKAGE_SPECIFIER_RE = /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+(?:\/[a-z0-9._-]+)*$/i;

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

function isPlaywrightApplicability(runtimeImports: readonly string[]): boolean {
  return runtimeImports.some((pkg) => (PLAYWRIGHT_PACKAGES as readonly string[]).includes(pkg));
}

export function matchesFileApplicability(
  filePath: string,
  content: string,
  appliesTo: RubricApplicability | undefined,
  context?: PlaywrightDetectionContext,
): boolean {
  if (!appliesTo) return true;
  const lower = filePath.toLowerCase();
  if (appliesTo.extensions?.some((ext) => lower.endsWith(ext))) {
    return true;
  }
  if (appliesTo.runtime_imports?.length) {
    if (isPlaywrightApplicability(appliesTo.runtime_imports)) {
      return detectPlaywrightSignals({ filePath, content }, context).isPlaywright;
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
  context?: PlaywrightDetectionContext,
): ResolvedRubric {
  if (!rubric.appliesTo || Object.keys(rubric.appliesTo).length === 0) {
    return rubric;
  }
  const entries = Object.entries(files);
  const fileContext: PlaywrightDetectionContext = {
    ...context,
    bundleFiles: context?.bundleFiles ?? files,
  };
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
      matched = entries.some(([filePath, content]) => (
        matchesFileApplicability(filePath, content, rule, {
          ...fileContext,
          absPath: context?.filePaths?.[filePath] ?? (entries.length === 1 ? context?.absPath : undefined),
        })
      ));
      applicabilityCache.set(rule, matched);
    }
    if (matched) keep.add(id);
  }

  return keep.size === Object.keys(rubric.questions).length
    ? rubric
    : narrowResolvedRubric(rubric, keep);
}
