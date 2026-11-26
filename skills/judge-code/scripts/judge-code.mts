#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { CLAUDE_MODEL, CODEX_MODEL, runCliJudge } from './cli-backend.mts';
import {
  DEFAULT_CLI_CONCURRENCY,
  DEFAULT_DECISION_MODEL,
  DEFAULT_FILE_MODE_DECISION_MODEL,
  DEFAULT_OPENROUTER_CONCURRENCY,
  runDecisionJudge,
  type JudgeBackend,
  type JudgeResult,
} from './decisions.mts';
import { formatSummary, formatThreshold } from './format.mts';
import { readInputs, readPerFileInputs } from './inputs.mts';
import { PASS_THRESHOLD, bundledRubrics, resolveRubrics, type JudgeMode } from './rubrics.mts';
import { readStructureInputs } from './structure.mts';

type OutputFormat = 'json' | 'summary';

export const EXIT_OK = 0;
export const EXIT_VIOLATION = 1;
export const EXIT_SCORING_ERROR = 2;

const USAGE = `Usage: node judge-code.mts --source FILE_OR_DIRECTORY --out NEW_DIRECTORY [options]

  --source PATH         Production Kotlin or TypeScript file or directory (required)
  --out NEW_DIRECTORY   New private output directory (required)
  --mode MODE           Scoring mode: code (default), file (per-file scan), or structure (directory manifest)
  --backend BACKEND     Judge backend: openrouter (default), codex (${CODEX_MODEL}), or claude (${CLAUDE_MODEL})
  --rubric NAME_OR_PATH Bundled rubric name/ID or local .json rubric (repeatable)
  --all                 Include all bundled rubrics for the selected mode
  --exclude CHECK_ID    Exclude a specific check ID (repeatable)
  --ignore GLOB         Exclude matching relative paths or basenames (repeatable; e.g. '*-test-support.*', 'legacy/**')
  --requirements FILE   Optional Markdown or text requirements document
  --conventions FILE    Optional Markdown or text repo conventions document
  --model ID            OpenRouter Decisions model ID (default: ${DEFAULT_DECISION_MODEL} for code/structure, ${DEFAULT_FILE_MODE_DECISION_MODEL} for file; openrouter only)
  --concurrency N       Max concurrent per-file requests in --mode file (default: ${DEFAULT_OPENROUTER_CONCURRENCY} openrouter, ${DEFAULT_CLI_CONCURRENCY} codex/claude)
  --format FORMAT       Output format: json (default) or summary
  --fail-on-violation   Exit with status ${EXIT_VIOLATION} when any scored check fails
  --dry-run             Save the exact request locally without sending anything
  --allow-credentials   Allow inputs that match heuristic credential patterns after review
  --list-rubrics        List bundled rubric names, versions, targets, check IDs, and scopes
  --help, -h            Show this help

Exit codes:
  ${EXIT_OK}  Success (or scored run without --fail-on-violation)
  ${EXIT_VIOLATION}  Scored check violation with --fail-on-violation (or invalid CLI arguments/inputs)
  ${EXIT_SCORING_ERROR}  Scoring, transport, or backend error (e.g. API HTTP error, invalid model, or errored files)

Select a production Kotlin or TypeScript module (or directory for --mode structure).
Read SKILL.md before live scoring.
`;

function parseMode(value: string | undefined): JudgeMode | undefined {
  if (value === undefined) return undefined;
  if (value === 'code' || value === 'file' || value === 'structure') return value;
  throw new Error(`Invalid --mode: ${value}. Choose code, file, or structure.`);
}

function parseBackend(value: string | undefined): JudgeBackend {
  if (value === undefined || value === 'openrouter') return 'openrouter';
  if (value === 'codex' || value === 'claude') return value;
  throw new Error(`Invalid --backend: ${value}. Choose openrouter, codex, or claude.`);
}

function parseFormat(value: string | undefined): OutputFormat {
  if (value === undefined || value === 'json') return 'json';
  if (value === 'summary') return 'summary';
  throw new Error(`Invalid --format: ${value}. Choose json or summary.`);
}

function parseConcurrency(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(parsed)) {
    throw new Error(`Invalid --concurrency: ${value}. Expected a positive integer.`);
  }
  return parsed;
}

function resolveModel(backend: JudgeBackend, mode: JudgeMode, modelArg: string | undefined): string | undefined {
  if (backend !== 'openrouter') {
    if (modelArg !== undefined) {
      throw new Error(`--model is only supported with --backend openrouter (codex uses ${CODEX_MODEL}, claude uses ${CLAUDE_MODEL})`);
    }
    return undefined;
  }
  const defaultModel = mode === 'file' ? DEFAULT_FILE_MODE_DECISION_MODEL : DEFAULT_DECISION_MODEL;
  const model = modelArg ?? defaultModel;
  if (!/^[a-z0-9_.-]+\/[a-z0-9_.:-]+$/i.test(model)) {
    throw new Error('Use a full OpenRouter model ID for --model (for example liquid/d1.2-ultra)');
  }
  return model;
}

function hasViolation(result: JudgeResult): boolean {
  if (result.status !== 'scored' || !result.quality) return false;
  return Object.values(result.quality.checks).some((check) => check.choice === 'fail');
}

function hasScoringError(result: JudgeResult): boolean {
  if (result.status === 'error') return true;
  return result.file_results?.some((entry) => entry.status === 'error') ?? false;
}

/**
 * Resolve CLI exit status from a JudgeResult:
 * - 2 on scoring/transport/backend error (even when --fail-on-violation is not set)
 * - 1 on scored rubric violations when --fail-on-violation is set
 * - 0 otherwise
 */
export function exitCodeForResult(result: JudgeResult, failOnViolation: boolean): number {
  if (hasScoringError(result)) return EXIT_SCORING_ERROR;
  if (failOnViolation && hasViolation(result)) return EXIT_VIOLATION;
  return EXIT_OK;
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: {
    source: { type: 'string' },
    out: { type: 'string' },
    mode: { type: 'string' },
    backend: { type: 'string' },
    rubric: { type: 'string', multiple: true },
    all: { type: 'boolean' },
    exclude: { type: 'string', multiple: true },
    ignore: { type: 'string', multiple: true },
    requirements: { type: 'string' },
    conventions: { type: 'string' },
    model: { type: 'string' },
    concurrency: { type: 'string' },
    format: { type: 'string' },
    'fail-on-violation': { type: 'boolean' },
    'dry-run': { type: 'boolean' },
    'allow-credentials': { type: 'boolean' },
    'list-rubrics': { type: 'boolean' },
    help: { type: 'boolean', short: 'h' },
  } });

  if (values.help) {
    console.log(USAGE);
    return;
  }
  if (values['list-rubrics']) {
    for (const rubric of bundledRubrics()) {
      const tag = rubric.target === 'project_structure' ? ' [structure]' : '';
      const checks = rubric.checks.map((id) => {
        const threshold = rubric.thresholds[id];
        const thresholdNote = threshold !== PASS_THRESHOLD ? `, >=${formatThreshold(threshold)}` : '';
        return `${id} [${rubric.scopes[id]}${thresholdNote}]`;
      }).join(', ');
      console.log(`${rubric.slug} (${rubric.id})${tag}: ${checks}`);
    }
    return;
  }
  if (!values.source?.trim() || !values.out?.trim()) {
    throw new Error(USAGE);
  }

  const mode = parseMode(values.mode);
  const backend = parseBackend(values.backend);
  const format = parseFormat(values.format);
  const concurrency = parseConcurrency(values.concurrency);

  const rubric = resolveRubrics({
    mode,
    rubrics: values.rubric ?? [],
    all: values.all,
    exclude: values.exclude,
    hasRequirements: values.requirements !== undefined,
    hasConventions: values.conventions !== undefined,
  });

  const resolvedMode: JudgeMode = rubric.target === 'project_structure'
    ? 'structure'
    : mode === 'file'
      ? 'file'
      : 'code';

  const model = resolveModel(backend, resolvedMode, values.model);

  const runOptions = resolvedMode === 'structure'
    ? (() => {
      const inputs = readStructureInputs({
        source: values.source!,
        out: values.out!,
        ignore: values.ignore,
        requirements: values.requirements,
        conventions: values.conventions,
        allowCredentials: values['allow-credentials'],
      });
      return {
        mode: resolvedMode,
        structure: inputs.manifest,
        ignore: values.ignore,
        requirements: inputs.requirements,
        conventions: inputs.conventions,
        rubric,
        out: inputs.out,
        model,
        dryRun: values['dry-run'],
      };
    })()
    : (() => {
      const reader = resolvedMode === 'file' ? readPerFileInputs : readInputs;
      const inputs = reader({
        source: values.source!,
        out: values.out!,
        ignore: values.ignore,
        requirements: values.requirements,
        conventions: values.conventions,
        allowCredentials: values['allow-credentials'],
      });
      return {
        mode: resolvedMode,
        files: inputs.files,
        ignore: values.ignore,
        requirements: inputs.requirements,
        conventions: inputs.conventions,
        rubric,
        out: inputs.out,
        model,
        concurrency,
        dryRun: values['dry-run'],
      };
    })();

  const result = backend === 'openrouter'
    ? await runDecisionJudge(runOptions)
    : await runCliJudge(runOptions, backend);

  if (format === 'summary') {
    console.log(formatSummary(result, runOptions.out));
  } else {
    console.log(JSON.stringify(result));
  }

  process.exitCode = exitCodeForResult(result, Boolean(values['fail-on-violation']));
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
    process.exitCode = EXIT_VIOLATION;
  });
}
