/** Deterministic GitHub-previewable Markdown scorecard generator (evals/SCORECARD.md). */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  buildScorecardSnapshot,
  type EvaluatedEntryView,
  type ScorecardSnapshot,
  type SkillCoverageInfo,
  type TaskTargetRow,
} from './scorecard_discovery.mts';
import { compareCodepoint, type ScorecardCheckStats } from './scorecard_schema.mts';

function pct(value: number | null | undefined, decimals = 1): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  return `${(value * 100).toFixed(decimals)}%`;
}

function liftPp(delta: number | null | undefined): string {
  if (typeof delta !== 'number' || !Number.isFinite(delta)) return '—';
  const pp = delta * 100;
  const rounded = Math.abs(pp) < 0.05 ? 0 : pp;
  const sign = rounded > 0 ? '+' : '';
  return `${sign}${rounded.toFixed(1)}pp`;
}

function escapeMdCell(value: string): string {
  return value.replaceAll('|', '\\|').replaceAll('\n', ' ');
}

function formatStalenessLabel(view: EvaluatedEntryView): string {
  if (view.staleness.status === 'current') return 'Current';
  return `Stale (${view.staleness.reasons.join(', ')})`;
}

function formatRowStatus(row: TaskTargetRow): string {
  const skillStatus = row.skillEntry ? formatStalenessLabel(row.skillEntry) : null;
  const baseStatus = row.baseline ? formatStalenessLabel(row.baseline) : null;
  if (skillStatus && baseStatus) {
    if (skillStatus === baseStatus) return skillStatus;
    return `Skill: ${skillStatus}; Base: ${baseStatus}`;
  }
  return skillStatus ?? baseStatus ?? '—';
}

function formatDeterministicCell(row: TaskTargetRow): string {
  const skillDet = row.skillEntry?.entry.deterministic;
  const baseDet = row.baseline?.entry.deterministic;
  const fmt = (d: { passed: number; total: number } | null | undefined) => (d ? `${d.passed}/${d.total}` : null);
  const s = fmt(skillDet);
  const b = fmt(baseDet);
  if (s && b) return `${s} (base ${b})`;
  if (s) return s;
  if (b) return `base ${b}`;
  return '—';
}

function formatScoreCell(view: EvaluatedEntryView | null): string {
  if (!view) return '—';
  const { pass_rate, mean_pass_probability } = view.entry.quality;
  return `${pct(pass_rate)} (P=${pct(mean_pass_probability)})`;
}

function formatSampleCell(row: TaskTargetRow): string {
  const s = row.skillEntry?.entry.trials.scored;
  const b = row.baseline?.entry.trials.scored;
  if (s !== undefined && b !== undefined) {
    return s === b ? `${s}` : `${s} / base ${b}`;
  }
  return String(s ?? b ?? '—');
}

function formatModelsCell(row: TaskTargetRow): string {
  const primary = row.skillEntry ?? row.baseline;
  if (!primary) return '—';
  const agent = primary.entry.agent_model;
  const judge = primary.entry.judge_model;
  return `\`${agent}\` / \`${judge}\``;
}

function formatDateCell(row: TaskTargetRow): string {
  const s = row.skillEntry?.entry.recorded_at;
  const b = row.baseline?.entry.recorded_at;
  if (s && b && s !== b) return `${s} (base ${b})`;
  return s ?? b ?? '—';
}

function weakestChecksSummary(row: TaskTargetRow): string {
  const primary = row.skillEntry ?? row.baseline;
  if (!primary) return '—';
  const entries = Object.entries(primary.entry.quality.checks);
  if (entries.length === 0) return '—';
  const sorted = [...entries].sort(([idA, a], [idB, b]) =>
    a.pass_rate - b.pass_rate
    || a.mean_pass_probability - b.mean_pass_probability
    || compareCodepoint(idA, idB),
  );
  const failing = sorted.filter(([, c]) => c.pass_rate < 1);
  if (failing.length > 0) {
    const shown = failing.slice(0, 2).map(([id, c]) => `\`${id}\` (${c.passed}/${c.total})`);
    const extra = failing.length > 2 ? ` +${failing.length - 2} more` : '';
    return `${shown.join(', ')}${extra}`;
  }
  const [lowestId, lowest] = sorted[0];
  return `All 100% (min \`${lowestId}\` P=${pct(lowest.mean_pass_probability)})`;
}

function coverageStatusLabel(info: SkillCoverageInfo): string {
  if (info.coverageStatus === 'harbor_evals') {
    return `Harbor evals (${info.evaluatedTasks.length}/${info.harborTasks.length} tasks recorded)`;
  }
  if (info.coverageStatus === 'unit_tests') {
    const noun = info.unitTestFiles.length === 1 ? 'file' : 'files';
    return `Offline unit tests (${info.unitTestFiles.length} ${noun})`;
  }
  return 'No evals yet';
}

function coverageDetailsLabel(info: SkillCoverageInfo): string {
  if (info.coverageStatus === 'harbor_evals') {
    const unrecorded = info.harborTasks.filter((t) => !info.evaluatedTasks.includes(t));
    const suffix = unrecorded.length > 0 ? ` — missing scorecards: ${unrecorded.map((t) => `\`${t}\``).join(', ')}` : '';
    return `${info.harborTasks.map((t) => `\`${t}\``).join(', ')}${suffix}`;
  }
  if (info.coverageStatus === 'unit_tests') {
    return info.unitTestFiles.map((f) => `\`skills/${info.skill}/tests/${f}\``).join(', ');
  }
  return '—';
}

function buildCheckGroupMap(row: TaskTargetRow): Map<string, string> {
  const map = new Map<string, string>();
  const groups = row.skillEntry?.entry.rubric_groups
    ?? row.baseline?.entry.rubric_groups
    ?? row.currentRubricGroups;
  if (!groups) return map;
  for (const [slug, ids] of Object.entries(groups)) {
    for (const id of ids) {
      if (!map.has(id)) map.set(id, slug);
    }
  }
  return map;
}

function formatCheckCell(stats: ScorecardCheckStats | undefined): string {
  if (!stats) return '—';
  return `${stats.passed}/${stats.total} (${pct(stats.pass_rate, 0)} · P=${pct(stats.mean_pass_probability)})`;
}

function renderTaskDetailsSection(row: TaskTargetRow): string {
  const lines: string[] = [];
  const skillSummary = row.skillEntry ? `Skill ${pct(row.skillEntry.entry.quality.pass_rate)}` : null;
  const baseSummary = row.baseline ? `Baseline ${pct(row.baseline.entry.quality.pass_rate)}` : null;
  const liftSummary = row.liftPassRate !== null ? `Lift ${liftPp(row.liftPassRate)}` : null;
  const headlineParts = [skillSummary, baseSummary, liftSummary, formatRowStatus(row)].filter(Boolean);

  lines.push(`<details>`);
  lines.push(`<summary><strong><code>${row.task}</code></strong> · <code>${row.target}</code> — ${headlineParts.join(' · ')}</summary>`);
  lines.push('');

  // Provenance summary line(s).
  for (const [label, view] of [['Skill', row.skillEntry], ['Baseline', row.baseline]] as const) {
    if (!view) continue;
    const e = view.entry;
    const det = e.deterministic ? `${e.deterministic.passed}/${e.deterministic.total}` : '—';
    const refPart = e.source?.git_ref ? ` · ref \`${e.source.git_ref}\`` : '';
    const hashParts = [
      e.hashes.skill_hash ? `skill=\`${e.hashes.skill_hash}\`` : null,
      `task=\`${e.hashes.task_hash}\``,
      `rubric=\`${e.hashes.rubric_hash}\``,
    ].filter(Boolean).join(', ');
    lines.push(
      `- **${label}** (${formatStalenessLabel(view)}): `
      + `${pct(e.quality.pass_rate)} pass rate, P(pass)=${pct(e.quality.mean_pass_probability)}, `
      + `reward ${det}, n=${e.trials.scored}/${e.trials.total}, `
      + `agent \`${e.agent_model}\`, judge \`${e.judge_model}\` (${e.scope}), `
      + `rubric \`${e.rubric}\`, date ${e.recorded_at}${refPart} (${hashParts})`,
    );
  }
  lines.push('');

  const checkGroup = buildCheckGroupMap(row);
  const checkIds = [...new Set([
    ...Object.keys(row.skillEntry?.entry.quality.checks ?? {}),
    ...Object.keys(row.baseline?.entry.quality.checks ?? {}),
  ])];

  // Sort worst-first by skill pass_rate, then skill mean_pass_probability, then baseline, then codepoint.
  checkIds.sort((a, b) => {
    const sa = row.skillEntry?.entry.quality.checks[a];
    const sb = row.skillEntry?.entry.quality.checks[b];
    const ba = row.baseline?.entry.quality.checks[a];
    const bb = row.baseline?.entry.quality.checks[b];
    const aRate = sa?.pass_rate ?? ba?.pass_rate ?? 1;
    const bRate = sb?.pass_rate ?? bb?.pass_rate ?? 1;
    const aProb = sa?.mean_pass_probability ?? ba?.mean_pass_probability ?? 1;
    const bProb = sb?.mean_pass_probability ?? bb?.mean_pass_probability ?? 1;
    return aRate - bRate || aProb - bProb || compareCodepoint(a, b);
  });

  const hasGroups = checkIds.some((id) => checkGroup.has(id));
  if (hasGroups) {
    lines.push('| Check | Facet | Baseline | Skill | Lift |');
    lines.push('|---|---|---|---|---|');
  } else {
    lines.push('| Check | Baseline | Skill | Lift |');
    lines.push('|---|---|---|---|');
  }

  for (const id of checkIds) {
    const bStats = row.baseline?.entry.quality.checks[id];
    const sStats = row.skillEntry?.entry.quality.checks[id];
    const delta = bStats && sStats ? liftPp(sStats.pass_rate - bStats.pass_rate) : '—';
    const cells = hasGroups
      ? [`\`${id}\``, `\`${checkGroup.get(id) ?? 'task'}\``, formatCheckCell(bStats), formatCheckCell(sStats), delta]
      : [`\`${id}\``, formatCheckCell(bStats), formatCheckCell(sStats), delta];
    lines.push(`| ${cells.map(escapeMdCell).join(' | ')} |`);
  }

  lines.push('');
  lines.push('</details>');
  return lines.join('\n');
}

/** Render deterministic GitHub-previewable Markdown from a ScorecardSnapshot. */
export function renderScorecardMarkdown(snapshot: ScorecardSnapshot): string {
  const lines: string[] = [];
  lines.push('<!-- Generated by `pnpm eval scorecard build`. Source of truth: evals/scorecards/**/*.json. -->');
  lines.push('');
  lines.push('# Eval Scorecard');
  lines.push('');
  lines.push(
    'Overview of skill evaluation coverage and recorded results across `skills/`. '
    + 'Freshness is computed by comparing recorded content hashes (`skill_hash`, `task_hash`, `rubric_hash`) against the current repository tree; '
    + 'baseline entries ignore `skill_hash` so skill edits do not falsely invalidate baselines.',
  );
  lines.push('');
  lines.push('Run `pnpm eval scorecard --open` to explore this data in the interactive local HTML dashboard (`eval-results/scorecard.html`).');
  lines.push('');

  // 1. Skill Coverage table.
  lines.push('## Skill Coverage');
  lines.push('');
  lines.push('| Skill | Evaluation Coverage | Tasks / Tests |');
  lines.push('|---|---|---|');
  for (const info of snapshot.skills) {
    lines.push(
      `| [\`${info.skill}\`](../skills/${info.skill}/SKILL.md) | ${escapeMdCell(coverageStatusLabel(info))} | ${escapeMdCell(coverageDetailsLabel(info))} |`,
    );
  }
  lines.push('');

  // 2. Per-skill eval summaries.
  const skillsWithRows = [...new Set(snapshot.rows.map((r) => r.skill))].sort(compareCodepoint);
  if (skillsWithRows.length === 0) {
    lines.push('## Recorded Evaluations');
    lines.push('');
    lines.push('No scorecards recorded yet. Run `pnpm eval scorecard record <judge-dir...>` to record a saved judge batch.');
    lines.push('');
    return `${lines.join('\n')}`;
  }

  for (const skill of skillsWithRows) {
    const skillRows = snapshot.rows.filter((r) => r.skill === skill);
    const totalEntries = skillRows.reduce(
      (sum, r) => sum + (r.skillEntry ? 1 : 0) + (r.baseline ? 1 : 0),
      0,
    );
    const currentEntries = skillRows.reduce(
      (sum, r) => sum
        + (r.skillEntry?.staleness.status === 'current' ? 1 : 0)
        + (r.baseline?.staleness.status === 'current' ? 1 : 0),
      0,
    );

    lines.push(`## \`${skill}\` Eval Summary`);
    lines.push('');
    lines.push(
      `Recorded entries: **${currentEntries}/${totalEntries} current**. `
      + 'Quality scores report mean trial pass rate and mean check `P(pass)` across scored trials.',
    );
    lines.push('');
    lines.push('| Task | Target | Reward | Baseline | Skill | Lift | Weakest Check(s) | n | Agent / Judge | Date | Status |');
    lines.push('|---|---|---|---|---|---|---|---|---|---|---|');

    for (const row of skillRows) {
      const cells = [
        `\`${row.task}\``,
        `\`${row.target}\``,
        formatDeterministicCell(row),
        formatScoreCell(row.baseline),
        formatScoreCell(row.skillEntry),
        liftPp(row.liftPassRate),
        weakestChecksSummary(row),
        formatSampleCell(row),
        formatModelsCell(row),
        formatDateCell(row),
        formatRowStatus(row),
      ];
      lines.push(`| ${cells.map(escapeMdCell).join(' | ')} |`);
    }
    lines.push('');

    // 3. Collapsible per-task breakdowns.
    lines.push(`### \`${skill}\` Check-by-Check Breakdowns`);
    lines.push('');
    for (const row of skillRows) {
      lines.push(renderTaskDetailsSection(row));
      lines.push('');
    }
  }

  return `${lines.join('\n').trimEnd()}\n`;
}

/** Generate and write evals/SCORECARD.md from checked-in scorecards and current working tree. */
export function writeScorecardMarkdown(repoRoot: string, outputPath?: string): { path: string; snapshot: ScorecardSnapshot } {
  const snapshot = buildScorecardSnapshot(repoRoot);
  const targetPath = outputPath ?? join(repoRoot, 'evals/SCORECARD.md');
  mkdirSync(dirname(targetPath), { recursive: true });
  writeFileSync(targetPath, renderScorecardMarkdown(snapshot));
  return { path: targetPath, snapshot };
}
