import { join } from 'node:path';
import type { FileJudgment, JudgeResult, Judgment } from './decisions.mts';

function formatElapsed(ms: number | undefined): string {
  if (ms === undefined) return 'n/a';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function formatPct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function formatProb(value: number | null | undefined): string {
  if (typeof value !== 'number') return 'n/a';
  return value.toFixed(2);
}

function failedChecksForFile(entry: FileJudgment): Array<[string, Judgment]> {
  if (!entry.checks) return [];
  return Object.entries(entry.checks)
    .filter(([, check]) => check.choice === 'fail')
    .sort((a, b) => {
      const pa = a[1].pass_probability ?? 0;
      const pb = b[1].pass_probability ?? 0;
      if (pa !== pb) return pa - pb;
      return a[0].localeCompare(b[0]);
    });
}

function worstProbabilityForFile(entry: FileJudgment): number {
  const failed = failedChecksForFile(entry);
  const probs = failed
    .map(([, check]) => check.pass_probability)
    .filter((p): p is number => typeof p === 'number');
  return probs.length > 0 ? Math.min(...probs) : 0;
}

/** Render a concise test-suite-style report for `--format summary`. */
export function formatSummary(result: JudgeResult, outDir: string): string {
  const lines: string[] = [];
  const modelLabel = result.returned_model ?? result.requested_model ?? 'default';
  lines.push(`judge-code (${result.mode}) — ${result.rubric} [${result.backend}: ${modelLabel}]`);

  if (result.status === 'dry_run') {
    lines.push(`DRY RUN: ${result.file_count} file(s) prepared in ${formatElapsed(result.elapsed_ms)}`);
    const checks = Object.values(result.rubric_groups).flat();
    lines.push(`Checks (${checks.length}): ${checks.join(', ')}`);
    if (result.skipped_module_checks?.length) {
      lines.push(`Skipped module checks (${result.skipped_module_checks.length}): ${result.skipped_module_checks.join(', ')}`);
    }
    lines.push(`Artifacts: ${join(outDir, 'result.json')}`);
    return lines.join('\n');
  }

  if (result.status === 'error') {
    lines.push(`ERROR: ${result.error ?? 'Judging failed'}`);
    if (result.file_results) {
      const errored = result.file_results.filter((entry) => entry.status === 'error');
      const scored = result.file_results.filter((entry) => entry.status === 'scored');
      lines.push(`Files: ${scored.length} scored, ${errored.length} errored (${result.file_count} total) in ${formatElapsed(result.elapsed_ms)}`);
      for (const entry of errored) {
        lines.push(`  ERR   ${entry.file}: ${entry.error ?? 'failed'}`);
      }
    }
    lines.push(`Artifacts: ${join(outDir, 'result.json')}`);
    return lines.join('\n');
  }

  const quality = result.quality!;
  if (result.mode === 'file' && result.file_results) {
    const failingFiles = result.file_results
      .filter((entry) => failedChecksForFile(entry).length > 0)
      .sort((a, b) => {
        const countDiff = failedChecksForFile(b).length - failedChecksForFile(a).length;
        if (countDiff !== 0) return countDiff;
        const probDiff = worstProbabilityForFile(a) - worstProbabilityForFile(b);
        if (probDiff !== 0) return probDiff;
        return a.file.localeCompare(b.file);
      });
    const passedFiles = result.file_count - failingFiles.length;
    const ratePart = result.elapsed_ms && result.elapsed_ms > 0
      ? ` (${(result.file_count / (result.elapsed_ms / 1000)).toFixed(1)} files/s)`
      : '';
    const retryPart = result.retries ? `, ${result.retries} retries` : '';
    lines.push(
      `Files: ${result.file_count} scored (${passedFiles} passed, ${failingFiles.length} failed) in ${formatElapsed(result.elapsed_ms)}${ratePart}${retryPart}`,
    );
    lines.push(
      `Rates: mean file pass ${formatPct(quality.pass_rate)} | all-files check pass ${formatPct(quality.all_files_pass_rate ?? 0)}`,
    );

    const checkEntries = Object.entries(quality.checks);
    const maxIdLen = Math.max(...checkEntries.map(([id]) => id.length), 10);
    lines.push('');
    lines.push('Checks:');
    for (const [id, check] of checkEntries) {
      const status = check.choice === 'pass' ? 'PASS' : 'FAIL';
      const ratio = `${check.files_passed ?? 0}/${check.files_total ?? result.file_count}`;
      lines.push(`  ${status}  ${id.padEnd(maxIdLen)}  ${ratio.padStart(7)}  min P(pass)=${formatProb(check.min_pass_probability)}`);
    }

    if (result.skipped_module_checks?.length) {
      lines.push('');
      lines.push(`Skipped module checks (${result.skipped_module_checks.length}): ${result.skipped_module_checks.join(', ')}`);
    }

    if (failingFiles.length > 0) {
      lines.push('');
      lines.push(`Failing files (${failingFiles.length}):`);
      for (const entry of failingFiles) {
        const failed = failedChecksForFile(entry);
        const detail = failed.map(([id, check]) => {
          if (typeof check.pass_probability === 'number') return `${id} (${formatProb(check.pass_probability)})`;
          return check.note ? `${id} (${check.model_choice ?? 'fail'}: ${check.note})` : `${id} (${check.model_choice ?? 'fail'})`;
        }).join(', ');
        lines.push(`  ${entry.file} (${failed.length} failed): ${detail}`);
      }
    }
  } else {
    const checkEntries = Object.entries(quality.checks);
    const passedChecks = checkEntries.filter(([, c]) => c.choice === 'pass').length;
    const maxIdLen = Math.max(...checkEntries.map(([id]) => id.length), 10);
    lines.push(`Files: ${result.file_count} | Checks: ${passedChecks}/${checkEntries.length} passed (${formatPct(quality.pass_rate)})`);
    lines.push('');
    lines.push('Checks:');
    for (const [id, check] of checkEntries) {
      const status = check.choice === 'pass' ? 'PASS' : 'FAIL';
      const detail = typeof check.pass_probability === 'number'
        ? `P(pass)=${formatProb(check.pass_probability)}`
        : `${check.model_choice ?? check.choice}${check.note ? ` — ${check.note}` : ''}`;
      lines.push(`  ${status}  ${id.padEnd(maxIdLen)}  ${detail}`);
    }
  }

  lines.push('');
  lines.push(`Artifacts: ${join(outDir, 'result.json')}`);
  return lines.join('\n');
}
