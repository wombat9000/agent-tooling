#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { DEFAULT_DECISION_MODEL, runDecisionJudge } from './decisions.mts';
import { readInputs } from './inputs.mts';
import { bundledRubrics, resolveRubrics } from './rubrics.mts';

const USAGE = `Usage: node judge-code.mts --source FILE_OR_DIRECTORY --out NEW_DIRECTORY [options]

  --source PATH         Production Kotlin or TypeScript file or directory (required)
  --out NEW_DIRECTORY   New private output directory (required)
  --rubric NAME_OR_PATH Bundled rubric name/ID or local .json rubric (repeatable)
  --all                 Include all bundled rubrics
  --exclude CHECK_ID    Exclude a specific check ID (repeatable)
  --requirements FILE   Optional Markdown or text requirements document
  --conventions FILE    Optional Markdown or text repo conventions document
  --model ID            OpenRouter Decisions model (default: ${DEFAULT_DECISION_MODEL})
  --dry-run             Save the exact Decisions request locally without sending anything
  --allow-credentials   Allow inputs that match heuristic credential patterns after review
  --list-rubrics        List bundled rubric names, versions, and check IDs
  --help, -h            Show this help

Select a production Kotlin or TypeScript module. Read SKILL.md before live scoring.
`;

async function main(): Promise<void> {
  const { values } = parseArgs({ options: {
    source: { type: 'string' },
    out: { type: 'string' },
    rubric: { type: 'string', multiple: true },
    all: { type: 'boolean' },
    exclude: { type: 'string', multiple: true },
    requirements: { type: 'string' },
    conventions: { type: 'string' },
    model: { type: 'string', default: DEFAULT_DECISION_MODEL },
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
      console.log(`${rubric.slug} (${rubric.id}): ${rubric.checks.join(', ')}`);
    }
    return;
  }
  if (!values.source?.trim() || !values.out?.trim()) {
    throw new Error(USAGE);
  }
  if (!/^[a-z0-9_.-]+\/[a-z0-9_.:-]+$/i.test(values.model)) {
    throw new Error('Use a full OpenRouter model ID for --model');
  }

  const rubric = resolveRubrics({
    rubrics: values.rubric ?? [],
    all: values.all,
    exclude: values.exclude,
    hasRequirements: values.requirements !== undefined,
    hasConventions: values.conventions !== undefined,
  });
  const inputs = readInputs({
    source: values.source,
    out: values.out,
    requirements: values.requirements,
    conventions: values.conventions,
    allowCredentials: values['allow-credentials'],
  });
  const result = await runDecisionJudge({
    files: inputs.files,
    requirements: inputs.requirements,
    conventions: inputs.conventions,
    rubric,
    out: inputs.out,
    model: values.model,
    dryRun: values['dry-run'],
  });

  console.log(JSON.stringify(result));
  if (result.status === 'error') process.exitCode = 1;
}

main().catch((error: unknown) => {
  const key = process.env.OPENROUTER_API_KEY?.trim();
  const message = error instanceof Error ? error.message : 'Judging failed';
  console.error(key ? message.replaceAll(key, '[redacted]') : message);
  process.exitCode = 1;
});
