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

export function formatThreshold(value: number): string {
  const fixed2 = value.toFixed(2);
  if (Math.abs(Number(fixed2) - value) < 1e-9) return fixed2;
  return String(Number(value.toFixed(4)));
}

function checkThreshold(result: JudgeResult, id: string, check?: Judgment): number | null {
  return check?.pass_threshold ?? result.check_thresholds?.[id] ?? result.pass_threshold;
}

function hasCustomThresholds(result: JudgeResult, checkEntries: Array<[string, Judgment]>): boolean {
  if (result.pass_threshold === null) return false;
  if (result.check_thresholds && Object.values(result.check_thresholds).some((t) => t !== result.pass_threshold)) {
    return true;
  }
  return checkEntries.some(([id, check]) => {
    const threshold = checkThreshold(result, id, check);
    return typeof threshold === 'number' && threshold !== result.pass_threshold;
  });
}

function formatProb(value: number | null | undefined, threshold?: number | null): string {
  if (typeof value !== 'number') return 'n/a';
  const rounded = value.toFixed(2);
  if (typeof threshold === 'number' && value < threshold && Number(rounded) >= threshold) {
    return (Math.floor(value * 1000) / 1000).toFixed(3);
  }
  return rounded;
}

interface FailureBreakdown {
  raw: number;
  threshold: number;
  borderline: number;
}

function isThresholdFail(check: Judgment): boolean {
  return check.choice === 'fail'
    && check.model_choice === 'pass'
    && typeof check.pass_probability === 'number';
}

function isBorderlineFail(check: Judgment): boolean {
  return check.choice === 'fail' && check.model_choice === 'borderline';
}

function isRawFail(check: Judgment): boolean {
  if (check.choice !== 'fail') return false;
  if (check.model_choice === 'fail') return true;
  if (check.model_choice === 'pass' || check.model_choice === 'borderline') return false;
  return typeof check.pass_probability === 'number' ? check.pass_probability < 0.5 : true;
}

function formatFailureBreakdown(counts: FailureBreakdown): string {
  const parts: string[] = [];
  if (counts.raw > 0) parts.push(`${counts.raw} raw FAIL`);
  if (counts.threshold > 0) parts.push(`${counts.threshold} threshold fail`);
  if (counts.borderline > 0) parts.push(`${counts.borderline} borderline`);
  return parts.join(', ');
}

function formatFailedCheckReason(check: Judgment, threshold: number | null, inline = false): string {
  if (typeof check.pass_probability === 'number') {
    const prob = formatProb(check.pass_probability, threshold);
    const thresholdCmp = typeof threshold === 'number' ? ` < ${formatThreshold(threshold)}` : '';
    if (isThresholdFail(check)) {
      return inline
        ? `threshold fail, raw PASS: P(pass)=${prob}${thresholdCmp}`
        : `threshold fail (raw PASS: P(pass)=${prob}${thresholdCmp})`;
    }
    return inline
      ? `raw FAIL: P(pass)=${prob}${thresholdCmp}`
      : `raw FAIL (P(pass)=${prob}${thresholdCmp})`;
  }
  const label = check.model_choice === 'borderline' ? 'borderline' : 'raw FAIL';
  if (inline) {
    return check.note ? `${label}: ${check.note}` : label;
  }
  return check.note ? `${label} — ${check.note}` : label;
}

function checkFailureBreakdownForFiles(
  id: string,
  check: Judgment,
  fileResults?: FileJudgment[],
): FailureBreakdown {
  if (fileResults && fileResults.length > 0) {
    const counts: FailureBreakdown = { raw: 0, threshold: 0, borderline: 0 };
    for (const entry of fileResults) {
      const fileCheck = entry.checks?.[id];
      if (!fileCheck || fileCheck.choice !== 'fail') continue;
      if (isThresholdFail(fileCheck)) counts.threshold += 1;
      else if (isBorderlineFail(fileCheck)) counts.borderline += 1;
      else if (isRawFail(fileCheck)) counts.raw += 1;
    }
    return counts;
  }
  return {
    raw: check.files_raw_failed ?? 0,
    threshold: check.files_threshold_failed ?? 0,
    borderline: 0,
  };
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
    const checkLabels = checks.map((id) => {
      const threshold = checkThreshold(result, id);
      if (typeof threshold === 'number' && result.pass_threshold !== null && threshold !== result.pass_threshold) {
        return `${id} (>=${formatThreshold(threshold)})`;
      }
      return id;
    });
    lines.push(`Checks (${checks.length}): ${checkLabels.join(', ')}`);
    if (result.skipped_module_checks?.length) {
      lines.push(`Skipped module checks (${result.skipped_module_checks.length}): ${result.skipped_module_checks.join(', ')}`);
    }
    if (result.ignored_patterns?.length) {
      lines.push(`Ignored patterns (${result.ignored_patterns.length}): ${result.ignored_patterns.join(', ')}`);
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
    const checkEntries = Object.entries(quality.checks);
    const totalDecisions = checkEntries.reduce((sum, [, check]) => sum + (check.files_total ?? result.file_count), 0);
    const passedDecisions = checkEntries.reduce((sum, [, check]) => sum + (check.files_passed ?? 0), 0);
    const checksPassingAllFiles = checkEntries.filter(([, check]) => check.choice === 'pass').length;
    const allFilesPassedRate = result.file_count > 0 ? passedFiles / result.file_count : 0;
    const allFilesCheckRate = quality.all_files_pass_rate
      ?? (checkEntries.length > 0 ? checksPassingAllFiles / checkEntries.length : 0);

    const perCheckBreakdowns = new Map<string, FailureBreakdown>();
    const totalBreakdown: FailureBreakdown = { raw: 0, threshold: 0, borderline: 0 };
    for (const [id, check] of checkEntries) {
      const breakdown = checkFailureBreakdownForFiles(id, check, result.file_results);
      perCheckBreakdowns.set(id, breakdown);
      totalBreakdown.raw += breakdown.raw;
      totalBreakdown.threshold += breakdown.threshold;
      totalBreakdown.borderline += breakdown.borderline;
    }
    const failedDecisions = totalDecisions - passedDecisions;

    lines.push(
      `Files: ${result.file_count} scored (${passedFiles}/${result.file_count} passed all checks, ${failingFiles.length} with failures) in ${formatElapsed(result.elapsed_ms)}${ratePart}${retryPart}`,
    );
    lines.push(
      `Metrics: passed decisions ${passedDecisions}/${totalDecisions} (${formatPct(quality.pass_rate)})`
      + ` | files passing all checks ${passedFiles}/${result.file_count} (${formatPct(allFilesPassedRate)})`
      + ` | checks passing on every file ${checksPassingAllFiles}/${checkEntries.length} (${formatPct(allFilesCheckRate)})`,
    );
    if (failedDecisions > 0) {
      const breakdownText = formatFailureBreakdown(totalBreakdown);
      const decisionWord = failedDecisions === 1 ? 'decision' : 'decisions';
      lines.push(
        `Failures: ${failedDecisions} failed ${decisionWord}${breakdownText ? ` (${breakdownText})` : ''}`,
      );
    }

    const maxIdLen = Math.max(...checkEntries.map(([id]) => id.length), 10);
    const showThresholds = hasCustomThresholds(result, checkEntries);
    lines.push('');
    lines.push('Checks:');
    for (const [id, check] of checkEntries) {
      const status = check.choice === 'pass' ? 'PASS' : 'FAIL';
      const ratio = `${check.files_passed ?? 0}/${check.files_total ?? result.file_count}`;
      const threshold = checkThreshold(result, id, check);
      const breakdown = perCheckBreakdowns.get(id)!;
      const metaParts: string[] = [];
      if (check.choice === 'fail') {
        const breakdownText = formatFailureBreakdown(breakdown);
        if (breakdownText) metaParts.push(breakdownText);
      }
      if ((showThresholds || (check.choice === 'fail' && breakdown.threshold > 0)) && typeof threshold === 'number') {
        metaParts.push(`threshold ${formatThreshold(threshold)}`);
      }
      const metaSuffix = metaParts.length > 0 ? ` (${metaParts.join('; ')})` : '';
      lines.push(`  ${status}  ${id.padEnd(maxIdLen)}  ${ratio.padStart(7)}  min P(pass)=${formatProb(check.min_pass_probability, threshold)}${metaSuffix}`);
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
          const threshold = checkThreshold(result, id, check);
          return `${id} [${formatFailedCheckReason(check, threshold, true)}]`;
        }).join(', ');
        lines.push(`  ${entry.file} (${failed.length} failed): ${detail}`);
      }
    }
  } else {
    const checkEntries = Object.entries(quality.checks);
    const passedChecks = checkEntries.filter(([, c]) => c.choice === 'pass').length;
    const maxIdLen = Math.max(...checkEntries.map(([id]) => id.length), 10);
    const showThresholds = hasCustomThresholds(result, checkEntries);
    const breakdown: FailureBreakdown = { raw: 0, threshold: 0, borderline: 0 };
    for (const [, check] of checkEntries) {
      if (check.choice !== 'fail') continue;
      if (isThresholdFail(check)) breakdown.threshold += 1;
      else if (isBorderlineFail(check)) breakdown.borderline += 1;
      else if (isRawFail(check)) breakdown.raw += 1;
    }
    const breakdownText = formatFailureBreakdown(breakdown);
    const failurePart = breakdownText ? ` — ${breakdownText}` : '';
    lines.push(`Files: ${result.file_count} | Checks passed: ${passedChecks}/${checkEntries.length} (${formatPct(quality.pass_rate)})${failurePart}`);
    lines.push('');
    lines.push('Checks:');
    for (const [id, check] of checkEntries) {
      const status = check.choice === 'pass' ? 'PASS' : 'FAIL';
      const threshold = checkThreshold(result, id, check);
      let detail: string;
      if (check.choice === 'fail') {
        detail = formatFailedCheckReason(check, threshold, false);
      } else if (typeof check.pass_probability === 'number') {
        const thresholdSuffix = showThresholds && typeof threshold === 'number'
          ? ` (threshold ${formatThreshold(threshold)})`
          : '';
        detail = `P(pass)=${formatProb(check.pass_probability, threshold)}${thresholdSuffix}`;
      } else {
        detail = `${check.model_choice ?? check.choice}${check.note ? ` — ${check.note}` : ''}`;
      }
      lines.push(`  ${status}  ${id.padEnd(maxIdLen)}  ${detail}`);
    }
  }

  lines.push('');
  lines.push(`Artifacts: ${join(outDir, 'result.json')}`);
  return lines.join('\n');
}
