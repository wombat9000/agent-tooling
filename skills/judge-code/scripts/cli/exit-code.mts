import { countResultFindings } from '../engine/scoring.mts';
import type { JudgeResult } from '../engine/types.mts';
import { EXIT_ERROR, EXIT_FINDINGS, EXIT_OK } from './args.mts';

export interface ExitCodeOptions {
  failOnWarning?: boolean;
  maxWarnings?: number;
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
