import { join } from 'node:path';
import { previewTestBundleRubric, routeTestBundleRubrics } from '../rubrics/classifier.mts';
import { filterRubricForFiles } from '../rubrics/applicability.mts';
import { CONVENTIONS_CHECK_ID, type ResolvedRubric } from '../rubrics/types.mts';
import {
  createPrivateOutDir,
  createSubdirAllocator,
  ensurePrivateDir,
  saveResultIfDir,
  serializeRequest,
  type ArtifactDirRef,
} from './artifacts.mts';
import { runPerFileJudge } from './run-file.mts';
import {
  buildJudgeResultEnvelope,
  elapsedSince,
  emptyResolvedRubric,
  finalizeBatchResult,
  fitsProductionContext,
  makeNonScoredEntry,
  narrowAndDiffRubric,
  resolvePartitionRubrics,
  runDryOrScoredEntry,
  withoutConventionsCheck,
  type PartitionRubrics,
} from './run-shared.mts';
import { numbered, passRate, runWithConcurrency } from './scoring.mts';
import type {
  CodeRequest,
  JudgeResult,
  JudgeRunOptions,
  JudgeRunnerContext,
  Judgment,
  ModuleInput,
  ModuleJudgment,
} from './types.mts';

interface ModuleEvalOutcome {
  entry: ModuleJudgment;
  questionIds: string[];
  retries: number;
}

interface ModuleRunEnv {
  options: JudgeRunOptions;
  partitions: PartitionRubrics;
  ctx: JudgeRunnerContext;
  concurrency: number;
}

interface ModulePassRequests {
  prodRequest?: CodeRequest;
  testRequest?: CodeRequest;
}

interface ModuleActiveRubrics {
  prod: ResolvedRubric;
  test: ResolvedRubric;
}

function buildSingleTargetState(options: JudgeRunOptions): CodeRequest['state'] {
  const isStructure = options.rubric.target === 'project_structure';
  const isTestCode = options.rubric.target === 'test_code';
  const hasProductionContext = options.productionContext !== undefined
    && Object.keys(options.productionContext).length > 0;

  return {
    ...(options.requirements !== undefined ? { requirement: options.requirements } : {}),
    ...(options.conventions !== undefined ? { conventions: options.conventions } : {}),
    ...(isStructure
      ? { project_structure: options.structure }
      : isTestCode
        ? {
          test_files: numbered(options.files!),
          ...(hasProductionContext ? { production_files_context: numbered(options.productionContext!) } : {}),
        }
        : { production_files: numbered(options.files!) }),
  };
}

export function prepareJudgeRun(
  options: JudgeRunOptions,
  backend: JudgeRunnerContext['backend'],
  passThreshold: number | null,
): { out?: string; request: CodeRequest; body: string; result: JudgeResult; rubric: ResolvedRubric } {
  const isStructure = options.rubric.target === 'project_structure';
  const fileCount = isStructure
    ? (options.structure?.total_files ?? 0)
    : Object.keys(options.files ?? {}).length;
  if (fileCount === 0) throw new Error('No files to score');

  const effectiveRubric = isStructure
    ? options.rubric
    : filterRubricForFiles(options.rubric, options.files ?? {});
  const skippedNotApplicable = Object.keys(options.rubric.questions).filter(
    (id) => !(id in effectiveRubric.questions),
  );
  const hasApplicableChecks = Object.keys(effectiveRubric.questions).length > 0;
  const out = createPrivateOutDir(options.out);

  const request: CodeRequest = {
    model: options.model ?? `${backend}-default`,
    state: buildSingleTargetState(options),
    questions: effectiveRubric.questions,
  };
  const body = hasApplicableChecks ? serializeRequest(request, out) : '';
  const result = buildJudgeResultEnvelope({
    mode: isStructure ? 'structure' : 'code',
    status: options.dryRun ? 'dry_run' : 'scored',
    target: options.target,
    fileCount,
    returnedModel: null,
    effectiveRubric,
    skippedNotApplicable,
    options,
    ctx: { backend, passThreshold },
    quality: !options.dryRun && !hasApplicableChecks ? { pass_rate: 1, checks: {} } : null,
  });
  return { out, request, body, result, rubric: effectiveRubric };
}

async function resolveModuleTestRubric(
  testFiles: Record<string, string>,
  hasProdConventions: boolean,
  env: ModuleRunEnv,
): Promise<{ rubric: ResolvedRubric; retries: number }> {
  const { options, partitions, ctx, concurrency } = env;
  if (Object.keys(testFiles).length === 0 || !partitions.testRubric) {
    return { rubric: emptyResolvedRubric(partitions.candidateRubric), retries: 0 };
  }
  let rubric: ResolvedRubric;
  let retries = 0;
  if (options.explicitTestSelection) {
    rubric = filterRubricForFiles(partitions.testRubric, testFiles);
  } else if (options.dryRun) {
    rubric = previewTestBundleRubric(testFiles, partitions.testRubric);
  } else {
    if (!ctx.classifyTest) throw new Error('Test classifier is required for automatic test-file module linting');
    const testEntries = Object.entries(testFiles).sort(([a], [b]) => a.localeCompare(b));
    const classifications = await runWithConcurrency(
      testEntries,
      concurrency,
      ([filePath, content]) => ctx.classifyTest!(filePath, content),
    );
    retries = classifications.reduce((sum, item) => sum + item.retries, 0);
    rubric = routeTestBundleRubrics(classifications, partitions.testRubric);
  }
  return { rubric: hasProdConventions ? withoutConventionsCheck(rubric) : rubric, retries };
}

function buildModulePassRequests(
  mod: ModuleInput,
  rubrics: ModuleActiveRubrics,
  env: ModuleRunEnv,
): ModulePassRequests {
  const testFiles = env.partitions.isUnified ? (mod.testFiles ?? {}) : {};
  const requirements = mod.requirements ?? env.options.requirements;
  const conventions = mod.conventions ?? env.options.conventions;
  const model = env.options.model ?? `${env.ctx.backend}-default`;
  const hasProdPass = Object.keys(rubrics.prod.questions).length > 0;
  const hasTestPass = Object.keys(rubrics.test.questions).length > 0;
  const sharedDocs = {
    ...(requirements !== undefined ? { requirement: requirements } : {}),
    ...(conventions !== undefined ? { conventions } : {}),
  };

  const prodRequest: CodeRequest | undefined = hasProdPass
    ? { model, state: { ...sharedDocs, production_files: numbered(mod.files) }, questions: rubrics.prod.questions }
    : undefined;
  const includeProdContext = hasTestPass && fitsProductionContext({
    testFiles, prodFiles: mod.files, requirements, conventions,
  });
  const testRequest: CodeRequest | undefined = hasTestPass
    ? {
      model,
      state: {
        ...sharedDocs,
        test_files: numbered(testFiles),
        ...(includeProdContext ? { production_files_context: numbered(mod.files) } : {}),
      },
      questions: rubrics.test.questions,
    }
    : undefined;
  return { prodRequest, testRequest };
}

async function scoreModulePassRequests(
  requests: ModulePassRequests,
  absDir: string | undefined,
  ctx: JudgeRunnerContext,
): Promise<{ returnedModel: string | null; checks: Record<string, Judgment>; retries: number }> {
  const hasProdPass = requests.prodRequest !== undefined;
  const tasks: Array<Promise<{ model: string; checks: Record<string, Judgment>; retries: number }>> = [];

  if (requests.prodRequest) {
    const body = serializeRequest(requests.prodRequest, absDir, 'request.json');
    tasks.push(ctx.scoreRequest(requests.prodRequest, body, absDir).then((judged) => ({
      model: judged.model, checks: judged.checks, retries: judged.retries ?? 0,
    })));
  }
  if (requests.testRequest) {
    const body = serializeRequest(requests.testRequest, absDir, hasProdPass ? 'test-request.json' : 'request.json');
    const testArtifactDir = absDir !== undefined && hasProdPass ? join(absDir, 'tests') : absDir;
    if (testArtifactDir !== absDir) ensurePrivateDir(testArtifactDir);
    tasks.push(ctx.scoreRequest(requests.testRequest, body, testArtifactDir).then((judged) => ({
      model: judged.model, checks: judged.checks, retries: judged.retries ?? 0,
    })));
  }

  const results = await Promise.all(tasks);
  const checks: Record<string, Judgment> = {};
  for (const res of results) Object.assign(checks, res.checks);
  return {
    returnedModel: [...new Set(results.map((res) => res.model))].join(', ') || null,
    checks,
    retries: results.reduce((sum, res) => sum + res.retries, 0),
  };
}

async function evaluateModuleBundle(
  mod: ModuleInput,
  env: ModuleRunEnv,
  artifactDir: ArtifactDirRef,
): Promise<ModuleEvalOutcome> {
  const modStart = performance.now();
  const testFiles = env.partitions.isUnified ? (mod.testFiles ?? {}) : {};
  const totalFileCount = Object.keys(mod.files).length + Object.keys(testFiles).length;
  const activeProdRubric = Object.keys(mod.files).length > 0 && env.partitions.prodRubric
    ? filterRubricForFiles(env.partitions.prodRubric, mod.files)
    : emptyResolvedRubric(env.partitions.candidateRubric);
  const baseFields = {
    module: mod.name,
    file_count: totalFileCount,
    ...(artifactDir.relDir !== undefined ? { result_dir: artifactDir.relDir } : {}),
  };

  let testResolution: { rubric: ResolvedRubric; retries: number };
  try {
    testResolution = await resolveModuleTestRubric(testFiles, CONVENTIONS_CHECK_ID in activeProdRubric.questions, env);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Test classification failed';
    return { entry: makeNonScoredEntry(baseFields, 'error', modStart, { error: message }), questionIds: [], retries: 0 };
  }

  const questionIds = [
    ...Object.keys(activeProdRubric.questions),
    ...Object.keys(testResolution.rubric.questions),
  ];
  if (questionIds.length === 0) {
    return {
      entry: makeNonScoredEntry({ module: mod.name, file_count: totalFileCount }, 'skipped', modStart, { skip_reason: 'not_applicable' }),
      questionIds: [],
      retries: testResolution.retries,
    };
  }

  ensurePrivateDir(artifactDir.absDir);
  const requests = buildModulePassRequests(mod, { prod: activeProdRubric, test: testResolution.rubric }, env);
  const scored = await runDryOrScoredEntry({
    baseFields,
    dryRun: Boolean(env.options.dryRun),
    startMs: modStart,
    onDryRun: () => {
      if (requests.prodRequest) serializeRequest(requests.prodRequest, artifactDir.absDir, 'request.json');
      if (requests.testRequest) {
        serializeRequest(requests.testRequest, artifactDir.absDir, requests.prodRequest ? 'test-request.json' : 'request.json');
      }
    },
    score: () => scoreModulePassRequests(requests, artifactDir.absDir, env.ctx),
  });
  saveResultIfDir(artifactDir.absDir, scored.entry);
  return { entry: scored.entry, questionIds, retries: testResolution.retries + scored.retries };
}

export async function runMultiModuleJudge(
  options: JudgeRunOptions,
  ctx: JudgeRunnerContext,
): Promise<JudgeResult> {
  const modules = options.modules ?? [];
  if (modules.length === 0) throw new Error('No modules to score');

  const partitions = resolvePartitionRubrics(options);
  const startMs = performance.now();
  const out = createPrivateOutDir(options.out);
  const allocateModuleDir = createSubdirAllocator(out, 'modules', modules.length);
  const concurrency = options.concurrency ?? ctx.defaultConcurrency;
  const env: ModuleRunEnv = { options, partitions, ctx, concurrency };

  const outcomes = await runWithConcurrency(modules, concurrency, (mod, index) => (
    evaluateModuleBundle(mod, env, out !== undefined ? allocateModuleDir(index, mod.name) : {})
  ));

  const { baseResult, entries } = finalizeBatchResult({
    outcomes,
    candidateRubric: partitions.candidateRubric,
    mode: 'code',
    fileCount: outcomes.reduce((sum, outcome) => sum + outcome.entry.file_count, 0),
    elapsedMs: elapsedSince(startMs),
    noun: 'module',
    entryLabel: (entry) => entry.module,
    options,
    ctx,
  });

  const result: JudgeResult = { ...baseResult, module_results: entries };
  saveResultIfDir(out, result);
  return result;
}

async function runSimpleSingleTarget(options: JudgeRunOptions, ctx: JudgeRunnerContext): Promise<JudgeResult> {
  const startMs = performance.now();
  const { out, request, body, result: prepared } = prepareJudgeRun(options, ctx.backend, ctx.passThreshold);
  let finalResult: JudgeResult = prepared;

  if (!options.dryRun && Object.keys(request.questions).length > 0) {
    try {
      const judged = await ctx.scoreRequest(request, body, out);
      finalResult = {
        ...prepared,
        ...(judged.retries && judged.retries > 0 ? { retries: judged.retries } : {}),
        returned_model: judged.model,
        quality: { pass_rate: passRate(judged.checks), checks: judged.checks },
      };
    } catch (error) {
      finalResult = {
        ...prepared,
        status: 'error',
        error: error instanceof Error ? error.message : 'Judging failed',
      };
    }
  }

  const withElapsed: JudgeResult = { ...finalResult, elapsed_ms: elapsedSince(startMs) };
  saveResultIfDir(out, withElapsed);
  return withElapsed;
}

export async function runSingleTargetJudge(
  options: JudgeRunOptions,
  ctx: JudgeRunnerContext,
): Promise<JudgeResult> {
  const partitions = resolvePartitionRubrics(options);
  if (options.rubric.target === 'project_structure' || !partitions.isUnified) {
    return runSimpleSingleTarget(options, ctx);
  }

  const prodFiles = options.files ?? {};
  const testFiles = options.testFiles ?? {};
  const totalFileCount = Object.keys(prodFiles).length + Object.keys(testFiles).length;
  if (totalFileCount === 0) throw new Error('No files to score');

  const startMs = performance.now();
  const out = createPrivateOutDir(options.out);
  const env: ModuleRunEnv = { options, partitions, ctx, concurrency: options.concurrency ?? ctx.defaultConcurrency };
  const outcome = await evaluateModuleBundle(
    { name: options.target ?? 'module', files: prodFiles, testFiles, requirements: options.requirements, conventions: options.conventions },
    env,
    { absDir: out },
  );

  const { effectiveRubric, skippedNotApplicable } = narrowAndDiffRubric(
    partitions.candidateRubric,
    new Set(outcome.questionIds),
  );
  const isError = outcome.entry.status === 'error';
  const result = buildJudgeResultEnvelope({
    mode: 'code',
    status: options.dryRun ? 'dry_run' : isError ? 'error' : 'scored',
    target: options.target,
    fileCount: totalFileCount,
    elapsedMs: elapsedSince(startMs),
    retries: outcome.retries,
    returnedModel: outcome.entry.returned_model,
    effectiveRubric,
    skippedNotApplicable,
    options,
    ctx,
    quality: options.dryRun || isError
      ? null
      : outcome.entry.checks
        ? { pass_rate: outcome.entry.pass_rate ?? passRate(outcome.entry.checks), checks: outcome.entry.checks }
        : { pass_rate: 1, checks: {} },
    error: isError ? outcome.entry.error : undefined,
  });

  saveResultIfDir(out, result);
  return result;
}

/** Single authoritative dispatcher across per-file, multi-module, and single-target judge runs. */
export async function dispatchJudgeRun(
  options: JudgeRunOptions,
  ctx: JudgeRunnerContext,
): Promise<JudgeResult> {
  if (options.mode === 'file') return runPerFileJudge(options, ctx);
  if (options.modules && options.modules.length > 0) return runMultiModuleJudge(options, ctx);
  return runSingleTargetJudge(options, ctx);
}
