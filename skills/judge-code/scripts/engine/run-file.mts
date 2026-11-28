import { basename } from 'node:path';
import { isPlaywrightConfigFilename } from '../inputs/classify-path.mts';
import {
  previewTestFileRubric,
  routeTestRubrics,
  type PlaywrightDetectionContext,
} from '../rubrics/classifier.mts';
import { filterRubricForFiles } from '../rubrics/applicability.mts';
import type { ResolvedRubric } from '../rubrics/types.mts';
import {
  createPrivateOutDir,
  createSubdirAllocator,
  saveResultIfDir,
  serializeRequest,
  type ArtifactDirRef,
} from './artifacts.mts';
import {
  buildJudgeResultEnvelope,
  elapsedSince,
  emptyResolvedRubric,
  finalizeBatchResult,
  makeNonScoredEntry,
  resolvePartitionRubrics,
  runDryOrScoredEntry,
  type PartitionRubrics,
} from './run-shared.mts';
import { numbered, runWithConcurrency } from './scoring.mts';
import type {
  CodeRequest,
  FileJudgment,
  JudgeResult,
  JudgeRunOptions,
  JudgeRunnerContext,
} from './types.mts';

interface FileWorkItem {
  file: string;
  content: string;
  partition: 'production' | 'test';
}

interface FileRunEnv {
  options: JudgeRunOptions;
  partitions: PartitionRubrics;
  ctx: JudgeRunnerContext;
}

interface ResolvedFileRouting {
  rubric: ResolvedRubric;
  fileRole?: string;
  useTestPayload: boolean;
  retries: number;
}

interface FileEvalOutcome {
  entry: FileJudgment;
  questionIds: string[];
  retries: number;
}

function buildFileDetectionContext(item: FileWorkItem, options: JudgeRunOptions): PlaywrightDetectionContext {
  return {
    absPath: options.filePaths?.[item.file],
    repoRoot: options.repoRoot,
    bundleFiles: options.testFiles ?? options.files,
    filePaths: options.filePaths,
  };
}

async function resolveTestFileRouting(item: FileWorkItem, env: FileRunEnv): Promise<ResolvedFileRouting> {
  const { options, partitions, ctx } = env;
  if (!partitions.testRubric) {
    return { rubric: emptyResolvedRubric(partitions.candidateRubric), useTestPayload: true, retries: 0 };
  }
  const detectionContext = buildFileDetectionContext(item, options);
  if (options.explicitTestSelection) {
    if (isPlaywrightConfigFilename(basename(item.file)) && partitions.testRubric.playwrightConfigRubric) {
      return {
        rubric: partitions.testRubric.playwrightConfigRubric,
        fileRole: 'test_support_playwright',
        useTestPayload: true,
        retries: 0,
      };
    }
    return {
      rubric: filterRubricForFiles(partitions.testRubric, { [item.file]: item.content }, detectionContext),
      fileRole: 'test',
      useTestPayload: true,
      retries: 0,
    };
  }
  if (options.dryRun) {
    const preview = previewTestFileRubric(
      { filePath: item.file, content: item.content },
      partitions.testRubric,
      detectionContext,
    );
    return { rubric: preview.rubric, fileRole: preview.fileRole, useTestPayload: true, retries: 0 };
  }
  if (!ctx.classifyTest) {
    throw new Error('Test classifier is required for automatic test-file linting');
  }
  const classification = await ctx.classifyTest(item.file, item.content, detectionContext);
  return {
    rubric: routeTestRubrics(classification, partitions.testRubric),
    fileRole: classification.fileRole,
    useTestPayload: true,
    retries: classification.retries,
  };
}

async function resolveFileRubricAndRole(item: FileWorkItem, env: FileRunEnv): Promise<ResolvedFileRouting> {
  const { options, partitions } = env;
  const singleFileMap = { [item.file]: item.content };
  if (!partitions.isUnified) {
    if (isPlaywrightConfigFilename(basename(item.file)) && options.rubric.playwrightConfigRubric) {
      return {
        rubric: options.rubric.playwrightConfigRubric,
        fileRole: 'test_support_playwright',
        useTestPayload: true,
        retries: 0,
      };
    }
    const detectionContext = buildFileDetectionContext(item, options);
    return {
      rubric: filterRubricForFiles(options.rubric, singleFileMap, detectionContext),
      useTestPayload: options.rubric.target === 'test_code',
      retries: 0,
    };
  }
  if (item.partition === 'production') {
    return {
      rubric: partitions.prodRubric
        ? filterRubricForFiles(partitions.prodRubric, singleFileMap)
        : emptyResolvedRubric(partitions.candidateRubric),
      useTestPayload: false,
      retries: 0,
    };
  }
  return resolveTestFileRouting(item, env);
}

function buildFileRequest(item: FileWorkItem, routing: ResolvedFileRouting, env: FileRunEnv): CodeRequest {
  const { options, partitions, ctx } = env;
  const hasProductionContext = !partitions.isUnified
    && options.productionContext !== undefined
    && Object.keys(options.productionContext).length > 0;

  return {
    model: options.model ?? `${ctx.backend}-default`,
    state: {
      ...(options.requirements !== undefined ? { requirement: options.requirements } : {}),
      ...(options.conventions !== undefined ? { conventions: options.conventions } : {}),
      ...(routing.useTestPayload
        ? {
          test_files: numbered({ [item.file]: item.content }),
          ...(hasProductionContext ? { production_files_context: numbered(options.productionContext!) } : {}),
        }
        : { production_files: numbered({ [item.file]: item.content }) }),
    },
    questions: routing.rubric.questions,
  };
}

async function evaluateFileItem(
  item: FileWorkItem,
  env: FileRunEnv,
  allocateDir: () => ArtifactDirRef,
): Promise<FileEvalOutcome> {
  const fileStart = performance.now();
  let routing: ResolvedFileRouting;
  try {
    routing = await resolveFileRubricAndRole(item, env);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Test classification failed';
    return {
      entry: makeNonScoredEntry({ file: item.file, file_role: 'test' }, 'error', fileStart, { error: message }),
      questionIds: [],
      retries: 0,
    };
  }

  const questionIds = Object.keys(routing.rubric.questions);
  if (questionIds.length === 0) {
    return {
      entry: makeNonScoredEntry(
        { file: item.file, ...(routing.fileRole ? { file_role: routing.fileRole } : {}) },
        'skipped',
        fileStart,
        { skip_reason: 'not_applicable' },
      ),
      questionIds: [],
      retries: routing.retries,
    };
  }

  const artifactDir = allocateDir();
  const baseFields = {
    file: item.file,
    ...(routing.fileRole ? { file_role: routing.fileRole } : {}),
    ...(artifactDir.relDir !== undefined ? { result_dir: artifactDir.relDir } : {}),
  };
  const request = buildFileRequest(item, routing, env);
  const body = serializeRequest(request, artifactDir.absDir);
  const scored = await runDryOrScoredEntry({
    baseFields,
    dryRun: Boolean(env.options.dryRun),
    startMs: fileStart,
    score: async () => {
      const judged = await env.ctx.scoreRequest(request, body, artifactDir.absDir);
      return { returnedModel: judged.model, checks: judged.checks, retries: judged.retries ?? 0 };
    },
  });
  saveResultIfDir(artifactDir.absDir, scored.entry);
  return { entry: scored.entry, questionIds, retries: routing.retries + scored.retries };
}

function collectWorkItems(options: JudgeRunOptions, isUnified: boolean): FileWorkItem[] {
  const prodFiles = options.files ?? {};
  const testFiles = isUnified ? (options.testFiles ?? {}) : {};
  return [
    ...Object.entries(prodFiles).map(([file, content]) => ({ file, content, partition: 'production' as const })),
    ...Object.entries(testFiles).map(([file, content]) => ({ file, content, partition: 'test' as const })),
  ].sort((a, b) => a.file.localeCompare(b.file));
}

export async function runPerFileJudge(
  options: JudgeRunOptions,
  ctx: JudgeRunnerContext,
): Promise<JudgeResult> {
  const partitions = resolvePartitionRubrics(options);
  const workItems = collectWorkItems(options, partitions.isUnified);
  const out = createPrivateOutDir(options.out);

  if (workItems.length === 0) {
    if (!options.allowEmpty) throw new Error('No files to score');
    const emptyResult: JudgeResult = {
      ...buildJudgeResultEnvelope({
        mode: 'file',
        status: options.dryRun ? 'dry_run' : 'scored',
        fileCount: 0,
        elapsedMs: 0,
        retries: 0,
        returnedModel: null,
        effectiveRubric: partitions.candidateRubric,
        skippedNotApplicable: [],
        includeSkippedModuleChecks: true,
        options,
        ctx,
        quality: options.dryRun ? null : { pass_rate: 1, all_files_pass_rate: 1, checks: {} },
      }),
      file_results: [],
    };
    saveResultIfDir(out, emptyResult);
    return emptyResult;
  }

  const startMs = performance.now();
  const allocateFileDir = createSubdirAllocator(out, 'files', workItems.length);
  const env: FileRunEnv = { options, partitions, ctx };
  const outcomes = await runWithConcurrency(workItems, options.concurrency ?? ctx.defaultConcurrency, (item, index) => (
    evaluateFileItem(item, env, () => allocateFileDir(index, item.file))
  ));

  const { baseResult, entries } = finalizeBatchResult({
    outcomes,
    candidateRubric: partitions.candidateRubric,
    mode: 'file',
    fileCount: workItems.length,
    elapsedMs: elapsedSince(startMs),
    includeSkippedModuleChecks: true,
    noun: 'file',
    entryLabel: (entry) => entry.file,
    options,
    ctx,
  });

  const result: JudgeResult = { ...baseResult, file_results: entries };
  saveResultIfDir(out, result);
  return result;
}
