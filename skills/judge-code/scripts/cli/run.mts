import { lstatSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { runCliJudge } from '../engine/cli-backend.mts';
import { runDecisionJudge } from '../engine/openrouter.mts';
import type { JudgeRunOptions, ModuleInput } from '../engine/types.mts';
import { readInputs, readPerFileInputs, resolveOutputOutsideSource } from '../inputs/files.mts';
import { canonicalizeOrFallback } from '../inputs/fs-read.mts';
import { findRepoRoot, resolveConventionsPath, resolveGitChangedFiles } from '../inputs/repo.mts';
import { readStructureInputs } from '../inputs/structure.mts';
import { bundledRubrics, explainRules } from '../rubrics/loader.mts';
import { resolveUnifiedRubrics } from '../rubrics/resolver.mts';
import type { JudgeMode, UnifiedResolvedRubrics } from '../rubrics/types.mts';
import { EXIT_OK, USAGE, parseCliCommand, type ParsedRunCommand } from './args.mts';
import { exitCodeForResult } from './exit-code.mts';
import { formatLinterOutput } from './format-report.mts';
import { formatRubricList, formatRuleExplanations } from './format-summary.mts';

interface ResolvedTargetContext {
  cwd: string;
  command: ParsedRunCommand;
  unified: UnifiedResolvedRubrics;
  conventionsPath?: string;
  changedFiles?: string[];
}

function displayTargetPath(absPath: string, cwd: string): string {
  const canonicalCwd = canonicalizeOrFallback(cwd);
  const canonicalPath = canonicalizeOrFallback(absPath);
  const rel = relative(canonicalCwd, canonicalPath);
  if (!rel) return '.';
  if (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel)) {
    return rel.split(sep).join('/');
  }
  return canonicalPath;
}

function buildStructureRunOptions(ctx: ResolvedTargetContext): JudgeRunOptions {
  const { command, cwd, unified, conventionsPath } = ctx;
  if (command.positionals.length !== 1 || !command.positionals[0].trim()) {
    throw new Error(`Expected exactly one directory path for \`judge-code structure <path>\`\n\n${USAGE}`);
  }
  const targetPath = command.positionals[0];
  const inputs = readStructureInputs({
    source: targetPath,
    out: command.out,
    ignore: command.ignore,
    requirements: command.requirements,
    conventions: conventionsPath,
    allowCredentials: command.allowCredentials,
  });
  return {
    mode: 'structure',
    target: displayTargetPath(resolve(cwd, targetPath), cwd),
    structure: inputs.manifest,
    ignore: command.ignore,
    requirements: inputs.requirements,
    conventions: inputs.conventions,
    rubric: unified.structure!,
    out: inputs.out,
    model: command.model,
    dryRun: command.dryRun,
  };
}

function buildMultiModuleRunOptions(
  ctx: ResolvedTargetContext,
  includeProduction: boolean,
  includeTests: boolean,
): JudgeRunOptions {
  const { command, cwd, unified, conventionsPath } = ctx;
  const resolvedOut = command.out !== undefined ? resolve(command.out) : undefined;
  const loadedModules: ModuleInput[] = command.positionals.map((rawPath) => {
    const abs = resolve(cwd, rawPath);
    if (resolvedOut !== undefined && lstatSync(abs, { throwIfNoEntry: false })?.isDirectory()) {
      resolveOutputOutsideSource(realpathSync(abs), true, resolvedOut);
    }
    const loaded = readInputs({
      source: abs,
      ignore: command.ignore,
      requirements: command.requirements,
      conventions: conventionsPath,
      allowCredentials: command.allowCredentials,
      includeProduction,
      includeTests,
    });
    return {
      name: displayTargetPath(abs, cwd),
      files: loaded.files,
      ...(includeTests ? { testFiles: loaded.testFiles ?? {} } : {}),
      requirements: loaded.requirements,
      conventions: loaded.conventions,
    };
  });

  return {
    mode: 'code',
    modules: loadedModules,
    ignore: command.ignore,
    rubric: unified.production ?? unified.test!,
    testRubric: unified.test,
    explicitTestSelection: unified.explicitTestSelection,
    out: resolvedOut,
    model: command.model,
    concurrency: command.concurrency,
    dryRun: command.dryRun,
  };
}

function buildModuleRunOptions(ctx: ResolvedTargetContext): JudgeRunOptions {
  const { command, cwd, unified, conventionsPath } = ctx;
  if (command.positionals.length === 0) {
    throw new Error(`Specify one or more paths for \`judge-code module <path...>\`\n\n${USAGE}`);
  }
  const includeProduction = unified.production !== undefined;
  const includeTests = unified.test !== undefined;
  const areAllDirectories = command.positionals.length > 1
    && command.positionals.every((p) => Boolean(lstatSync(resolve(cwd, p), { throwIfNoEntry: false })?.isDirectory()));
  if (areAllDirectories) {
    return buildMultiModuleRunOptions(ctx, includeProduction, includeTests);
  }

  const singleTargetPaths = command.positionals.map((p) => resolve(cwd, p));
  const targetLabel = singleTargetPaths.length === 1
    ? displayTargetPath(singleTargetPaths[0], cwd)
    : singleTargetPaths.map((p) => displayTargetPath(p, cwd)).join(', ');
  const inputs = readInputs({
    sources: singleTargetPaths,
    displayBaseDir: singleTargetPaths.length > 1 ? cwd : undefined,
    out: command.out,
    ignore: command.ignore,
    requirements: command.requirements,
    conventions: conventionsPath,
    allowCredentials: command.allowCredentials,
    includeProduction,
    includeTests,
  });

  return {
    mode: 'code',
    target: targetLabel,
    files: inputs.files,
    ...(includeTests ? { testFiles: inputs.testFiles ?? {} } : {}),
    ignore: command.ignore,
    requirements: inputs.requirements,
    conventions: inputs.conventions,
    rubric: unified.production ?? unified.test!,
    testRubric: unified.test,
    explicitTestSelection: unified.explicitTestSelection,
    out: inputs.out,
    model: command.model,
    concurrency: command.concurrency,
    dryRun: command.dryRun,
  };
}

function buildFileRunOptions(ctx: ResolvedTargetContext): JudgeRunOptions {
  const { command, cwd, unified, conventionsPath, changedFiles } = ctx;
  if (!command.changed && command.positionals.length === 0) {
    throw new Error(USAGE);
  }
  const includeProduction = unified.production !== undefined;
  const includeTests = unified.test !== undefined;
  const sources = command.changed ? changedFiles! : command.positionals.map((p) => resolve(cwd, p));
  const inputs = readPerFileInputs({
    sources,
    displayBaseDir: cwd,
    out: command.out,
    ignore: command.ignore,
    requirements: command.requirements,
    conventions: conventionsPath,
    allowCredentials: command.allowCredentials,
    allowEmpty: command.changed,
    includeProduction,
    includeTests,
  });

  return {
    mode: 'file',
    files: inputs.files,
    ...(includeTests ? { testFiles: inputs.testFiles ?? {} } : {}),
    ignore: command.ignore,
    requirements: inputs.requirements,
    conventions: inputs.conventions,
    rubric: unified.production ?? unified.test!,
    testRubric: unified.test,
    explicitTestSelection: unified.explicitTestSelection,
    out: inputs.out,
    model: command.model,
    concurrency: command.concurrency,
    dryRun: command.dryRun,
    allowEmpty: command.changed,
  };
}

const RUN_OPTION_BUILDERS: Record<JudgeMode, (ctx: ResolvedTargetContext) => JudgeRunOptions> = {
  structure: buildStructureRunOptions,
  code: buildModuleRunOptions,
  file: buildFileRunOptions,
};

function resolveRepoAndChangedFiles(command: ParsedRunCommand, cwd: string): {
  repoRoot: string;
  changedFiles?: string[];
} {
  if (command.changed) {
    const gitChanged = resolveGitChangedFiles({
      cwd,
      baseRef: command.changedBase,
      pathFilters: command.positionals.length > 0 ? command.positionals : undefined,
    });
    return { repoRoot: gitChanged.repoRoot, changedFiles: gitChanged.files };
  }
  const probeTarget = command.positionals[0] ? resolve(cwd, command.positionals[0]) : cwd;
  return { repoRoot: findRepoRoot(probeTarget, cwd) };
}

export async function runCli(rawArgs: string[], cwd: string = process.cwd()): Promise<number> {
  const command = parseCliCommand(rawArgs, cwd);
  if (command.kind === 'help') {
    console.log(USAGE);
    return EXIT_OK;
  }
  if (command.kind === 'list') {
    console.log(formatRubricList(bundledRubrics(), { verbose: command.verbose }));
    return EXIT_OK;
  }
  if (command.kind === 'explain') {
    console.log(formatRuleExplanations(explainRules(command.ruleIds, command.rubrics)));
    return EXIT_OK;
  }

  const { repoRoot, changedFiles } = resolveRepoAndChangedFiles(command, cwd);
  const conventionsInfo = resolveConventionsPath({
    cliConventions: command.conventions,
    noConventions: command.noConventions,
    repoRoot,
  });
  const unified = resolveUnifiedRubrics({
    mode: command.mode,
    rubrics: command.rubrics,
    rules: command.rules,
    exclude: command.exclude,
    hasRequirements: command.requirements !== undefined,
    hasConventions: conventionsInfo.path !== undefined,
  });

  const runOptions = RUN_OPTION_BUILDERS[command.mode]({
    cwd,
    command,
    unified,
    conventionsPath: conventionsInfo.path,
    changedFiles,
  });
  const result = command.backend === 'openrouter'
    ? await runDecisionJudge(runOptions)
    : await runCliJudge(runOptions, command.backend);

  const conventionsLabel = conventionsInfo.path !== undefined
    ? `${displayTargetPath(conventionsInfo.path, cwd)} (${conventionsInfo.source})`
    : undefined;

  if (command.json) {
    console.log(JSON.stringify(result));
  } else {
    console.log(formatLinterOutput(result, {
      quiet: command.quiet,
      outDir: runOptions.out,
      conventionsLabel,
      rubric: unified.combinedCriteria,
    }));
  }

  return exitCodeForResult(result, {
    failOnWarning: command.failOnWarning,
    maxWarnings: command.maxWarnings,
  });
}
