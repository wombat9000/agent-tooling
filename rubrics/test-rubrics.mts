#!/usr/bin/env node
/**
 * Fast rubric unit-test harness (`pnpm test:rubrics`).
 * Evaluates curated fixtures under rubrics/fixtures/ using judge-code's own scoring logic.
 */
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { CLAUDE_MODEL, CODEX_MODEL, runCliJudge } from '../skills/judge-code/scripts/cli-backend.mts';
import {
  DEFAULT_DECISION_MODEL,
  DEFAULT_FILE_MODE_DECISION_MODEL,
  runDecisionJudge,
  runWithConcurrency,
  type JudgeBackend,
  type JudgeResult,
} from '../skills/judge-code/scripts/decisions.mts';
import {
  PASS_THRESHOLD,
  nonempty,
  object,
  resolveRubrics,
  type ResolvedRubric,
  type RubricTarget,
} from '../skills/judge-code/scripts/rubrics.mts';
import { readStructureInputs, type StructureManifest } from '../skills/judge-code/scripts/structure.mts';

export const AUTHORITATIVE_RUBRICS_DIR = fileURLToPath(new URL('.', import.meta.url));
export const DEFAULT_FIXTURES_DIR = fileURLToPath(new URL('./fixtures', import.meta.url));
export const DEFAULT_REPEATS = 2;
const DEFAULT_OPENROUTER_CONCURRENCY = 8;
const DEFAULT_CLI_CONCURRENCY = 2;

const USAGE = `Usage: node rubrics/test-rubrics.mts [options]

Run curated good/bad code fixtures under rubrics/fixtures/ against authoritative rubrics/*.json.

  --repeats N          Number of live repeats per fixture (default: ${DEFAULT_REPEATS}; every repeat must pass)
  --fixture ID         Run only matching fixture ID(s) (repeatable)
  --rubric SLUG        Run only fixtures testing this rubric slug (repeatable)
  --backend BACKEND    Judge backend: openrouter (default), codex (${CODEX_MODEL}), or claude (${CLAUDE_MODEL})
  --model ID           OpenRouter model override (default: ${DEFAULT_FILE_MODE_DECISION_MODEL} for file, ${DEFAULT_DECISION_MODEL} for code/structure)
  --concurrency N      Max concurrent judge runs (default: ${DEFAULT_OPENROUTER_CONCURRENCY} openrouter, ${DEFAULT_CLI_CONCURRENCY} codex/claude)
  --dry-run            Validate all fixtures, rubric resolution, and request payloads offline (no API calls)
  --json               Print structured JSON report instead of a human-readable table
  --help, -h           Show this help
`;

export type FixtureMode = 'file' | 'code' | 'structure';
export type ExpectedChoice = 'pass' | 'fail';

export interface LoadedFixture {
  id: string;
  file: string;
  description: string;
  mode: FixtureMode;
  rootName?: string;
  rubrics: string[];
  allRubrics: boolean;
  exclude: string[];
  files: Record<string, string>;
  requirements?: string;
  conventions?: string;
  expect: Record<string, ExpectedChoice>;
}

export interface CheckEvaluationSummary {
  check_id: string;
  expected: ExpectedChoice;
  passed: boolean;
  matches: number;
  repeats: number;
  choices: Array<ExpectedChoice | 'error'>;
  pass_probabilities: Array<number | null>;
  min_pass_probability: number | null;
  max_pass_probability: number | null;
  pass_threshold: number | null;
}

export interface FixtureEvaluationSummary {
  id: string;
  description: string;
  mode: FixtureMode;
  model: string;
  rubric: string;
  status: 'passed' | 'failed' | 'dry_run' | 'error';
  elapsed_ms: number;
  checks: CheckEvaluationSummary[];
  errors: string[];
}

export interface RubricHarnessReport {
  status: 'passed' | 'failed' | 'dry_run';
  backend: JudgeBackend;
  repeats: number;
  dry_run: boolean;
  elapsed_ms: number;
  fixtures_total: number;
  fixtures_passed: number;
  checks_total: number;
  checks_passed: number;
  fixtures: FixtureEvaluationSummary[];
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
  const files = readdirSync(fixturesDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));
  if (files.length === 0) {
    throw new Error(`No *.json fixture files found in ${fixturesDir}`);
  }

  const seenIds = new Set<string>();
  const fixtures: LoadedFixture[] = [];

  for (const file of files) {
    const label = `fixture ${file}`;
    const raw = object(JSON.parse(readFileSync(join(fixturesDir, file), 'utf8')), label);
    const id = nonempty(raw.id, `${label}.id`);
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)) {
      throw new Error(`${label}: id "${id}" must be lowercase kebab-case`);
    }
    if (seenIds.has(id)) {
      throw new Error(`Duplicate fixture id: ${id}`);
    }
    seenIds.add(id);

    const description = nonempty(raw.description, `${label}.description`);
    const mode = raw.mode;
    if (mode !== 'file' && mode !== 'code' && mode !== 'structure') {
      throw new Error(`${label}: mode must be "file", "code", or "structure" (got ${String(mode)})`);
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

    const rawFiles = object(raw.files, `${label}.files`);
    const fileEntries = Object.entries(rawFiles);
    if (fileEntries.length === 0) {
      throw new Error(`${label}.files must contain at least one file`);
    }
    const normalizedFiles: Record<string, string> = {};
    for (const [fileName, content] of fileEntries) {
      const cleanName = nonempty(fileName, `${label}.files key`);
      if (mode === 'structure') {
        const segments = cleanName.split('/');
        if (
          cleanName.startsWith('/')
          || cleanName.includes('\\')
          || cleanName.includes('\0')
          || segments.some((seg) => seg === '' || seg === '.' || seg === '..')
        ) {
          throw new Error(`${label}.files key "${cleanName}" must be a safe relative POSIX path in structure mode`);
        }
      }
      normalizedFiles[cleanName] = normalizeTextBlock(content, `${label}.files[${cleanName}]`);
    }

    const requirements = raw.requirements !== undefined
      ? normalizeTextBlock(raw.requirements, `${label}.requirements`)
      : undefined;
    const conventions = raw.conventions !== undefined
      ? normalizeTextBlock(raw.conventions, `${label}.conventions`)
      : undefined;

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
      file,
      description,
      mode,
      ...(rootName !== undefined ? { rootName } : {}),
      rubrics,
      allRubrics,
      exclude,
      files: normalizedFiles,
      ...(requirements !== undefined ? { requirements } : {}),
      ...(conventions !== undefined ? { conventions } : {}),
      expect,
    });
  }

  return fixtures;
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

export function resolveFixtureRubric(
  fixture: LoadedFixture,
  rubricsDir: string = AUTHORITATIVE_RUBRICS_DIR,
): ResolvedRubric {
  const slugs = new Set<string>();
  const expectedTarget: RubricTarget = fixture.mode === 'structure' ? 'project_structure' : 'production_code';
  if (fixture.allRubrics) {
    for (const slug of listAuthoritativeRubricsForTarget(rubricsDir, expectedTarget)) slugs.add(slug);
  }
  for (const slug of fixture.rubrics) slugs.add(slug);

  const rubricPaths = [...slugs].sort((a, b) => a.localeCompare(b)).map((slug) => {
    const fullPath = join(rubricsDir, `${slug}.json`);
    if (!statSync(fullPath, { throwIfNoEntry: false })?.isFile()) {
      throw new Error(`Fixture ${fixture.id}: unknown authoritative rubric "${slug}" (${fullPath})`);
    }
    return fullPath;
  });

  const resolved = resolveRubrics({
    mode: fixture.mode,
    rubrics: rubricPaths,
    exclude: fixture.exclude,
    hasRequirements: fixture.requirements !== undefined,
    hasConventions: fixture.conventions !== undefined,
  });

  for (const checkId of Object.keys(fixture.expect)) {
    if (!(checkId in resolved.questions)) {
      const skippedNote = resolved.skippedModuleChecks.includes(checkId)
        ? ' (it is module-scoped and skipped in mode "file"; use mode "code")'
        : '';
      throw new Error(
        `Fixture ${fixture.id}: expected check "${checkId}" is not active in resolved rubric "${resolved.rubric}"${skippedNote}`,
      );
    }
  }

  return resolved;
}

function defaultModelFor(backend: JudgeBackend, mode: FixtureMode, override?: string): string {
  if (backend === 'codex') return CODEX_MODEL;
  if (backend === 'claude') return CLAUDE_MODEL;
  return override ?? (mode === 'file' ? DEFAULT_FILE_MODE_DECISION_MODEL : DEFAULT_DECISION_MODEL);
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

export interface RunHarnessOptions {
  fixturesDir?: string;
  rubricsDir?: string;
  fixtureFilter?: string[];
  rubricFilter?: string[];
  repeats?: number;
  backend?: JudgeBackend;
  model?: string;
  concurrency?: number;
  dryRun?: boolean;
  transport?: typeof fetch;
}

function buildStructureManifestForFixture(
  fixture: LoadedFixture,
  sourceContainerDir: string,
  outDir: string,
): StructureManifest {
  const rootDir = join(sourceContainerDir, fixture.rootName ?? fixture.id);
  mkdirSync(rootDir, { recursive: true });
  for (const [relPath, content] of Object.entries(fixture.files)) {
    const absPath = join(rootDir, ...relPath.split('/'));
    mkdirSync(dirname(absPath), { recursive: true });
    writeFileSync(absPath, content, 'utf8');
  }
  return readStructureInputs({ source: rootDir, out: outDir }).manifest;
}

export async function runRubricHarness(options: RunHarnessOptions = {}): Promise<RubricHarnessReport> {
  const startMs = performance.now();
  const fixturesDir = options.fixturesDir ?? DEFAULT_FIXTURES_DIR;
  const rubricsDir = options.rubricsDir ?? AUTHORITATIVE_RUBRICS_DIR;
  const backend = options.backend ?? 'openrouter';
  const dryRun = options.dryRun ?? false;
  const repeats = options.repeats ?? DEFAULT_REPEATS;
  const concurrency = options.concurrency ?? (backend === 'openrouter' ? DEFAULT_OPENROUTER_CONCURRENCY : DEFAULT_CLI_CONCURRENCY);

  if (backend !== 'openrouter' && options.model !== undefined) {
    throw new Error(`--model is only supported with --backend openrouter (codex uses ${CODEX_MODEL}, claude uses ${CLAUDE_MODEL})`);
  }
  if (options.model !== undefined && !/^[a-z0-9_.-]+\/[a-z0-9_.:-]+$/i.test(options.model)) {
    throw new Error('Use a full OpenRouter model ID for --model (for example liquid/d1.2-ultra)');
  }

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

  const resolvedPairs = allFixtures.map((fixture) => ({
    fixture,
    resolved: resolveFixtureRubric(fixture, rubricsDir),
  }));

  const selected = resolvedPairs.filter(({ fixture, resolved }) => {
    if (fixtureFilter.length > 0 && !fixtureFilter.includes(fixture.id)) return false;
    if (rubricFilter.length > 0) {
      const activeGroups = new Set(Object.keys(resolved.groups));
      const matchesRubric = rubricFilter.some((slug) => activeGroups.has(slug) || fixture.rubrics.includes(slug));
      if (!matchesRubric) return false;
    }
    return true;
  });

  if (selected.length === 0) {
    throw new Error('No fixtures matched the selected filters');
  }

  const effectiveRepeats = dryRun ? 1 : repeats;
  const scratchRoot = mkdtempSync(join(tmpdir(), 'test-rubrics-'));

  interface RunUnit {
    fixtureIndex: number;
    repeatIndex: number;
    fixture: LoadedFixture;
    resolved: ResolvedRubric;
    model: string;
  }

  const units: RunUnit[] = [];
  for (let fixtureIndex = 0; fixtureIndex < selected.length; fixtureIndex += 1) {
    const { fixture, resolved } = selected[fixtureIndex];
    const model = defaultModelFor(backend, fixture.mode, options.model);
    for (let repeatIndex = 0; repeatIndex < effectiveRepeats; repeatIndex += 1) {
      units.push({ fixtureIndex, repeatIndex, fixture, resolved, model });
    }
  }

  interface UnitOutcome {
    fixtureIndex: number;
    repeatIndex: number;
    elapsedMs: number;
    result?: JudgeResult;
    error?: string;
  }

  let outcomes: UnitOutcome[];
  try {
    outcomes = await runWithConcurrency(units, concurrency, async (unit): Promise<UnitOutcome> => {
      const unitStart = performance.now();
      const outDir = join(scratchRoot, 'out', `${unit.fixture.id}--r${unit.repeatIndex + 1}`);
      try {
        const structure = unit.fixture.mode === 'structure'
          ? buildStructureManifestForFixture(
            unit.fixture,
            join(scratchRoot, 'sources', `${unit.fixture.id}--r${unit.repeatIndex + 1}`),
            outDir,
          )
          : undefined;
        const runOptions = {
          mode: unit.fixture.mode,
          ...(structure !== undefined ? { structure } : { files: unit.fixture.files }),
          requirements: unit.fixture.requirements,
          conventions: unit.fixture.conventions,
          rubric: unit.resolved,
          model: backend === 'openrouter' ? unit.model : undefined,
          out: outDir,
          dryRun,
        };
        const result = backend === 'openrouter'
          ? await runDecisionJudge(runOptions, options.transport)
          : await runCliJudge(runOptions, backend);
        return {
          fixtureIndex: unit.fixtureIndex,
          repeatIndex: unit.repeatIndex,
          elapsedMs: Math.round(performance.now() - unitStart),
          result,
        };
      } catch (error) {
        return {
          fixtureIndex: unit.fixtureIndex,
          repeatIndex: unit.repeatIndex,
          elapsedMs: Math.round(performance.now() - unitStart),
          error: error instanceof Error ? error.message : String(error),
        };
      }
    });
  } finally {
    rmSync(scratchRoot, { recursive: true, force: true });
  }

  const fixtureSummaries: FixtureEvaluationSummary[] = selected.map(({ fixture, resolved }, fixtureIndex) => {
    const model = defaultModelFor(backend, fixture.mode, options.model);
    const fixtureOutcomes = outcomes
      .filter((o) => o.fixtureIndex === fixtureIndex)
      .sort((a, b) => a.repeatIndex - b.repeatIndex);

    const elapsedMs = fixtureOutcomes.reduce((max, o) => Math.max(max, o.elapsedMs), 0);
    const errors: string[] = [];
    for (const outcome of fixtureOutcomes) {
      if (outcome.error) {
        errors.push(`repeat ${outcome.repeatIndex + 1}: ${outcome.error}`);
      } else if (outcome.result?.status === 'error') {
        errors.push(`repeat ${outcome.repeatIndex + 1}: ${outcome.result.error ?? 'judge error'}`);
      }
    }

    const checks: CheckEvaluationSummary[] = Object.entries(fixture.expect).map(([checkId, expected]) => {
      const threshold = backend === 'openrouter' ? (resolved.thresholds[checkId] ?? PASS_THRESHOLD) : null;
      if (dryRun) {
        return {
          check_id: checkId,
          expected,
          passed: errors.length === 0,
          matches: 0,
          repeats: 0,
          choices: [],
          pass_probabilities: [],
          min_pass_probability: null,
          max_pass_probability: null,
          pass_threshold: threshold,
        };
      }

      const choices: Array<ExpectedChoice | 'error'> = [];
      const probs: Array<number | null> = [];
      let matches = 0;

      for (const outcome of fixtureOutcomes) {
        const judgment = outcome.result?.status === 'scored' ? outcome.result.quality?.checks[checkId] : undefined;
        if (!judgment) {
          choices.push('error');
          probs.push(null);
          continue;
        }
        choices.push(judgment.choice);
        probs.push(judgment.pass_probability);
        if (judgment.choice === expected) matches += 1;
      }

      const numericProbs = probs.filter((p): p is number => typeof p === 'number');
      const minProb = numericProbs.length > 0 ? Math.min(...numericProbs) : null;
      const maxProb = numericProbs.length > 0 ? Math.max(...numericProbs) : null;

      return {
        check_id: checkId,
        expected,
        passed: errors.length === 0 && matches === effectiveRepeats,
        matches,
        repeats: effectiveRepeats,
        choices,
        pass_probabilities: probs,
        min_pass_probability: minProb,
        max_pass_probability: maxProb,
        pass_threshold: threshold,
      };
    });

    const status: FixtureEvaluationSummary['status'] = errors.length > 0
      ? 'error'
      : dryRun
        ? 'dry_run'
        : checks.every((c) => c.passed)
          ? 'passed'
          : 'failed';

    return {
      id: fixture.id,
      description: fixture.description,
      mode: fixture.mode,
      model,
      rubric: resolved.rubric,
      status,
      elapsed_ms: elapsedMs,
      checks,
      errors,
    };
  });

  const fixturesPassed = fixtureSummaries.filter((f) => f.status === 'passed' || f.status === 'dry_run').length;
  const allChecks = fixtureSummaries.flatMap((f) => f.checks);
  const checksPassed = allChecks.filter((c) => c.passed).length;
  const anyFailure = fixtureSummaries.some((f) => f.status === 'failed' || f.status === 'error');

  return {
    status: dryRun ? (anyFailure ? 'failed' : 'dry_run') : anyFailure ? 'failed' : 'passed',
    backend,
    repeats: effectiveRepeats,
    dry_run: dryRun,
    elapsed_ms: Math.round(performance.now() - startMs),
    fixtures_total: fixtureSummaries.length,
    fixtures_passed: fixturesPassed,
    checks_total: allChecks.length,
    checks_passed: checksPassed,
    fixtures: fixtureSummaries,
  };
}

function formatProbRange(check: CheckEvaluationSummary): string {
  if (check.min_pass_probability === null || check.max_pass_probability === null) return '-';
  const min = check.min_pass_probability.toFixed(2);
  const max = check.max_pass_probability.toFixed(2);
  return min === max ? min : `${min}..${max}`;
}

export function formatReportTable(report: RubricHarnessReport): string {
  const lines: string[] = [];
  const modeLabel = report.dry_run ? 'DRY RUN' : `${report.backend} (repeats=${report.repeats})`;
  lines.push(`Rubric fixture tests [${modeLabel}]`);
  lines.push('');

  const headers = ['Fixture', 'Mode', 'Check', 'Expect', 'Result', 'Pass Prob', 'Thr', 'Status'];
  const rows: string[][] = [];

  for (const fixture of report.fixtures) {
    for (const check of fixture.checks) {
      const actual = report.dry_run
        ? 'validated'
        : `${check.matches}/${check.repeats} ${check.expected}`;
      const thr = check.pass_threshold !== null ? `>=${check.pass_threshold.toFixed(2)}` : '-';
      const status = report.dry_run
        ? (fixture.status === 'dry_run' ? 'OK' : 'ERROR')
        : (check.passed ? 'PASS' : 'FAIL');
      rows.push([
        fixture.id,
        fixture.mode,
        check.check_id,
        check.expected,
        actual,
        formatProbRange(check),
        thr,
        status,
      ]);
    }
  }

  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const formatRow = (cols: string[]) => cols.map((c, i) => c.padEnd(widths[i])).join('  ');

  lines.push(formatRow(headers));
  lines.push(widths.map((w) => '-'.repeat(w)).join('  '));
  for (const row of rows) lines.push(formatRow(row));

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
      const perRepeat = check.choices.map((ch, idx) => {
        const p = check.pass_probabilities[idx];
        return p !== null ? `${ch}(${p.toFixed(3)})` : ch;
      }).join(', ');
      lines.push(`  - ${fixture.id} :: ${check.check_id}: expected ${check.expected}, got [${perRepeat}]`);
    }
  }

  lines.push('');
  const secs = (report.elapsed_ms / 1000).toFixed(1);
  if (report.dry_run) {
    lines.push(`Dry-run validated ${report.fixtures_passed}/${report.fixtures_total} fixtures (${report.checks_total} expected checks) in ${secs}s.`);
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
      backend: { type: 'string' },
      model: { type: 'string' },
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

  const report = await runRubricHarness({
    repeats,
    fixtureFilter: values.fixture,
    rubricFilter: values.rubric,
    backend,
    model: values.model,
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
