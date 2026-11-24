#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { CLAUDE_MODEL, CODEX_MODEL, runCliJudge } from './cli-backend.mts';
import {
  DEFAULT_CLI_CONCURRENCY,
  DEFAULT_DECISION_MODEL,
  DEFAULT_OPENROUTER_CONCURRENCY,
  runDecisionJudge,
  type JudgeBackend,
  type JudgeResult,
} from './decisions.mts';
import { formatSummary } from './format.mts';
import { readInputs, readPerFileInputs } from './inputs.mts';
import { bundledRubrics, resolveRubrics, type JudgeMode } from './rubrics.mts';
import { readStructureInputs } from './structure.mts';

type OutputFormat = 'json' | 'summary';

const USAGE = `Usage: node judge-code.mts --source FILE_OR_DIRECTORY --out NEW_DIRECTORY [options]

  --source PATH         Production Kotlin or TypeScript file or directory (required)
  --out NEW_DIRECTORY   New private output directory (required)
  --mode MODE           Scoring mode: code (default), file (per-file scan), or structure (directory manifest)
  --backend BACKEND     Judge backend: openrouter (default), codex (${CODEX_MODEL}), or claude (${CLAUDE_MODEL})
  --rubric NAME_OR_PATH Bundled rubric name/ID or local .json rubric (repeatable)
  --all                 Include all bundled rubrics for the selected mode
  --exclude CHECK_ID    Exclude a specific check ID (repeatable)
  --requirements FILE   Optional Markdown or text requirements document
  --conventions FILE    Optional Markdown or text repo conventions document
  --model ID            OpenRouter Decisions model ID (default: ${DEFAULT_DECISION_MODEL}; openrouter only)
  --concurrency N       Max concurrent per-file requests in --mode file (default: ${DEFAULT_OPENROUTER_CONCURRENCY} openrouter, ${DEFAULT_CLI_CONCURRENCY} codex/claude)
  --format FORMAT       Output format: json (default) or summary
  --fail-on-violation   Exit with status 1 when any check fails
  --dry-run             Save the exact request locally without sending anything
  --allow-credentials   Allow inputs that match heuristic credential patterns after review
  --list-rubrics        List bundled rubric names, versions, targets, check IDs, and scopes
  --help, -h            Show this help

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

function resolveModel(backend: JudgeBackend, modelArg: string | undefined): string | undefined {
  if (backend !== 'openrouter') {
    if (modelArg !== undefined) {
      throw new Error(`--model is only supported with --backend openrouter (codex uses ${CODEX_MODEL}, claude uses ${CLAUDE_MODEL})`);
    }
    return undefined;
  }
  const model = modelArg ?? DEFAULT_DECISION_MODEL;
  if (!/^[a-z0-9_.-]+\/[a-z0-9_.:-]+$/i.test(model)) {
    throw new Error('Use a full OpenRouter model ID for --model (for example liquid/d1.2-ultra)');
  }
  return model;
}

function hasViolation(result: JudgeResult): boolean {
  if (result.status !== 'scored' || !result.quality) return false;
  return Object.values(result.quality.checks).some((check) => check.choice === 'fail');
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
      const checks = rubric.checks.map((id) => `${id} [${rubric.scopes[id]}]`).join(', ');
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
  const model = resolveModel(backend, values.model);

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

  const runOptions = resolvedMode === 'structure'
    ? (() => {
      const inputs = readStructureInputs({
        source: values.source!,
        out: values.out!,
        requirements: values.requirements,
        conventions: values.conventions,
        allowCredentials: values['allow-credentials'],
      });
      return {
        mode: resolvedMode,
        structure: inputs.manifest,
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
        requirements: values.requirements,
        conventions: values.conventions,
        allowCredentials: values['allow-credentials'],
      });
      return {
        mode: resolvedMode,
        files: inputs.files,
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

  if (result.status === 'error' || (values['fail-on-violation'] && hasViolation(result))) {
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  const key = process.env.OPENROUTER_API_KEY?.trim();
  const message = error instanceof Error ? error.message : 'Judging failed';
  console.error(key ? message.replaceAll(key, '[redacted]') : message);
  process.exitCode = 1;
});
