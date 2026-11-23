#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { CODE_JUDGE_RULES, runCodeJudge, type CodeRequest } from './code-judge.mts';
import { DEFAULT_DECISION_MODEL } from './decisions.mts';
import { saveFailedCheckEvidence } from './evidence.mts';
import { readInputs } from './inputs.mts';
import { bundledRubricIds, parseBundledRubrics } from './rubrics.mts';

const USAGE = `Usage: node judge-code.mts --source FILE_OR_DIRECTORY --requirements FILE --rubric ID --out NEW_DIRECTORY

  --rubric ID      Installed versioned rubric ID (repeat for additional facets)
  --list-rubrics   List the bundled rubric IDs
  --model ID       OpenRouter Decisions model (default: ${DEFAULT_DECISION_MODEL})
  --dry-run        Save the exact Decisions request locally without sending anything
  --no-evidence    Skip the structured follow-up for failed checks
  --help, -h       Show this help

Select a production Kotlin or TypeScript module. Read SKILL.md before live scoring.
`;

async function main(): Promise<void> {
  const { values } = parseArgs({ options: {
    source: { type: 'string' },
    requirements: { type: 'string' },
    rubric: { type: 'string', multiple: true },
    out: { type: 'string' },
    model: { type: 'string', default: DEFAULT_DECISION_MODEL },
    'dry-run': { type: 'boolean' },
    'no-evidence': { type: 'boolean' },
    'list-rubrics': { type: 'boolean' },
    help: { type: 'boolean', short: 'h' },
  } });
  if (values.help) {
    console.log(USAGE);
    return;
  }
  if (values['list-rubrics']) {
    console.log(bundledRubricIds().join('\n'));
    return;
  }
  if (!values.source?.trim() || !values.requirements?.trim() || !values.rubric?.length || !values.out?.trim()) {
    throw new Error(USAGE);
  }
  if (!/^[a-z0-9_.-]+\/[a-z0-9_.:-]+$/i.test(values.model)) throw new Error('Use a full OpenRouter model ID for --model');
  const rubric = parseBundledRubrics(values.rubric, CODE_JUDGE_RULES);
  const { files, requirements, out } = readInputs(values.source, values.requirements, values.out);
  const result = await runCodeJudge({
    taskName: 'standalone',
    requirements,
    files,
    rubric,
    out,
    model: values.model,
    dryRun: values['dry-run'],
  });
  if (result.status === 'scored' && !values['no-evidence']) {
    const decision: CodeRequest = JSON.parse(readFileSync(join(out, 'request.json'), 'utf8'));
    await saveFailedCheckEvidence(result, decision, out, fetch);
  }
  console.log(JSON.stringify(result));
  if (result.status === 'error') process.exitCode = 1;
}

main().catch((error: unknown) => {
  const key = process.env.OPENROUTER_API_KEY?.trim();
  const message = error instanceof Error ? error.message : 'Judging failed';
  console.error(key ? message.replaceAll(key, '[redacted]') : message);
  process.exitCode = 1;
});
