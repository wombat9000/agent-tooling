/** Adapt exported Harbor artifacts to the bundled production-code judge. */
import { readFileSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import {
  CODE_JUDGE_RULES,
  isProductionSource,
  runCodeJudge,
  type JudgeCodeResult,
  type JudgeScope,
} from '../../../skills/judge-code/scripts/code-judge.mts';
import { collectSourceFiles, parseRubric } from './judge_review.mts';

export type { FileJudgment, JudgeCodeResult, JudgeScope } from '../../../skills/judge-code/scripts/code-judge.mts';

export interface JudgeCodeOptions {
  task: string;
  sourceDir: string;
  model: string;
  out: string;
  scope?: JudgeScope;
  rewardPath?: string;
  dryRun?: boolean;
}

function readDeterministic(rewardPath?: string): Record<string, number> {
  if (!rewardPath || !statSync(rewardPath, { throwIfNoEntry: false })?.isFile()) return {};
  const parsed = JSON.parse(readFileSync(rewardPath, 'utf8'));
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? parsed as Record<string, number>
    : {};
}

export async function judgeCode(options: JudgeCodeOptions, transport: typeof fetch = fetch): Promise<JudgeCodeResult> {
  const task = resolve(options.task);
  const rubric = parseRubric(task, CODE_JUDGE_RULES);
  const sourcePath = resolve(options.sourceDir);
  const stat = statSync(sourcePath, { throwIfNoEntry: false });
  const files = stat?.isDirectory()
    ? collectSourceFiles(sourcePath, isProductionSource)
    : stat?.isFile() && isProductionSource(basename(sourcePath))
      ? { [basename(sourcePath)]: readFileSync(sourcePath, 'utf8') }
      : {};
  return runCodeJudge({
    taskName: basename(task),
    requirements: Object.keys(files).length ? readFileSync(join(task, 'instruction.md'), 'utf8') : '',
    files,
    rubric,
    model: options.model,
    out: options.out,
    scope: options.scope,
    deterministic: readDeterministic(options.rewardPath),
    dryRun: options.dryRun,
  }, transport);
}
