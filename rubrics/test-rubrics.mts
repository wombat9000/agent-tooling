#!/usr/bin/env node
/**
 * Unified dual-mode rubric test harness (`pnpm test:rubrics`).
 * Evaluates curated real-file fixtures under rubrics/fixtures/<group>/<id>/ using judge-code's own scoring logic:
 * - production_code and test_code fixtures run in both `file` (per-file aggregated) and `module` (bundled) modes,
 *   narrowed to the fixture's expected check ID(s) and ignoring `scope` filtering in `file` mode so
 *   module-scoped checks report single-file signal alongside enforced module results.
 * - project_structure fixtures read their real `files/` tree directly in `structure` mode only.
 */
import { lstatSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { formatThreshold } from '../skills/judge-code/scripts/cli/format-summary.mts';
import { CLAUDE_MODEL, CODEX_MODEL, runCliJudge } from '../skills/judge-code/scripts/engine/cli-backend.mts';
import { runDecisionJudge } from '../skills/judge-code/scripts/engine/openrouter.mts';
import { probabilityToScore, runWithConcurrency } from '../skills/judge-code/scripts/engine/scoring.mts';
import {
  DEFAULT_DECISION_MODEL,
  DEFAULT_FILE_MODE_DECISION_MODEL,
  type JudgeBackend,
  type JudgeResult,
  type JudgeRunOptions,
} from '../skills/judge-code/scripts/engine/types.mts';
import { readStructureInputs, type StructureManifest } from '../skills/judge-code/scripts/inputs/structure.mts';
import { matchesFileApplicability } from '../skills/judge-code/scripts/rubrics/applicability.mts';
import { resolveRubrics } from '../skills/judge-code/scripts/rubrics/resolver.mts';
import {
  PASS_THRESHOLD,
  nonempty,
  object,
  type CheckScope,
  type ChoiceQuestion,
  type JudgeMode,
  type ResolvedRubric,
  type RubricApplicability,
  type RubricTarget,
} from '../skills/judge-code/scripts/rubrics/types.mts';

export const AUTHORITATIVE_RUBRICS_DIR = fileURLToPath(new URL('.', import.meta.url));
export const DEFAULT_FIXTURES_DIR = fileURLToPath(new URL('./fixtures', import.meta.url));
export const DEFAULT_REPEATS = 2;
const DEFAULT_OPENROUTER_CONCURRENCY = 8;
const DEFAULT_CLI_CONCURRENCY = 2;
const OPENROUTER_MODEL_RE = /^[a-z0-9_.-]+\/[a-z0-9_.:-]+$/i;

const USAGE = `Usage: node rubrics/test-rubrics.mts [options]

Run curated good/bad real-file fixtures under rubrics/fixtures/<group>/<id>/ against authoritative rubrics/*.json.
Production and test_code fixtures run in both \`file\` (per-file) and \`module\` (bundled) modes; structure fixtures run in \`structure\` mode.

  --repeats N          Number of live repeats per mode/fixture (default: ${DEFAULT_REPEATS}; every repeat must pass)
  --fixture ID         Run only matching fixture ID(s) (repeatable)
  --rubric SLUG        Run only fixtures testing this rubric slug (repeatable)
  --rule CHECK_ID      Run only fixtures asserting this check ID (repeatable)
  --modes MODE         Dual-mode target execution: both (default), file, or module
  --backend BACKEND    Judge backend: openrouter (default), codex (${CODEX_MODEL}), or claude (${CLAUDE_MODEL})
  --file-model ID      Model override for file mode (default: ${DEFAULT_FILE_MODE_DECISION_MODEL} openrouter, ${CLAUDE_MODEL} claude, ${CODEX_MODEL} codex)
  --module-model ID    Model override for module/structure mode (default: ${DEFAULT_DECISION_MODEL} openrouter, ${CLAUDE_MODEL} claude, ${CODEX_MODEL} codex)
  --model ID           Model override for all modes (cannot combine with --file-model or --module-model)
  --concurrency N      Max concurrent judge runs (default: ${DEFAULT_OPENROUTER_CONCURRENCY} openrouter, ${DEFAULT_CLI_CONCURRENCY} codex/claude)
  --dry-run            Validate all fixtures, rubric resolution, and request payloads offline (no API calls)
  --json               Print structured JSON report instead of human-readable tables
  --help, -h           Show this help
`;

export type FixtureTarget = RubricTarget;
export type HarnessExecutionMode = 'file' | 'module' | 'structure';
export type HarnessModesOption = 'both' | 'file' | 'module';
export type ExpectedChoice = 'pass' | 'fail';
export type ScopeSignalClassification = 'both' | 'module-only' | 'file-only' | 'neither' | 'incomplete';

export interface LoadedFixture {
  id: string;
  file: string;
  dir: string;
  filesDir: string;
  description: string;
  mode?: 'structure';
  rootName?: string;
  rubrics: string[];
  allRubrics: boolean;
  exclude: string[];
  files: Record<string, string>;
  contextFiles?: Record<string, string>;
  requirements?: string;
  conventions?: string;
  expect: Record<string, ExpectedChoice>;
}

export interface ModeEvaluationSummary {
  mode: HarnessExecutionMode;
  model: string;
  enforced: boolean;
  passed: boolean;
  matches: number;
  repeats: number;
  choices: Array<ExpectedChoice | 'error'>;
  scores: Array<number | null>;
  notes?: Array<string | null>;
  min_score: number | null;
  max_score: number | null;
  errors: string[];
}

export interface CheckEvaluationSummary {
  check_id: string;
  rubric_slug: string;
  declared_scope: CheckScope;
  expected: ExpectedChoice;
  passed: boolean;
  pass_threshold: number | null;
  file?: ModeEvaluationSummary;
  module?: ModeEvaluationSummary;
  structure?: ModeEvaluationSummary;
}

export interface FixtureEvaluationSummary {
  id: string;
  description: string;
  target: FixtureTarget;
  file_count: number;
  rubric: string;
  status: 'passed' | 'failed' | 'dry_run' | 'error';
  elapsed_ms: number;
  models: Partial<Record<HarnessExecutionMode, string>>;
  checks: CheckEvaluationSummary[];
  errors: string[];
}

export interface ModeSignalStats {
  signal: boolean | null;
  pass_fixtures_total: number;
  pass_fixtures_passed: number;
  fail_fixtures_total: number;
  fail_fixtures_passed: number;
  good_min_score: number | null;
  good_max_score: number | null;
  bad_min_score: number | null;
  bad_max_score: number | null;
}

export interface CriterionSignalSummary {
  check_id: string;
  rubric_slug: string;
  declared_scope: 'file' | 'module';
  pass_threshold: number | null;
  file: ModeSignalStats;
  module: ModeSignalStats;
  classification: ScopeSignalClassification;
  promote_hint: boolean;
}

export interface RubricHarnessReport {
  status: 'passed' | 'failed' | 'dry_run';
  backend: JudgeBackend;
  modes: HarnessModesOption;
  models: {
    file: string;
    module: string;
  };
  repeats: number;
  dry_run: boolean;
  elapsed_ms: number;
  fixtures_total: number;
  fixtures_passed: number;
  checks_total: number;
  checks_passed: number;
  fixtures: FixtureEvaluationSummary[];
  criteria_matrix: CriterionSignalSummary[];
}

function normalizeTextBlock(value: unknown, label: string): string {
  if (typeof value === 'string') {
    if (!value.trim()) throw new Error(`${label} must be a nonempty string`);
    return value;
  }
  if (Array.isArray(value) && value.length > 0 && value.every((line) => typeof line === 'string')) {
    const joined = `${value.join('\n')}\n`;
    if (!joined.trim()) throw new Error(`${label} must contain nonempty text`);
    return joined;
  }
  throw new Error(`${label} must be a nonempty string or array of lines`);
}

export function assertSafeRelativePosixPath(fileName: string, label: string): void {
  const segments = fileName.split('/');
  if (
    fileName.startsWith('/')
    || fileName.includes('\\')
    || fileName.includes('\0')
    || segments.some((seg) => seg === '' || seg === '.' || seg === '..')
  ) {
    throw new Error(`${label} file path "${fileName}" must be a safe relative POSIX path`);
  }
}

function discoverFixtureDirs(fixturesDir: string): string[] {
  const discovered: string[] = [];

  function walk(dir: string, relDir = ''): void {
    const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    if (entries.some((entry) => entry.isFile() && entry.name === 'fixture.json')) {
      discovered.push(dir);
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const fullPath = join(dir, entry.name);
      const relPath = relDir ? `${relDir}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) {
        throw new Error(`Fixture symlinks are not supported: ${relPath}`);
      }
      if (entry.isDirectory()) {
        walk(fullPath, relPath);
      } else if (entry.isFile() && entry.name.endsWith('.json')) {
        throw new Error(
          `Legacy flat fixture JSON "${relPath}" is not supported; use <group>/<id>/fixture.json with real source files under files/`,
        );
      }
    }
  }

  walk(fixturesDir);
  return discovered;
}

function readFixtureFilesTree(dir: string, label: string): Record<string, string> {
  const dirName = basename(dir);
  if (!statSync(dir, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(`${label}: missing required "${dirName}/" directory`);
  }
  const files: Record<string, string> = {};

  function walk(currentDir: string, prefix = ''): void {
    const entries = readdirSync(currentDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.name === '.DS_Store') continue;
      const fullPath = join(currentDir, entry.name);
      const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) {
        throw new Error(`${label}: symlink not allowed in ${dirName}/ at "${relPath}"`);
      }
      if (entry.isDirectory()) {
        walk(fullPath, relPath);
      } else if (entry.isFile()) {
        assertSafeRelativePosixPath(relPath, `${label}.${dirName}`);
        const content = readFileSync(fullPath, 'utf8');
        if (!content.trim()) {
          throw new Error(`${label}.${dirName}[${relPath}] must contain nonempty text`);
        }
        files[relPath] = content;
      }
    }
  }

  walk(dir);
  if (Object.keys(files).length === 0) {
    throw new Error(`${label}: "${dirName}/" directory must contain at least one file`);
  }
  return files;
}

function readOptionalFixtureDoc(
  fixtureDir: string,
  fileName: string,
  inlineValue: unknown,
  label: string,
  fieldName: string,
): string | undefined {
  const docPath = join(fixtureDir, fileName);
  const docStat = lstatSync(docPath, { throwIfNoEntry: false });
  if (docStat?.isSymbolicLink()) {
    throw new Error(`${label}: symlink not allowed at "${fileName}"`);
  }
  const hasFile = Boolean(docStat?.isFile());
  if (hasFile && inlineValue !== undefined) {
    throw new Error(`${label}: specify either ${fileName} or "${fieldName}" in fixture.json, not both`);
  }
  if (hasFile) {
    return normalizeTextBlock(readFileSync(docPath, 'utf8'), `${label} (${fileName})`);
  }
  if (inlineValue !== undefined) {
    return normalizeTextBlock(inlineValue, `${label}.${fieldName}`);
  }
  return undefined;
}

function parseFixtureRubricSpec(raw: Record<string, unknown>, label: string): { rubrics: string[]; allRubrics: boolean } {
  const hasSingle = raw.rubric !== undefined;
  const hasMulti = raw.rubrics !== undefined;
  if (hasSingle && hasMulti) {
    throw new Error(`${label}: specify either "rubric" or "rubrics", not both`);
  }
  const spec = hasSingle ? raw.rubric : raw.rubrics;
  if (spec === undefined) {
    throw new Error(`${label}: missing required "rubric" or "rubrics" field`);
  }
  const list = typeof spec === 'string' ? [spec] : Array.isArray(spec) ? spec : null;
  if (!list || list.length === 0) {
    throw new Error(`${label}: rubric/rubrics must be a nonempty string or array of rubric slugs`);
  }
  let allRubrics = false;
  const rubrics: string[] = [];
  for (const item of list) {
    const slug = nonempty(item, `${label}.rubrics`);
    if (slug === '--all' || slug === 'all') {
      allRubrics = true;
      continue;
    }
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
      throw new Error(`${label}: invalid rubric slug "${slug}"`);
    }
    rubrics.push(slug);
  }
  return { rubrics, allRubrics };
}

export function loadFixtures(fixturesDir: string = DEFAULT_FIXTURES_DIR): LoadedFixture[] {
  if (!statSync(fixturesDir, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(`Fixtures directory not found: ${fixturesDir}`);
  }
  const fixtureDirs = discoverFixtureDirs(fixturesDir);
  if (fixtureDirs.length === 0) {
    throw new Error(`No fixture.json files found in ${fixturesDir}`);
  }

  const seenIds = new Set<string>();
  const fixtures: LoadedFixture[] = [];

  for (const fixtureDir of fixtureDirs) {
    const metaPath = join(fixtureDir, 'fixture.json');
    const relMetaPath = relative(fixturesDir, metaPath).split(sep).join('/');
    const label = `fixture ${relMetaPath}`;
    const raw = object(JSON.parse(readFileSync(metaPath, 'utf8')), label);

    if (raw.files !== undefined) {
      throw new Error(`${label}: inline "files" in fixture.json is not supported; place real source files under files/`);
    }
    if (raw.context !== undefined || raw.production_files_context !== undefined) {
      throw new Error(`${label}: inline production context in fixture.json is not supported; place real source files under context/`);
    }

    const id = nonempty(raw.id, `${label}.id`);
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)) {
      throw new Error(`${label}: id "${id}" must be lowercase kebab-case`);
    }
    if (seenIds.has(id)) {
      throw new Error(`Duplicate fixture id: ${id}`);
    }
    seenIds.add(id);

    const description = nonempty(raw.description, `${label}.description`);

    let mode: 'structure' | undefined;
    if (raw.mode !== undefined) {
      if (raw.mode === 'structure') {
        mode = 'structure';
      } else if (raw.mode === 'file' || raw.mode === 'code') {
        throw new Error(
          `${label}: "mode": "${raw.mode}" is obsolete; omit "mode" for production_code and test_code fixtures (they run in both file and module modes)`,
        );
      } else {
        throw new Error(`${label}: mode must be omitted (for production_code/test_code) or "structure" (got ${String(raw.mode)})`);
      }
    }

    const rootName = raw.root_name !== undefined ? nonempty(raw.root_name, `${label}.root_name`) : undefined;
    if (rootName !== undefined && !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(rootName)) {
      throw new Error(`${label}: root_name "${rootName}" must be a single safe directory name`);
    }

    const { rubrics, allRubrics } = parseFixtureRubricSpec(raw, label);

    const excludeRaw = raw.exclude;
    const exclude: string[] = [];
    if (excludeRaw !== undefined) {
      if (!Array.isArray(excludeRaw)) throw new Error(`${label}.exclude must be an array of check IDs`);
      for (const item of excludeRaw) exclude.push(nonempty(item, `${label}.exclude`));
    }

    const filesDir = join(fixtureDir, 'files');
    const normalizedFiles = readFixtureFilesTree(filesDir, label);

    const contextDir = join(fixtureDir, 'context');
    const contextStat = lstatSync(contextDir, { throwIfNoEntry: false });
    if (contextStat?.isSymbolicLink()) {
      throw new Error(`${label}: symlink not allowed at "context"`);
    }
    if (contextStat && !contextStat.isDirectory()) {
      throw new Error(`${label}: "context" must be a directory`);
    }
    const contextFiles = contextStat?.isDirectory()
      ? readFixtureFilesTree(contextDir, label)
      : undefined;

    const requirements = readOptionalFixtureDoc(fixtureDir, 'requirements.md', raw.requirements, label, 'requirements');
    const conventions = readOptionalFixtureDoc(fixtureDir, 'conventions.md', raw.conventions, label, 'conventions');

    const rawExpect = object(raw.expect, `${label}.expect`);
    const expectEntries = Object.entries(rawExpect);
    if (expectEntries.length === 0) {
      throw new Error(`${label}.expect must contain at least one expected check`);
    }
    const expect: Record<string, ExpectedChoice> = {};
    for (const [checkId, verdict] of expectEntries) {
      if (verdict !== 'pass' && verdict !== 'fail') {
        throw new Error(`${label}.expect.${checkId} must be "pass" or "fail" (got ${String(verdict)})`);
      }
      expect[checkId] = verdict;
    }

    fixtures.push({
      id,
      file: relMetaPath,
      dir: fixtureDir,
      filesDir,
      description,
      ...(mode !== undefined ? { mode } : {}),
      ...(rootName !== undefined ? { rootName } : {}),
      rubrics,
      allRubrics,
      exclude,
      files: normalizedFiles,
      ...(contextFiles !== undefined ? { contextFiles } : {}),
      ...(requirements !== undefined ? { requirements } : {}),
      ...(conventions !== undefined ? { conventions } : {}),
      expect,
    });
  }

  fixtures.sort((a, b) => a.id.localeCompare(b.id));
  return fixtures;
}

function readAuthoritativeRubricMeta(rubricsDir: string, slug: string, fixtureId: string): { path: string; target: RubricTarget; id: string } {
  const fullPath = join(rubricsDir, `${slug}.json`);
  if (!statSync(fullPath, { throwIfNoEntry: false })?.isFile()) {
    throw new Error(`Fixture ${fixtureId}: unknown authoritative rubric "${slug}" (${fullPath})`);
  }
  const parsed = object(JSON.parse(readFileSync(fullPath, 'utf8')), `Rubric ${slug}`);
  const rawTarget = parsed.target === undefined ? 'production_code' : parsed.target;
  if (rawTarget !== 'production_code' && rawTarget !== 'project_structure' && rawTarget !== 'test_code') {
    throw new Error(`Fixture ${fixtureId}: rubric "${slug}" targets unsupported "${String(rawTarget)}"`);
  }
  return { path: fullPath, target: rawTarget, id: nonempty(parsed.rubric, `${slug}.rubric`) };
}

function listAuthoritativeRubricsForTarget(rubricsDir: string, target: RubricTarget): string[] {
  return readdirSync(rubricsDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b))
    .filter((file) => {
      const parsed = JSON.parse(readFileSync(join(rubricsDir, file), 'utf8')) as Record<string, unknown>;
      const fileTarget = parsed.target === undefined ? 'production_code' : parsed.target;
      return fileTarget === target;
    })
    .map((file) => file.slice(0, -'.json'.length));
}

function listAllAuthoritativeCheckIds(rubricsDir: string): Set<string> {
  const ids = new Set<string>();
  const files = readdirSync(rubricsDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => entry.name);
  for (const file of files) {
    const parsed = JSON.parse(readFileSync(join(rubricsDir, file), 'utf8')) as Record<string, unknown>;
    const rawTarget = parsed.target === undefined ? 'production_code' : parsed.target;
    if (rawTarget !== 'production_code' && rawTarget !== 'project_structure' && rawTarget !== 'test_code') continue;
    const questions = parsed.questions;
    if (questions && typeof questions === 'object' && !Array.isArray(questions)) {
      for (const checkId of Object.keys(questions as Record<string, unknown>)) {
        ids.add(checkId);
      }
    }
  }
  return ids;
}

/**
 * Resolve and narrow a fixture's authoritative rubric(s) to ONLY the check IDs listed in `fixture.expect`.
 * Uses `mode: 'code'` for `production_code` (and omits `mode` with `allowTestCode: true` for `test_code`)
 * so `module`-scoped checks are NOT stripped, allowing the harness to evaluate them in both `file` and `module`
 * modes while preserving their declared `scopes`.
 */
export function resolveFixtureRubric(
  fixture: LoadedFixture,
  rubricsDir: string = AUTHORITATIVE_RUBRICS_DIR,
): ResolvedRubric {
  const explicitMeta = fixture.rubrics.map((slug) => ({
    slug,
    ...readAuthoritativeRubricMeta(rubricsDir, slug, fixture.id),
  }));

  let inferredTarget: RubricTarget;
  if (explicitMeta.length > 0) {
    inferredTarget = explicitMeta[0].target;
    for (const meta of explicitMeta) {
      if (meta.target !== inferredTarget) {
        throw new Error(`Fixture ${fixture.id}: cannot mix ${inferredTarget} and ${meta.target} rubrics`);
      }
    }
    if (fixture.mode === 'structure' && inferredTarget !== 'project_structure') {
      throw new Error(
        `Fixture ${fixture.id}: mode "structure" is incompatible with ${inferredTarget} rubric "${explicitMeta[0].slug}"`,
      );
    }
  } else {
    inferredTarget = fixture.mode === 'structure' ? 'project_structure' : 'production_code';
  }

  if (fixture.contextFiles !== undefined && inferredTarget !== 'test_code') {
    throw new Error(`Fixture ${fixture.id}: "context/" directory is only supported for test_code fixtures`);
  }

  for (const fileName of Object.keys(fixture.files)) {
    assertSafeRelativePosixPath(fileName, `fixture ${fixture.file}`);
  }

  const slugs = new Set<string>();
  if (fixture.allRubrics) {
    for (const slug of listAuthoritativeRubricsForTarget(rubricsDir, inferredTarget)) slugs.add(slug);
  }
  for (const slug of fixture.rubrics) slugs.add(slug);

  const sortedSlugs = [...slugs].sort((a, b) => a.localeCompare(b));
  const slugToId = new Map<string, string>();
  const rubricPaths = sortedSlugs.map((slug) => {
    const meta = readAuthoritativeRubricMeta(rubricsDir, slug, fixture.id);
    slugToId.set(slug, meta.id);
    return meta.path;
  });

  // Resolve in 'code' mode for production_code (and target-inferred mode for test_code) so module-scoped checks stay active.
  const fullResolved = resolveRubrics({
    mode: inferredTarget === 'project_structure' ? 'structure' : inferredTarget === 'test_code' ? undefined : 'code',
    rubrics: rubricPaths,
    exclude: fixture.exclude,
    hasRequirements: fixture.requirements !== undefined,
    hasConventions: fixture.conventions !== undefined,
    allowTestCode: inferredTarget === 'test_code',
  });

  const expectedIds = Object.keys(fixture.expect);
  for (const checkId of expectedIds) {
    if (!(checkId in fullResolved.questions)) {
      throw new Error(
        `Fixture ${fixture.id}: expected check "${checkId}" is not active in resolved rubric "${fullResolved.rubric}"`,
      );
    }
  }

  // Narrow questions/scopes/thresholds/appliesTo/groups strictly to the fixture's expected check IDs.
  const expectedSet = new Set(expectedIds);
  const narrowedQuestions: Record<string, ChoiceQuestion> = {};
  const narrowedScopes: Record<string, CheckScope> = {};
  const narrowedThresholds: Record<string, number> = {};
  const narrowedAppliesTo: Record<string, RubricApplicability> = {};
  const fixtureFileEntries = Object.entries(fixture.files);
  for (const checkId of expectedIds) {
    narrowedQuestions[checkId] = fullResolved.questions[checkId];
    narrowedScopes[checkId] = fullResolved.scopes[checkId];
    narrowedThresholds[checkId] = fullResolved.thresholds[checkId];
    const ruleAppliesTo = fullResolved.appliesTo?.[checkId];
    if (ruleAppliesTo) {
      const hasMatchingFile = fixtureFileEntries.some(([filePath, content]) =>
        matchesFileApplicability(filePath, content, ruleAppliesTo),
      );
      if (!hasMatchingFile) {
        throw new Error(
          `Fixture ${fixture.id}: expected check "${checkId}" does not match rubric applicability for any file in files/`,
        );
      }
      narrowedAppliesTo[checkId] = ruleAppliesTo;
    }
  }

  const narrowedGroups: Record<string, string[]> = {};
  const narrowedGroupRubricIds: Record<string, string> = {};
  const activeRubricIds: string[] = [];
  for (const [group, ids] of Object.entries(fullResolved.groups)) {
    const kept = ids.filter((id) => expectedSet.has(id));
    if (kept.length > 0) {
      narrowedGroups[group] = kept;
      const rubricId = group === 'conventions' ? 'repo-conventions' : (slugToId.get(group) ?? group);
      narrowedGroupRubricIds[group] = rubricId;
      if (!activeRubricIds.includes(rubricId)) activeRubricIds.push(rubricId);
    }
  }

  return {
    rubric: activeRubricIds.length > 0 ? activeRubricIds.join('+') : fullResolved.rubric,
    target: fullResolved.target,
    questions: narrowedQuestions,
    scopes: narrowedScopes,
    thresholds: narrowedThresholds,
    ...(Object.keys(narrowedAppliesTo).length > 0 ? { appliesTo: narrowedAppliesTo } : {}),
    groups: narrowedGroups,
    groupRubricIds: narrowedGroupRubricIds,
    excluded: fullResolved.excluded,
    skippedModuleChecks: [],
  };
}

function findRubricSlugForCheck(resolved: ResolvedRubric, checkId: string): string {
  for (const [group, ids] of Object.entries(resolved.groups)) {
    if (ids.includes(checkId)) return group;
  }
  return resolved.rubric;
}

function validateCliModelOverride(value: string, flag: string, backend: 'codex' | 'claude'): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed.startsWith('-') || /\s/.test(trimmed)) {
    throw new Error(`Invalid ${flag} for --backend ${backend}: ${value}`);
  }
  return trimmed;
}

function resolveModels(
  backend: JudgeBackend,
  options: { model?: string; fileModel?: string; moduleModel?: string },
): { file: string; module: string } {
  if (options.model !== undefined && (options.fileModel !== undefined || options.moduleModel !== undefined)) {
    throw new Error('Cannot combine --model with --file-model or --module-model');
  }

  if (backend !== 'openrouter') {
    const defaultCli = backend === 'claude' ? CLAUDE_MODEL : CODEX_MODEL;
    if (options.model !== undefined) {
      const m = validateCliModelOverride(options.model, '--model', backend);
      return { file: m, module: m };
    }
    return {
      file: options.fileModel !== undefined ? validateCliModelOverride(options.fileModel, '--file-model', backend) : defaultCli,
      module: options.moduleModel !== undefined ? validateCliModelOverride(options.moduleModel, '--module-model', backend) : defaultCli,
    };
  }

  for (const [flag, val] of [
    ['--model', options.model],
    ['--file-model', options.fileModel],
    ['--module-model', options.moduleModel],
  ] as const) {
    if (val !== undefined && !OPENROUTER_MODEL_RE.test(val)) {
      throw new Error(`Use a full OpenRouter model ID for ${flag} (for example ${DEFAULT_DECISION_MODEL})`);
    }
  }

  if (options.model !== undefined) {
    return { file: options.model, module: options.model };
  }

  return {
    file: options.fileModel ?? DEFAULT_FILE_MODE_DECISION_MODEL,
    module: options.moduleModel ?? DEFAULT_DECISION_MODEL,
  };
}

function parsePositiveInt(value: string, flag: string): number {
  const parsed = Number(value);
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(parsed)) {
    throw new Error(`Invalid ${flag}: ${value}. Expected a positive integer.`);
  }
  return parsed;
}

function parseBackend(value: string | undefined): JudgeBackend {
  if (value === undefined || value === 'openrouter') return 'openrouter';
  if (value === 'codex' || value === 'claude') return value;
  throw new Error(`Invalid --backend: ${value}. Choose openrouter, codex, or claude.`);
}

function parseModes(value: string | undefined): HarnessModesOption {
  if (value === undefined || value === 'both') return 'both';
  if (value === 'file' || value === 'module') return value;
  throw new Error(`Invalid --modes: ${value}. Choose both, file, or module.`);
}

function isModeEnforced(declaredScope: CheckScope, execMode: HarnessExecutionMode): boolean {
  if (declaredScope === 'structure') return execMode === 'structure';
  if (declaredScope === 'file') return execMode === 'file' || execMode === 'module';
  return execMode === 'module';
}

export interface RunHarnessOptions {
  fixturesDir?: string;
  rubricsDir?: string;
  fixtureFilter?: string[];
  rubricFilter?: string[];
  ruleFilter?: string[];
  modes?: HarnessModesOption;
  repeats?: number;
  backend?: JudgeBackend;
  model?: string;
  fileModel?: string;
  moduleModel?: string;
  concurrency?: number;
  dryRun?: boolean;
  transport?: typeof fetch;
}

function buildStructureManifestForFixture(fixture: LoadedFixture): StructureManifest {
  const { manifest } = readStructureInputs({ source: fixture.filesDir });
  return {
    ...manifest,
    root_name: fixture.rootName ?? fixture.id,
  };
}

function computeModeSignalStats(
  entries: ReadonlyArray<{ expected: ExpectedChoice; summary?: ModeEvaluationSummary }>,
  dryRun: boolean,
): ModeSignalStats {
  const passEntries = entries.filter((e) => e.expected === 'pass');
  const failEntries = entries.filter((e) => e.expected === 'fail');

  const collectScores = (list: ReadonlyArray<{ summary?: ModeEvaluationSummary }>) => {
    const nums: number[] = [];
    for (const item of list) {
      for (const s of item.summary?.scores ?? []) {
        if (typeof s === 'number' && Number.isFinite(s)) nums.push(s);
      }
    }
    return {
      min: nums.length > 0 ? Math.min(...nums) : null,
      max: nums.length > 0 ? Math.max(...nums) : null,
    };
  };

  const passPassed = passEntries.filter((e) => e.summary?.passed === true).length;
  const failPassed = failEntries.filter((e) => e.summary?.passed === true).length;
  const goodScores = collectScores(passEntries);
  const badScores = collectScores(failEntries);

  const allEvaluated = entries.length > 0 && entries.every((e) => e.summary !== undefined);
  const canClassify = !dryRun && allEvaluated && passEntries.length > 0 && failEntries.length > 0;
  const signal = canClassify
    ? (passPassed === passEntries.length && failPassed === failEntries.length)
    : null;

  return {
    signal,
    pass_fixtures_total: passEntries.length,
    pass_fixtures_passed: dryRun ? 0 : passPassed,
    fail_fixtures_total: failEntries.length,
    fail_fixtures_passed: dryRun ? 0 : failPassed,
    good_min_score: goodScores.min,
    good_max_score: goodScores.max,
    bad_min_score: badScores.min,
    bad_max_score: badScores.max,
  };
}

export function buildScopeSignalMatrix(
  fixtures: readonly FixtureEvaluationSummary[],
  dryRun: boolean,
): CriterionSignalSummary[] {
  const byCheck = new Map<string, {
    rubric_slug: string;
    declared_scope: 'file' | 'module';
    pass_threshold: number | null;
    entries: Array<{ expected: ExpectedChoice; file?: ModeEvaluationSummary; module?: ModeEvaluationSummary }>;
  }>();

  for (const fixture of fixtures) {
    if (fixture.target !== 'production_code' && fixture.target !== 'test_code') continue;
    for (const check of fixture.checks) {
      if (check.declared_scope !== 'file' && check.declared_scope !== 'module') continue;
      let bucket = byCheck.get(check.check_id);
      if (!bucket) {
        bucket = {
          rubric_slug: check.rubric_slug,
          declared_scope: check.declared_scope,
          pass_threshold: check.pass_threshold,
          entries: [],
        };
        byCheck.set(check.check_id, bucket);
      }
      bucket.entries.push({
        expected: check.expected,
        file: check.file,
        module: check.module,
      });
    }
  }

  const rows: CriterionSignalSummary[] = [];
  for (const [checkId, bucket] of byCheck.entries()) {
    const fileStats = computeModeSignalStats(
      bucket.entries.map((e) => ({ expected: e.expected, summary: e.file })),
      dryRun,
    );
    const moduleStats = computeModeSignalStats(
      bucket.entries.map((e) => ({ expected: e.expected, summary: e.module })),
      dryRun,
    );

    let classification: ScopeSignalClassification;
    if (fileStats.signal === null || moduleStats.signal === null) {
      classification = 'incomplete';
    } else if (fileStats.signal && moduleStats.signal) {
      classification = 'both';
    } else if (!fileStats.signal && moduleStats.signal) {
      classification = 'module-only';
    } else if (fileStats.signal && !moduleStats.signal) {
      classification = 'file-only';
    } else {
      classification = 'neither';
    }

    rows.push({
      check_id: checkId,
      rubric_slug: bucket.rubric_slug,
      declared_scope: bucket.declared_scope,
      pass_threshold: bucket.pass_threshold,
      file: fileStats,
      module: moduleStats,
      classification,
      promote_hint: bucket.declared_scope === 'module' && classification === 'both',
    });
  }

  rows.sort((a, b) => a.rubric_slug.localeCompare(b.rubric_slug) || a.check_id.localeCompare(b.check_id));
  return rows;
}

export async function runRubricHarness(options: RunHarnessOptions = {}): Promise<RubricHarnessReport> {
  const startMs = performance.now();
  const fixturesDir = options.fixturesDir ?? DEFAULT_FIXTURES_DIR;
  const rubricsDir = options.rubricsDir ?? AUTHORITATIVE_RUBRICS_DIR;
  const backend = options.backend ?? 'openrouter';
  const modes = parseModes(options.modes);
  const dryRun = options.dryRun ?? false;
  const repeats = options.repeats ?? DEFAULT_REPEATS;
  const concurrency = options.concurrency ?? (backend === 'openrouter' ? DEFAULT_OPENROUTER_CONCURRENCY : DEFAULT_CLI_CONCURRENCY);

  const models = resolveModels(backend, {
    model: options.model,
    fileModel: options.fileModel,
    moduleModel: options.moduleModel,
  });

  const allFixtures = loadFixtures(fixturesDir);
  const allFixtureIds = new Set(allFixtures.map((f) => f.id));
  const fixtureFilter = options.fixtureFilter ?? [];
  for (const id of fixtureFilter) {
    if (!allFixtureIds.has(id)) {
      throw new Error(`Unknown --fixture "${id}". Available fixtures: ${[...allFixtureIds].join(', ')}`);
    }
  }

  const rubricFilter = options.rubricFilter ?? [];
  for (const slug of rubricFilter) {
    if (!statSync(join(rubricsDir, `${slug}.json`), { throwIfNoEntry: false })?.isFile()) {
      throw new Error(`Unknown --rubric "${slug}" in ${rubricsDir}`);
    }
  }

  const ruleFilter = options.ruleFilter ?? [];
  if (ruleFilter.length > 0) {
    const knownChecks = listAllAuthoritativeCheckIds(rubricsDir);
    for (const ruleId of ruleFilter) {
      if (!knownChecks.has(ruleId)) {
        throw new Error(`Unknown --rule "${ruleId}" in ${rubricsDir}`);
      }
    }
  }

  const resolvedPairs = allFixtures.map((fixture) => ({
    fixture,
    resolved: resolveFixtureRubric(fixture, rubricsDir),
  }));

  const selected = resolvedPairs.filter(({ fixture, resolved }) => {
    if (modes !== 'both' && resolved.target === 'project_structure') return false;
    if (fixtureFilter.length > 0 && !fixtureFilter.includes(fixture.id)) return false;
    if (rubricFilter.length > 0) {
      const activeGroups = new Set(Object.keys(resolved.groups));
      const matchesRubric = rubricFilter.some((slug) => activeGroups.has(slug) || fixture.rubrics.includes(slug));
      if (!matchesRubric) return false;
    }
    if (ruleFilter.length > 0) {
      const expectedKeys = Object.keys(fixture.expect);
      if (!ruleFilter.some((ruleId) => expectedKeys.includes(ruleId))) return false;
    }
    return true;
  });

  if (selected.length === 0) {
    throw new Error('No fixtures matched the selected filters');
  }

  const effectiveRepeats = dryRun ? 1 : repeats;

  interface RunUnit {
    fixtureIndex: number;
    execMode: HarnessExecutionMode;
    repeatIndex: number;
    fixture: LoadedFixture;
    resolved: ResolvedRubric;
    model: string;
  }

  const modesForFixture = (target: RubricTarget): HarnessExecutionMode[] => {
    if (target === 'project_structure') return ['structure'];
    if (modes === 'file') return ['file'];
    if (modes === 'module') return ['module'];
    return ['file', 'module'];
  };

  const units: RunUnit[] = [];
  for (let fixtureIndex = 0; fixtureIndex < selected.length; fixtureIndex += 1) {
    const { fixture, resolved } = selected[fixtureIndex];
    for (const execMode of modesForFixture(resolved.target)) {
      const model = execMode === 'file' ? models.file : models.module;
      for (let repeatIndex = 0; repeatIndex < effectiveRepeats; repeatIndex += 1) {
        units.push({ fixtureIndex, execMode, repeatIndex, fixture, resolved, model });
      }
    }
  }

  interface UnitOutcome {
    fixtureIndex: number;
    execMode: HarnessExecutionMode;
    repeatIndex: number;
    elapsedMs: number;
    result?: JudgeResult;
    error?: string;
  }

  const outcomes = await runWithConcurrency(units, concurrency, async (unit): Promise<UnitOutcome> => {
    const unitStart = performance.now();
    try {
      const judgeMode: JudgeMode = unit.execMode === 'module' ? 'code' : unit.execMode;
      const structure = judgeMode === 'structure'
        ? buildStructureManifestForFixture(unit.fixture)
        : undefined;
      const runOptions: JudgeRunOptions = {
        mode: judgeMode,
        ...(structure !== undefined
          ? { structure }
          : {
            files: unit.fixture.files,
            ...(unit.fixture.contextFiles !== undefined ? { productionContext: unit.fixture.contextFiles } : {}),
          }),
        requirements: unit.fixture.requirements,
        conventions: unit.fixture.conventions,
        rubric: unit.resolved,
        model: unit.model,
        concurrency,
        dryRun,
      };
      const result = backend === 'openrouter'
        ? await runDecisionJudge(runOptions, options.transport)
        : await runCliJudge(runOptions, backend);
      return {
        fixtureIndex: unit.fixtureIndex,
        execMode: unit.execMode,
        repeatIndex: unit.repeatIndex,
        elapsedMs: Math.round(performance.now() - unitStart),
        result,
      };
    } catch (error) {
      return {
        fixtureIndex: unit.fixtureIndex,
        execMode: unit.execMode,
        repeatIndex: unit.repeatIndex,
        elapsedMs: Math.round(performance.now() - unitStart),
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });

  const fixtureSummaries: FixtureEvaluationSummary[] = selected.map(({ fixture, resolved }, fixtureIndex) => {
    const execModes = modesForFixture(resolved.target);
    const fixtureOutcomes = outcomes.filter((o) => o.fixtureIndex === fixtureIndex);
    const elapsedMs = fixtureOutcomes.reduce((max, o) => Math.max(max, o.elapsedMs), 0);

    const fixtureModels: Partial<Record<HarnessExecutionMode, string>> = {};
    const errorsByMode = new Map<HarnessExecutionMode, string[]>();
    const allErrors: string[] = [];

    for (const execMode of execModes) {
      fixtureModels[execMode] = execMode === 'file' ? models.file : models.module;
      const modeOutcomes = fixtureOutcomes
        .filter((o) => o.execMode === execMode)
        .sort((a, b) => a.repeatIndex - b.repeatIndex);
      const modeErrors: string[] = [];
      for (const outcome of modeOutcomes) {
        if (outcome.error) {
          modeErrors.push(`repeat ${outcome.repeatIndex + 1}: ${outcome.error}`);
        } else if (outcome.result?.status === 'error') {
          modeErrors.push(`repeat ${outcome.repeatIndex + 1}: ${outcome.result.error ?? 'judge error'}`);
        }
      }
      errorsByMode.set(execMode, modeErrors);
      for (const err of modeErrors) {
        allErrors.push(`[${execMode}] ${err}`);
      }
    }

    const checks: CheckEvaluationSummary[] = Object.entries(fixture.expect).map(([checkId, expected]) => {
      const declaredScope = resolved.scopes[checkId];
      const rubricSlug = findRubricSlugForCheck(resolved, checkId);
      const threshold = probabilityToScore(resolved.thresholds[checkId] ?? PASS_THRESHOLD);

      const modeSummaries: Partial<Record<HarnessExecutionMode, ModeEvaluationSummary>> = {};

      for (const execMode of execModes) {
        const modeModel = execMode === 'file' ? models.file : models.module;
        const enforced = isModeEnforced(declaredScope, execMode);
        const modeErrors = errorsByMode.get(execMode) ?? [];
        const modeOutcomes = fixtureOutcomes
          .filter((o) => o.execMode === execMode)
          .sort((a, b) => a.repeatIndex - b.repeatIndex);

        if (dryRun) {
          modeSummaries[execMode] = {
            mode: execMode,
            model: modeModel,
            enforced,
            passed: modeErrors.length === 0,
            matches: 0,
            repeats: 0,
            choices: [],
            scores: [],
            min_score: null,
            max_score: null,
            errors: modeErrors,
          };
          continue;
        }

        const choices: Array<ExpectedChoice | 'error'> = [];
        const scores: Array<number | null> = [];
        const notes: Array<string | null> = [];
        let matches = 0;

        for (const outcome of modeOutcomes) {
          const judgment = outcome.result?.status === 'scored' ? outcome.result.quality?.checks[checkId] : undefined;
          if (!judgment) {
            choices.push('error');
            scores.push(null);
            notes.push(null);
            continue;
          }
          choices.push(judgment.choice);
          // In per-file mode, aggregatePerFile gates pass/fail on the weakest file (min_score).
          const score = typeof judgment.min_score === 'number'
            ? judgment.min_score
            : judgment.score;
          scores.push(score);
          let note: string | null = judgment.note ?? null;
          if (note === null && outcome.result?.file_results) {
            const perFileJudgments = outcome.result.file_results
              .filter((fr) => fr.status === 'scored' && fr.checks?.[checkId])
              .map((fr) => ({ file: fr.file, check: fr.checks![checkId] }))
              .filter((item) => typeof item.check.note === 'string' && item.check.note.length > 0);
            if (perFileJudgments.length > 0) {
              perFileJudgments.sort((a, b) => (a.check.score ?? 0) - (b.check.score ?? 0));
              const worst = perFileJudgments[0];
              note = `${worst.file}: ${worst.check.note}`;
            }
          }
          notes.push(note);
          if (judgment.choice === expected) matches += 1;
        }

        const numericScores = scores.filter((s): s is number => typeof s === 'number');
        const minScore = numericScores.length > 0 ? Math.min(...numericScores) : null;
        const maxScore = numericScores.length > 0 ? Math.max(...numericScores) : null;
        const hasNotes = notes.some((n) => n !== null);

        modeSummaries[execMode] = {
          mode: execMode,
          model: modeModel,
          enforced,
          passed: modeErrors.length === 0 && matches === effectiveRepeats,
          matches,
          repeats: effectiveRepeats,
          choices,
          scores,
          ...(hasNotes ? { notes } : {}),
          min_score: minScore,
          max_score: maxScore,
          errors: modeErrors,
        };
      }

      const enforcedModes = Object.values(modeSummaries).filter((m): m is ModeEvaluationSummary => Boolean(m && m.enforced));
      const checkPassed = allErrors.length === 0 && enforcedModes.every((m) => m.passed);

      return {
        check_id: checkId,
        rubric_slug: rubricSlug,
        declared_scope: declaredScope,
        expected,
        passed: checkPassed,
        pass_threshold: threshold,
        ...(modeSummaries.file ? { file: modeSummaries.file } : {}),
        ...(modeSummaries.module ? { module: modeSummaries.module } : {}),
        ...(modeSummaries.structure ? { structure: modeSummaries.structure } : {}),
      };
    });

    const status: FixtureEvaluationSummary['status'] = allErrors.length > 0
      ? 'error'
      : dryRun
        ? 'dry_run'
        : checks.every((c) => c.passed)
          ? 'passed'
          : 'failed';

    return {
      id: fixture.id,
      description: fixture.description,
      target: resolved.target,
      file_count: Object.keys(fixture.files).length,
      rubric: resolved.rubric,
      status,
      elapsed_ms: elapsedMs,
      models: fixtureModels,
      checks,
      errors: allErrors,
    };
  });

  const fixturesPassed = fixtureSummaries.filter((f) => f.status === 'passed' || f.status === 'dry_run').length;
  const allChecks = fixtureSummaries.flatMap((f) => f.checks);
  const checksPassed = allChecks.filter((c) => c.passed).length;
  const anyFailure = fixtureSummaries.some((f) => f.status === 'failed' || f.status === 'error');
  const criteriaMatrix = buildScopeSignalMatrix(fixtureSummaries, dryRun);

  return {
    status: dryRun ? (anyFailure ? 'failed' : 'dry_run') : anyFailure ? 'failed' : 'passed',
    backend,
    modes,
    models,
    repeats: effectiveRepeats,
    dry_run: dryRun,
    elapsed_ms: Math.round(performance.now() - startMs),
    fixtures_total: fixtureSummaries.length,
    fixtures_passed: fixturesPassed,
    checks_total: allChecks.length,
    checks_passed: checksPassed,
    fixtures: fixtureSummaries,
    criteria_matrix: criteriaMatrix,
  };
}

function formatScoreVal(value: number): string {
  const rounded = Number(value.toFixed(1));
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

function formatScoreBounds(min: number | null, max: number | null): string {
  if (min === null || max === null) return '-';
  const lo = formatScoreVal(min);
  const hi = formatScoreVal(max);
  return lo === hi ? lo : `${lo}..${hi}`;
}

function formatModeCell(summary: ModeEvaluationSummary | undefined, dryRun: boolean): string {
  if (!summary) return '-';
  if (dryRun) return summary.errors.length === 0 ? 'ok' : 'err';
  const verdict = summary.passed ? 'ok' : `${summary.matches}/${summary.repeats}`;
  const score = formatScoreBounds(summary.min_score, summary.max_score);
  const suffix = summary.enforced ? '' : ' (info)';
  return `${verdict} ${score}${suffix}`;
}

function formatSignalCell(stats: ModeSignalStats, dryRun: boolean): string {
  if (dryRun) return `dry-run (G:${stats.pass_fixtures_total} B:${stats.fail_fixtures_total})`;
  if (stats.signal === null) return `incomplete (G:${stats.pass_fixtures_total} B:${stats.fail_fixtures_total})`;
  const label = stats.signal ? 'yes' : 'no';
  const gRange = formatScoreBounds(stats.good_min_score, stats.good_max_score);
  const bRange = formatScoreBounds(stats.bad_min_score, stats.bad_max_score);
  if (gRange === '-' && bRange === '-') return label;
  return `${label} (G:${gRange} B:${bRange})`;
}

function formatTable(headers: string[], rows: string[][]): string[] {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const formatRow = (cols: string[]) => cols.map((c, i) => c.padEnd(widths[i])).join('  ');
  return [
    formatRow(headers),
    widths.map((w) => '-'.repeat(w)).join('  '),
    ...rows.map(formatRow),
  ];
}

export function formatReportTable(report: RubricHarnessReport): string {
  const lines: string[] = [];
  const modeLabel = report.dry_run
    ? `DRY RUN, modes=${report.modes}`
    : `${report.backend} (modes=${report.modes}, repeats=${report.repeats}, file=${report.models.file}, module=${report.models.module})`;
  lines.push(`Rubric fixture tests [${modeLabel}]`);

  const prodFixtures = report.fixtures.filter((f) => f.target === 'production_code');
  const testFixtures = report.fixtures.filter((f) => f.target === 'test_code');
  const structFixtures = report.fixtures.filter((f) => f.target === 'project_structure');

  const appendDualModeTable = (heading: string | null, subset: FixtureEvaluationSummary[]) => {
    if (subset.length === 0) return;
    lines.push('');
    if (heading) lines.push(heading);
    const headers = ['Fixture', 'Files', 'Scope', 'Check', 'Expect', 'File (Score)', 'Module (Score)', 'Thr', 'Status'];
    const rows: string[][] = [];
    for (const fixture of subset) {
      for (const check of fixture.checks) {
        const thr = check.pass_threshold !== null ? `>=${formatThreshold(check.pass_threshold)}` : '-';
        const status = report.dry_run
          ? (fixture.status === 'dry_run' ? 'OK' : 'ERROR')
          : fixture.status === 'error'
            ? 'ERROR'
            : check.passed
              ? 'PASS'
              : 'FAIL';
        rows.push([
          fixture.id,
          String(fixture.file_count),
          check.declared_scope,
          check.check_id,
          check.expected,
          formatModeCell(check.file, report.dry_run),
          formatModeCell(check.module, report.dry_run),
          thr,
          status,
        ]);
      }
    }
    lines.push(...formatTable(headers, rows));
  };

  appendDualModeTable(null, prodFixtures);
  appendDualModeTable('Test Code Fixtures:', testFixtures);

  if (structFixtures.length > 0) {
    lines.push('');
    lines.push('Project Structure Fixtures:');
    const headers = ['Fixture', 'Files', 'Check', 'Expect', 'Structure (Score)', 'Thr', 'Status'];
    const rows: string[][] = [];
    for (const fixture of structFixtures) {
      for (const check of fixture.checks) {
        const thr = check.pass_threshold !== null ? `>=${formatThreshold(check.pass_threshold)}` : '-';
        const status = report.dry_run
          ? (fixture.status === 'dry_run' ? 'OK' : 'ERROR')
          : fixture.status === 'error'
            ? 'ERROR'
            : check.passed
              ? 'PASS'
              : 'FAIL';
        rows.push([
          fixture.id,
          String(fixture.file_count),
          check.check_id,
          check.expected,
          formatModeCell(check.structure, report.dry_run),
          thr,
          status,
        ]);
      }
    }
    lines.push(...formatTable(headers, rows));
  }

  if (report.criteria_matrix.length > 0) {
    lines.push('');
    lines.push('Scope Signal Matrix:');
    const headers = ['Criterion', 'Rubric', 'Declared', 'File Signal', 'Module Signal', 'Classification'];
    const rows = report.criteria_matrix.map((row) => [
      row.check_id,
      row.rubric_slug,
      row.declared_scope,
      formatSignalCell(row.file, report.dry_run),
      formatSignalCell(row.module, report.dry_run),
      row.promote_hint ? `${row.classification} (promote?)` : row.classification,
    ]);
    lines.push(...formatTable(headers, rows));
  }

  const errored = report.fixtures.filter((f) => f.errors.length > 0);
  if (errored.length > 0) {
    lines.push('');
    lines.push('Errors:');
    for (const fixture of errored) {
      for (const err of fixture.errors) {
        lines.push(`  - ${fixture.id}: ${err}`);
      }
    }
  }

  const failedChecks = report.fixtures.flatMap((f) =>
    f.checks.filter((c) => !c.passed).map((c) => ({ fixture: f, check: c })),
  );
  if (!report.dry_run && failedChecks.length > 0) {
    lines.push('');
    lines.push('Mismatches:');
    for (const { fixture, check } of failedChecks) {
      const modeList = [check.file, check.module, check.structure].filter(
        (m): m is ModeEvaluationSummary => Boolean(m && m.enforced && !m.passed),
      );
      for (const m of modeList) {
        const perRepeat = m.choices.map((ch, idx) => {
          const s = m.scores[idx];
          return s !== null ? `${ch}(${formatScoreVal(s)}/100)` : ch;
        }).join(', ');
        lines.push(`  - ${fixture.id} [${m.mode}] :: ${check.check_id}: expected ${check.expected}, got [${perRepeat}]`);
      }
    }
  }

  lines.push('');
  const secs = (report.elapsed_ms / 1000).toFixed(1);
  if (report.dry_run) {
    lines.push(
      `Dry-run validated ${report.fixtures_passed}/${report.fixtures_total} fixtures `
      + `(${report.checks_total} expected checks, ${report.criteria_matrix.length} dual-mode criteria) in ${secs}s.`,
    );
  } else {
    lines.push(
      `Summary: ${report.fixtures_passed}/${report.fixtures_total} fixtures passed `
      + `(${report.checks_passed}/${report.checks_total} checks) across ${report.repeats} repeat(s) in ${secs}s.`,
    );
  }

  return lines.join('\n');
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      repeats: { type: 'string' },
      fixture: { type: 'string', multiple: true },
      rubric: { type: 'string', multiple: true },
      rule: { type: 'string', multiple: true },
      modes: { type: 'string' },
      backend: { type: 'string' },
      model: { type: 'string' },
      'file-model': { type: 'string' },
      'module-model': { type: 'string' },
      concurrency: { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });

  if (values.help) {
    console.log(USAGE);
    return;
  }

  const repeats = values.repeats !== undefined ? parsePositiveInt(values.repeats, '--repeats') : DEFAULT_REPEATS;
  const concurrency = values.concurrency !== undefined
    ? parsePositiveInt(values.concurrency, '--concurrency')
    : undefined;
  const backend = parseBackend(values.backend);
  const modes = parseModes(values.modes);

  const report = await runRubricHarness({
    repeats,
    fixtureFilter: values.fixture,
    rubricFilter: values.rubric,
    ruleFilter: values.rule,
    modes,
    backend,
    model: values.model,
    fileModel: values['file-model'],
    moduleModel: values['module-model'],
    concurrency,
    dryRun: values['dry-run'],
  });

  if (values.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(formatReportTable(report));
  }

  if (report.status === 'failed') {
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    const key = process.env.OPENROUTER_API_KEY?.trim();
    const message = error instanceof Error ? error.message : String(error);
    console.error(key ? message.replaceAll(key, '[redacted]') : message);
    process.exitCode = 1;
  });
}
