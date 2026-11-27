#!/usr/bin/env node
import { lstatSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { CLAUDE_MODEL, CODEX_MODEL, runCliJudge } from './cli-backend.mts';
import {
  findRepoRoot,
  resolveConventionsPath,
  resolveGitChangedFiles,
} from './repo.mts';
import {
  DEFAULT_CLI_CONCURRENCY,
  DEFAULT_DECISION_MODEL,
  DEFAULT_FILE_MODE_DECISION_MODEL,
  DEFAULT_OPENROUTER_CONCURRENCY,
  countResultFindings,
  runDecisionJudge,
  type JudgeBackend,
  type JudgeResult,
  type JudgeRunOptions,
  type ModuleInput,
} from './decisions.mts';
import { formatLinterOutput, formatRubricList, formatRuleExplanations } from './format.mts';
import { readInputs, readPerFileInputs, resolveOutputOutsideSource } from './inputs.mts';
import { bundledRubrics, explainRules, resolveRubrics, type JudgeMode } from './rubrics.mts';
import { readStructureInputs } from './structure.mts';

export const EXIT_OK = 0;
export const EXIT_FINDINGS = 1;
export const EXIT_ERROR = 2;

export type Subcommand = 'file' | 'module' | 'structure' | 'list' | 'explain';

export interface ExitCodeOptions {
  failOnWarning?: boolean;
  maxWarnings?: number;
}

const USAGE = `Usage:
  judge-code <path...> [options]              Lint files/directories (file-scoped checks, fast model)
  judge-code --changed [base-ref] [options]   Lint git-modified/untracked files (default base: main or HEAD)
  judge-code module <path...> [options]       Lint module bundle(s) with file + module checks (deep model)
  judge-code structure <path> [options]       Lint directory layout via structural manifest (deep model)
  judge-code list [--verbose]                 List bundled rubrics, check IDs, scopes, and thresholds
  judge-code explain <check-id...> [options]  Show full criteria (instructions, pass, fail) for check ID(s)

Options:
  --deep                Use ${DEFAULT_DECISION_MODEL} instead of ${DEFAULT_FILE_MODE_DECISION_MODEL} (openrouter only)
  --model ID            Explicit OpenRouter Decisions model ID (openrouter only)
  --backend BACKEND     Judge backend: openrouter (default), codex (${CODEX_MODEL}), or claude (${CLAUDE_MODEL})
  --quiet, -q           Show errors only; hide borderline warnings
  --verbose, -v         Include full rule instructions and pass/fail criteria in \`judge-code list\`
  --json                Emit structured JSON result to stdout instead of formatted linter output
  --out NEW_DIRECTORY   Optional private directory for request.json, response.txt, and result.json artifacts
  --rubric NAME_OR_PATH Narrow to bundled rubric name/ID or load local .json rubric (repeatable)
  --rule CHECK_ID       Narrow to specific check ID(s) (repeatable)
  --exclude CHECK_ID    Exclude a specific check ID (repeatable)
  --ignore GLOB         Exclude matching paths or basenames (repeatable)
  --conventions FILE    Explicit Markdown/text conventions doc (overrides auto-loaded AGENTS.md)
  --no-conventions      Disable auto-loaded AGENTS.md conventions
  --requirements FILE   Optional Markdown or text requirements document
  --changed [REF]       Lint git-modified/untracked files vs. REF (default: main, fallback: HEAD)
  --max-warnings N      Exit with status ${EXIT_FINDINGS} if warning count exceeds N (non-negative integer)
  --fail-on-warning     Exit with status ${EXIT_FINDINGS} if any warning is found (same as --max-warnings 0)
  --concurrency N       Max concurrent requests (default: ${DEFAULT_OPENROUTER_CONCURRENCY} openrouter, ${DEFAULT_CLI_CONCURRENCY} codex/claude)
  --allow-credentials   Allow inputs matching heuristic credential patterns after review
  --dry-run             Preview resolved files/checks without sending any requests
  --list-rubrics        Alias for \`judge-code list\`
  --help, -h            Show this help

Severity & exit codes:
  error    Score < 60/100 (or CLI backend fail)
  warning  Score 60 up to the rule's pass threshold (default 80/100, or CLI backend borderline)

  ${EXIT_OK}  Clean (0 errors, and warnings within --max-warnings / no --fail-on-warning)
  ${EXIT_FINDINGS}  Findings (1+ errors, or warning limit exceeded)
  ${EXIT_ERROR}  Error (scoring/transport/backend error, invalid CLI arguments, or oversize input)
`;

function parseBackend(value: string | undefined): JudgeBackend {
  if (value === undefined || value === 'openrouter') return 'openrouter';
  if (value === 'codex' || value === 'claude') return value;
  throw new Error(`Invalid --backend: ${value}. Choose openrouter, codex, or claude.`);
}

function parseConcurrency(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(parsed)) {
    throw new Error(`Invalid --concurrency: ${value}. Expected a positive integer.`);
  }
  return parsed;
}

function parseMaxWarnings(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!/^(?:0|[1-9]\d*)$/.test(value) || !Number.isSafeInteger(parsed)) {
    throw new Error(`Invalid --max-warnings: ${value}. Expected a non-negative integer.`);
  }
  return parsed;
}

function resolveModel(
  backend: JudgeBackend,
  mode: JudgeMode,
  modelArg: string | undefined,
  deep: boolean,
): string | undefined {
  if (deep && modelArg !== undefined) {
    throw new Error('Cannot combine --deep and --model');
  }
  if (backend !== 'openrouter') {
    if (modelArg !== undefined) {
      throw new Error(`--model is only supported with --backend openrouter (codex uses ${CODEX_MODEL}, claude uses ${CLAUDE_MODEL})`);
    }
    if (deep) {
      throw new Error(`--deep is only supported with --backend openrouter (codex uses ${CODEX_MODEL}, claude uses ${CLAUDE_MODEL})`);
    }
    return undefined;
  }
  const defaultModel = mode === 'file' && !deep
    ? DEFAULT_FILE_MODE_DECISION_MODEL
    : DEFAULT_DECISION_MODEL;
  const model = modelArg ?? defaultModel;
  if (!/^[a-z0-9_.-]+\/[a-z0-9_.:-]+$/i.test(model)) {
    throw new Error('Use a full OpenRouter model ID for --model (for example liquid/d1.2-ultra)');
  }
  return model;
}

function hasScoringError(result: JudgeResult): boolean {
  if (result.status === 'error') return true;
  if (result.file_results?.some((entry) => entry.status === 'error')) return true;
  if (result.module_results?.some((entry) => entry.status === 'error')) return true;
  return false;
}

/**
 * Resolve standard linter exit code from a JudgeResult:
 * - 2 on scoring/transport/backend error
 * - 1 on 1+ errors, or warnings exceeding --fail-on-warning / --max-warnings
 * - 0 otherwise
 */
export function exitCodeForResult(result: JudgeResult, options: ExitCodeOptions = {}): number {
  if (hasScoringError(result)) return EXIT_ERROR;
  if (result.status !== 'scored') return EXIT_OK;
  const { errors, warnings } = countResultFindings(result);
  if (errors > 0) return EXIT_FINDINGS;
  if (options.failOnWarning && warnings > 0) return EXIT_FINDINGS;
  if (options.maxWarnings !== undefined && warnings > options.maxWarnings) return EXIT_FINDINGS;
  return EXIT_OK;
}

function extractSubcommandAndChanged(rawArgs: string[], cwd: string): {
  subcommand: Subcommand;
  restArgs: string[];
  changed: boolean;
  changedBase?: string;
} {
  let subcommand: Subcommand = 'file';
  let startIdx = 0;
  if (
    rawArgs[0] === 'list'
    || rawArgs[0] === 'explain'
    || rawArgs[0] === 'module'
    || rawArgs[0] === 'structure'
  ) {
    subcommand = rawArgs[0];
    startIdx = 1;
  }

  let changed = false;
  let changedBase: string | undefined;
  const restArgs: string[] = [];
  let afterDoubleDash = false;

  for (let i = startIdx; i < rawArgs.length; i += 1) {
    const arg = rawArgs[i];
    if (afterDoubleDash) {
      restArgs.push(arg);
      continue;
    }
    if (arg === '--') {
      afterDoubleDash = true;
      restArgs.push(arg);
      continue;
    }
    if (arg === '--changed') {
      changed = true;
      const next = rawArgs[i + 1];
      if (next !== undefined && !next.startsWith('-')) {
        // Treat next token as base-ref unless it is an existing path on disk.
        const maybePath = resolve(cwd, next);
        if (!lstatSync(maybePath, { throwIfNoEntry: false })) {
          changedBase = next;
          i += 1;
        }
      }
      continue;
    }
    if (arg.startsWith('--changed=')) {
      changed = true;
      const value = arg.slice('--changed='.length).trim();
      if (!value) throw new Error('Invalid --changed value: expected a non-empty git ref');
      changedBase = value;
      continue;
    }
    restArgs.push(arg);
  }

  return { subcommand, restArgs, changed, changedBase };
}

function displayTargetPath(absPath: string, cwd: string): string {
  const canonicalCwd = (() => {
    try {
      return realpathSync(cwd);
    } catch {
      return resolve(cwd);
    }
  })();
  const canonicalPath = (() => {
    try {
      return realpathSync(absPath);
    } catch {
      return resolve(absPath);
    }
  })();
  const rel = relative(canonicalCwd, canonicalPath);
  if (!rel) return '.';
  if (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel)) {
    return rel.split(sep).join('/');
  }
  return canonicalPath;
}

async function main(): Promise<void> {
  const cwd = process.cwd();
  const { subcommand, restArgs, changed, changedBase } = extractSubcommandAndChanged(process.argv.slice(2), cwd);

  const { values, positionals } = parseArgs({
    args: restArgs,
    allowPositionals: true,
    options: {
      deep: { type: 'boolean', default: false },
      model: { type: 'string' },
      backend: { type: 'string' },
      quiet: { type: 'boolean', short: 'q', default: false },
      verbose: { type: 'boolean', short: 'v', default: false },
      json: { type: 'boolean', default: false },
      out: { type: 'string' },
      rubric: { type: 'string', multiple: true },
      rule: { type: 'string', multiple: true },
      exclude: { type: 'string', multiple: true },
      ignore: { type: 'string', multiple: true },
      conventions: { type: 'string' },
      'no-conventions': { type: 'boolean', default: false },
      requirements: { type: 'string' },
      'max-warnings': { type: 'string' },
      'fail-on-warning': { type: 'boolean', default: false },
      concurrency: { type: 'string' },
      'allow-credentials': { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
      'list-rubrics': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });

  if (values.help) {
    console.log(USAGE);
    return;
  }
  if (changed && subcommand !== 'file') {
    throw new Error(`--changed is only supported for file linting (not \`judge-code ${subcommand}\`)`);
  }
  if (subcommand === 'list' || values['list-rubrics']) {
    if (subcommand === 'list' && positionals.length > 0) {
      throw new Error(`Unexpected arguments for \`judge-code list\`: ${positionals.join(' ')}`);
    }
    console.log(formatRubricList(bundledRubrics(), { verbose: values.verbose }));
    return;
  }
  if (subcommand === 'explain') {
    const rules = explainRules(positionals, values.rubric ?? []);
    console.log(formatRuleExplanations(rules));
    return;
  }

  const backend = parseBackend(values.backend);
  const concurrency = parseConcurrency(values.concurrency);
  const maxWarnings = parseMaxWarnings(values['max-warnings']);
  const failOnWarning = Boolean(values['fail-on-warning']);
  const cliIgnore = [...new Set(values.ignore ?? [])];

  if (values.out !== undefined && !values.out.trim()) {
    throw new Error('--out must be a non-empty directory path');
  }

  const resolvedMode: JudgeMode = subcommand === 'structure'
    ? 'structure'
    : subcommand === 'module'
      ? 'code'
      : 'file';

  const model = resolveModel(backend, resolvedMode, values.model, Boolean(values.deep));

  // Determine repo root for auto-discovering AGENTS.md.
  let changedFiles: string[] | undefined;
  let repoRoot: string;
  if (changed) {
    const gitChanged = resolveGitChangedFiles({
      cwd,
      baseRef: changedBase,
      pathFilters: positionals.length > 0 ? positionals : undefined,
    });
    repoRoot = gitChanged.repoRoot;
    changedFiles = gitChanged.files;
  } else {
    const probeTarget = positionals[0] ? resolve(cwd, positionals[0]) : cwd;
    repoRoot = findRepoRoot(probeTarget, cwd);
  }

  const conventionsInfo = resolveConventionsPath({
    cliConventions: values.conventions,
    noConventions: values['no-conventions'],
    repoRoot,
  });

  const rubric = resolveRubrics({
    mode: resolvedMode,
    rubrics: values.rubric ?? [],
    rules: values.rule,
    exclude: values.exclude,
    hasRequirements: values.requirements !== undefined,
    hasConventions: conventionsInfo.path !== undefined,
  });

  const conventionsLabel = conventionsInfo.path !== undefined
    ? `${displayTargetPath(conventionsInfo.path, cwd)} (${conventionsInfo.source})`
    : undefined;

  let runOptions: JudgeRunOptions;

  if (resolvedMode === 'structure') {
    if (positionals.length !== 1 || !positionals[0].trim()) {
      throw new Error(`Expected exactly one directory path for \`judge-code structure <path>\`\n\n${USAGE}`);
    }
    const targetPath = positionals[0];
    const inputs = readStructureInputs({
      source: targetPath,
      out: values.out,
      ignore: cliIgnore,
      requirements: values.requirements,
      conventions: conventionsInfo.path,
      allowCredentials: values['allow-credentials'],
    });
    runOptions = {
      mode: 'structure',
      target: displayTargetPath(resolve(cwd, targetPath), cwd),
      structure: inputs.manifest,
      ignore: cliIgnore,
      requirements: inputs.requirements,
      conventions: inputs.conventions,
      rubric,
      out: inputs.out,
      model,
      dryRun: values['dry-run'],
    };
  } else if (resolvedMode === 'code') {
    // Module subcommand requires explicit path(s).
    if (positionals.length === 0) {
      throw new Error(`Specify one or more paths for \`judge-code module <path...>\`\n\n${USAGE}`);
    }

    const useMultiModules = positionals.length > 1
      && positionals.every((p) => Boolean(lstatSync(resolve(cwd, p), { throwIfNoEntry: false })?.isDirectory()));

    if (useMultiModules) {
      const targetSpecs = positionals.map((p) => {
        const abs = resolve(cwd, p);
        return {
          name: displayTargetPath(abs, cwd),
          path: abs,
        };
      });

      const resolvedOut = values.out !== undefined ? resolve(values.out) : undefined;
      const loadedModules: ModuleInput[] = targetSpecs.map((spec) => {
        if (resolvedOut !== undefined) {
          const st = lstatSync(spec.path, { throwIfNoEntry: false });
          if (st?.isDirectory()) {
            resolveOutputOutsideSource(realpathSync(spec.path), true, resolvedOut);
          }
        }
        const loaded = readInputs({
          source: spec.path,
          ignore: cliIgnore,
          requirements: values.requirements,
          conventions: conventionsInfo.path,
          allowCredentials: values['allow-credentials'],
        });
        return {
          name: spec.name,
          files: loaded.files,
          requirements: loaded.requirements,
          conventions: loaded.conventions,
        };
      });

      runOptions = {
        mode: 'code',
        modules: loadedModules,
        ignore: cliIgnore,
        rubric,
        out: resolvedOut,
        model,
        concurrency,
        dryRun: values['dry-run'],
      };
    } else {
      const singleTargetPaths = positionals.map((p) => resolve(cwd, p));
      const targetLabel = singleTargetPaths.length === 1
        ? displayTargetPath(singleTargetPaths[0], cwd)
        : singleTargetPaths.map((p) => displayTargetPath(p, cwd)).join(', ');
      const useDisplayBase = singleTargetPaths.length > 1;
      const inputs = readInputs({
        sources: singleTargetPaths,
        displayBaseDir: useDisplayBase ? cwd : undefined,
        out: values.out,
        ignore: cliIgnore,
        requirements: values.requirements,
        conventions: conventionsInfo.path,
        allowCredentials: values['allow-credentials'],
      });
      runOptions = {
        mode: 'code',
        target: targetLabel,
        files: inputs.files,
        ignore: cliIgnore,
        requirements: inputs.requirements,
        conventions: inputs.conventions,
        rubric,
        out: inputs.out,
        model,
        dryRun: values['dry-run'],
      };
    }
  } else {
    // Default file-by-file linter mode.
    if (!changed && positionals.length === 0) {
      throw new Error(USAGE);
    }
    const sources = changed ? changedFiles! : positionals.map((p) => resolve(cwd, p));
    const inputs = readPerFileInputs({
      sources,
      displayBaseDir: cwd,
      out: values.out,
      ignore: cliIgnore,
      requirements: values.requirements,
      conventions: conventionsInfo.path,
      allowCredentials: values['allow-credentials'],
      allowEmpty: changed,
    });
    runOptions = {
      mode: 'file',
      files: inputs.files,
      ignore: cliIgnore,
      requirements: inputs.requirements,
      conventions: inputs.conventions,
      rubric,
      out: inputs.out,
      model,
      concurrency,
      dryRun: values['dry-run'],
      allowEmpty: changed,
    };
  }

  const result = backend === 'openrouter'
    ? await runDecisionJudge(runOptions)
    : await runCliJudge(runOptions, backend);

  if (values.json) {
    console.log(JSON.stringify(result));
  } else {
    console.log(formatLinterOutput(result, {
      quiet: values.quiet,
      outDir: runOptions.out,
      conventionsLabel,
      rubric,
    }));
  }

  process.exitCode = exitCodeForResult(result, { failOnWarning, maxWarnings });
}

function isDirectCliRun(): boolean {
  if (!process.argv[1]) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return import.meta.url === pathToFileURL(process.argv[1]).href;
  }
}

if (isDirectCliRun()) {
  main().catch((error: unknown) => {
    const key = process.env.OPENROUTER_API_KEY?.trim();
    const message = error instanceof Error ? error.message : 'Judging failed';
    console.error(key ? message.replaceAll(key, '[redacted]') : message);
    process.exitCode = EXIT_ERROR;
  });
}
