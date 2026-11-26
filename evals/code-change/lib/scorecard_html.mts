/** Self-contained, zero-dependency interactive offline HTML dashboard for eval scorecards. */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import {
  buildScorecardSnapshot,
  type EvaluatedEntryView,
  type ScorecardSnapshot,
  type SkillCoverageInfo,
  type TaskTargetRow,
} from './scorecard_discovery.mts';
import { compareCodepoint, type ScorecardCheckStats } from './scorecard_schema.mts';
import { escapeHtml } from './source_tokens.mts';
import { formatCostUsd, formatDurationSec, formatTokenCount } from './trial_metrics.mts';

function escape(value: unknown): string {
  return escapeHtml(String(value ?? ''));
}

function pct(value: number | null | undefined, decimals = 1): string {
  return typeof value === 'number' && Number.isFinite(value) ? `${(value * 100).toFixed(decimals)}%` : '—';
}

function liftPp(delta: number | null | undefined): string {
  if (typeof delta !== 'number' || !Number.isFinite(delta)) return '—';
  const pp = delta * 100;
  const rounded = Math.abs(pp) < 0.05 ? 0 : pp;
  const sign = rounded > 0 ? '+' : '';
  return `${sign}${rounded.toFixed(1)}pp`;
}

function clampPct(value: number | null | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value * 100)));
}

const PROB_STOPS: ReadonlyArray<readonly [number, number, number, number, number]> = [
  [0.0, 4, 78, 30, 50],
  [0.5, 36, 86, 28, 50],
  [0.72, 62, 72, 26, 44],
  [0.88, 122, 52, 25, 42],
  [1.0, 154, 56, 22, 36],
];

function probColors(prob: number): { bg: string; fg: string; bar: string } {
  const p = Math.max(0, Math.min(1, Number.isFinite(prob) ? prob : 0));
  let lo = PROB_STOPS[0];
  let hi = PROB_STOPS[PROB_STOPS.length - 1];
  for (let i = 0; i < PROB_STOPS.length - 1; i += 1) {
    if (p <= PROB_STOPS[i + 1][0]) {
      lo = PROB_STOPS[i];
      hi = PROB_STOPS[i + 1];
      break;
    }
  }
  const span = hi[0] - lo[0];
  const t = span > 0 ? (p - lo[0]) / span : 0;
  const lerp = (a: number, b: number) => Math.round(a + (b - a) * t);
  const h = lerp(lo[1], hi[1]);
  const s = lerp(lo[2], hi[2]);
  return {
    bg: `hsl(${h} ${s}% 90%)`,
    fg: `hsl(${h} ${s}% ${lerp(lo[3], hi[3])}%)`,
    bar: `hsl(${h} ${s}% ${lerp(lo[4], hi[4])}%)`,
  };
}

function scoreBarHtml(rate: number | null | undefined, subText?: string): string {
  if (typeof rate !== 'number' || !Number.isFinite(rate)) {
    return '<span class="muted">—</span>';
  }
  const width = clampPct(rate);
  const { bar } = probColors(rate);
  const sub = subText ? `<span class="sub-metric">${escape(subText)}</span>` : '';
  return `<div class="prob-cell"><div class="bar-track" aria-hidden="true"><div class="bar-fill" style="width:${width}%;background:${bar}"></div></div><span class="numeric prob-val">${pct(rate)}</span>${sub}</div>`;
}

function labelForCheck(id: string): string {
  return id.replaceAll('_', ' ');
}

function labelForSlug(slug: string): string {
  const acronyms: Record<string, string> = { solid: 'SOLID', e2e: 'E2E' };
  return slug
    .split(/[-_]+/)
    .filter(Boolean)
    .map((part) => acronyms[part.toLowerCase()] ?? (part[0].toUpperCase() + part.slice(1)))
    .join(' ');
}

function labelForTarget(target: string): string {
  if (target === 'production_code') return 'Production code';
  if (target === 'test_code') return 'Test code';
  return 'Review';
}

function targetClass(target: string): string {
  if (target === 'production_code') return 'target-prod';
  if (target === 'test_code') return 'target-test';
  return 'target-review';
}

function scoreTone(rate: number | null): string {
  if (rate === null) return '';
  if (rate >= 0.9) return ' tone-good';
  if (rate >= 0.7) return ' tone-warn';
  return ' tone-bad';
}

function liftClass(delta: number | null): string {
  if (delta === null) return 'neutral';
  if (delta > 0.005) return 'pass';
  if (delta < -0.005) return 'fail';
  return 'neutral';
}

function rowFreshnessState(row: TaskTargetRow): 'current' | 'stale' {
  const entries = [row.skillEntry, row.baseline].filter((v): v is EvaluatedEntryView => v !== null);
  return entries.every((v) => v.staleness.status === 'current') ? 'current' : 'stale';
}

function freshnessBadgeHtml(view: EvaluatedEntryView): string {
  if (view.staleness.status === 'current') {
    return '<span class="badge pass">Current</span>';
  }
  return `<span class="badge fail">Stale (${escape(view.staleness.reasons.join(', '))})</span>`;
}

function rowFreshnessBadgesHtml(row: TaskTargetRow): string {
  if (row.skillEntry && row.baseline) {
    const sCurr = row.skillEntry.staleness.status === 'current';
    const bCurr = row.baseline.staleness.status === 'current';
    if (sCurr && bCurr) return '<span class="badge pass">Current</span>';
    if (!sCurr && bCurr) {
      return `<span class="badge fail" title="Skill entry is stale; baseline is still current">Skill: Stale (${escape(row.skillEntry.staleness.reasons.join(', '))})</span>`;
    }
    if (sCurr && !bCurr) {
      return `<span class="badge fail" title="Skill entry is current; baseline is stale">Base: Stale (${escape(row.baseline.staleness.reasons.join(', '))})</span>`;
    }
    const combined = [...new Set([...row.skillEntry.staleness.reasons, ...row.baseline.staleness.reasons])];
    return `<span class="badge fail">Stale (${escape(combined.join(', '))})</span>`;
  }
  const sole = row.skillEntry ?? row.baseline;
  return sole ? freshnessBadgeHtml(sole) : '<span class="badge neutral">—</span>';
}

function weakestCheckForRow(row: TaskTargetRow): { id: string; stats: ScorecardCheckStats; failing: boolean } | null {
  const primary = row.skillEntry ?? row.baseline;
  if (!primary) return null;
  const entries = Object.entries(primary.entry.quality.checks);
  if (!entries.length) return null;
  entries.sort(([idA, a], [idB, b]) =>
    a.pass_rate - b.pass_rate
    || a.mean_pass_probability - b.mean_pass_probability
    || compareCodepoint(idA, idB),
  );
  const [id, stats] = entries[0];
  return { id, stats, failing: stats.pass_rate < 1 };
}

function renderCoveragePanel(skills: SkillCoverageInfo[]): string {
  const cards = skills.map((info) => {
    const badge = info.coverageStatus === 'harbor_evals'
      ? `<span class="badge pass">Harbor evals · ${info.evaluatedTasks.length}/${info.harborTasks.length}</span>`
      : info.coverageStatus === 'unit_tests'
        ? `<span class="badge cond-skill">Unit tests · ${info.unitTestFiles.length}</span>`
        : '<span class="badge neutral">No evals yet</span>';
    const detail = info.coverageStatus === 'harbor_evals'
      ? info.harborTasks.map((t) => `<span class="chip">${escape(t)}</span>`).join('')
      : info.coverageStatus === 'unit_tests'
        ? info.unitTestFiles.map((f) => `<span class="chip">${escape(f)}</span>`).join('')
        : '<span class="muted">No automated evals or unit tests yet</span>';
    return `<div class="cov-card cov-${info.coverageStatus}"><div class="cov-head"><span class="cov-skill">${escape(info.skill)}</span>${badge}</div><div class="cov-body">${detail}</div></div>`;
  }).join('');

  return `<section class="panel"><div class="panel-head"><h2>Skill coverage</h2><span class="muted">${skills.length} skills in <code>skills/</code></span></div><div class="cov-grid">${cards}</div></section>`;
}

function renderHashDiffTable(view: EvaluatedEntryView): string {
  const rows: Array<{ label: string; recorded: string; current: string; status: 'match' | 'mismatch' | 'ignored' }> = [];
  const rec = view.entry.hashes;
  const cur = view.staleness.currentHashes;

  if (view.condition === 'baseline') {
    rows.push({ label: 'skill_hash', recorded: 'null (ignored)', current: cur.skill_hash ?? '—', status: 'ignored' });
  } else {
    rows.push({
      label: 'skill_hash',
      recorded: rec.skill_hash ?? '—',
      current: cur.skill_hash ?? 'missing',
      status: rec.skill_hash !== null && rec.skill_hash === cur.skill_hash ? 'match' : 'mismatch',
    });
  }
  rows.push({
    label: 'task_hash',
    recorded: rec.task_hash,
    current: cur.task_hash ?? 'missing',
    status: rec.task_hash === cur.task_hash ? 'match' : 'mismatch',
  });
  rows.push({
    label: 'rubric_hash',
    recorded: rec.rubric_hash,
    current: cur.rubric_hash ?? 'missing',
    status: rec.rubric_hash === cur.rubric_hash ? 'match' : 'mismatch',
  });

  const body = rows.map((r) => {
    const pill = r.status === 'match'
      ? '<span class="pill pass">match</span>'
      : r.status === 'ignored'
        ? '<span class="pill neutral">n/a</span>'
        : '<span class="pill fail">changed</span>';
    return `<tr><td><code>${escape(r.label)}</code></td><td><code>${escape(r.recorded)}</code></td><td><code>${escape(r.current)}</code></td><td>${pill}</td></tr>`;
  }).join('');

  return `<table class="hash-table"><thead><tr><th>Artifact</th><th>Recorded</th><th>Working tree</th><th>State</th></tr></thead><tbody>${body}</tbody></table>`;
}

function renderConditionCard(label: string, view: EvaluatedEntryView | null): string {
  if (!view) {
    return `<div class="cond-card cond-empty"><div class="cond-card-head"><span class="cond-badge cond-neutral">${escape(label)}</span></div><p class="muted">No ${escape(label.toLowerCase())} run recorded for this task &amp; target yet.</p></div>`;
  }
  const e = view.entry;
  const det = e.deterministic ? `${e.deterministic.passed}/${e.deterministic.total} (${pct(e.deterministic.pass_rate, 0)})` : '—';
  const subMetrics = e.deterministic?.metrics
    ? Object.entries(e.deterministic.metrics)
      .map(([k, v]) => `<span class="chip">${escape(k)}: ${v.passed}/${v.total}</span>`)
      .join('')
    : '';
  const refBadge = e.source?.git_ref ? `<span class="chip">git ${escape(e.source.git_ref)}</span>` : '';
  const judgeCodeBadge = e.with_judge_code ? '<span class="chip">+judge-code</span>' : '';
  const usageChips = e.usage
    ? [
      e.usage.n_input_tokens || e.usage.n_output_tokens
        ? `<span class="chip">Mean tokens: ${escape([
          e.usage.n_input_tokens ? `${formatTokenCount(e.usage.n_input_tokens.mean)} in` : null,
          e.usage.n_output_tokens ? `${formatTokenCount(e.usage.n_output_tokens.mean)} out` : null,
        ].filter(Boolean).join(' / '))}</span>`
        : '',
      e.usage.cost_usd ? `<span class="chip">Mean cost: ${escape(formatCostUsd(e.usage.cost_usd.mean))}</span>` : '',
      (e.usage.duration_sec ?? e.usage.agent_duration_sec)
        ? `<span class="chip">Mean duration: ${escape(formatDurationSec((e.usage.duration_sec ?? e.usage.agent_duration_sec)!.mean))}</span>`
        : '',
    ].filter(Boolean).join('')
    : '';
  const condCls = view.condition === 'skill' ? 'cond-skill' : 'cond-baseline';
  return `<div class="cond-card">
    <div class="cond-card-head">
      <div class="cond-title-group"><span class="cond-badge ${condCls}">${escape(label)}</span>${judgeCodeBadge}${freshnessBadgeHtml(view)}</div>
      <span class="muted numeric">${escape(e.recorded_at)}</span>
    </div>
    <div class="cond-metrics">
      <div><div class="mini-label">Quality pass rate</div><div class="mini-val${scoreTone(e.quality.pass_rate)}">${pct(e.quality.pass_rate)}</div></div>
      <div><div class="mini-label">Mean P(pass)</div><div class="mini-val">${pct(e.quality.mean_pass_probability)}</div></div>
      <div><div class="mini-label">Deterministic reward</div><div class="mini-val">${escape(det)}</div></div>
      <div><div class="mini-label">Trials scored</div><div class="mini-val">${e.trials.scored}/${e.trials.total}</div></div>
    </div>
    <div class="cond-meta">
      <span>Agent <strong>${escape(e.agent_model)}</strong></span>
      <span>Judge <strong>${escape(e.judge_model)}</strong> (${escape(e.scope)})</span>
      <span>Rubric <strong>${escape(e.rubric)}</strong></span>
      ${refBadge}
    </div>
    ${subMetrics || usageChips ? `<div class="chip-row">${usageChips}${subMetrics}</div>` : ''}
    <details class="hash-details"><summary>Content hash provenance</summary>${renderHashDiffTable(view)}</details>
  </div>`;
}

function renderCheckComparisonTable(row: TaskTargetRow, cardId: string): string {
  const groupByCheck = new Map<string, string>();
  const groupOrder: string[] = [];
  const groups = row.skillEntry?.entry.rubric_groups
    ?? row.baseline?.entry.rubric_groups
    ?? row.currentRubricGroups;
  if (groups) {
    for (const [slug, ids] of Object.entries(groups)) {
      if (!groupOrder.includes(slug)) groupOrder.push(slug);
      for (const id of ids) {
        if (!groupByCheck.has(id)) groupByCheck.set(id, slug);
      }
    }
  }

  const checkIds = [...new Set([
    ...Object.keys(row.skillEntry?.entry.quality.checks ?? {}),
    ...Object.keys(row.baseline?.entry.quality.checks ?? {}),
  ])];

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

  const renderCheckRow = (id: string, showGroupTag: boolean): string => {
    const bStats = row.baseline?.entry.quality.checks[id];
    const sStats = row.skillEntry?.entry.quality.checks[id];
    const delta = bStats && sStats ? sStats.pass_rate - bStats.pass_rate : null;
    const groupSlug = groupByCheck.get(id);
    const q = row.currentQuestions?.[id];
    const labelHtml = q
      ? `<span class="tip-wrap"><span class="tip-trigger" tabindex="0">${escape(labelForCheck(id))}</span><div class="tip-card" role="tooltip"><div class="tip-q">${escape(q.instructions)}</div><div class="tip-crit tip-pass"><strong>Pass when</strong><p>${escape(q.criteria.pass)}</p></div><div class="tip-crit tip-fail"><strong>Fail when</strong><p>${escape(q.criteria.fail)}</p></div></div></span>`
      : `<span>${escape(labelForCheck(id))}</span>`;
    const tagHtml = showGroupTag && groupSlug ? `<span class="group-tag">${escape(labelForSlug(groupSlug))}</span>` : '';
    const isFail = (sStats && sStats.pass_rate < 1) || (!sStats && bStats && bStats.pass_rate < 1);
    const baseCell = bStats
      ? `<div class="check-score-cell"><span class="badge ${bStats.passed === bStats.total ? 'pass' : 'fail'}">${bStats.passed}/${bStats.total}</span>${scoreBarHtml(bStats.mean_pass_probability)}</div>`
      : '<span class="muted">—</span>';
    const skillCell = sStats
      ? `<div class="check-score-cell"><span class="badge ${sStats.passed === sStats.total ? 'pass' : 'fail'}">${sStats.passed}/${sStats.total}</span>${scoreBarHtml(sStats.mean_pass_probability)}</div>`
      : '<span class="muted">—</span>';
    const liftCell = delta !== null
      ? `<span class="badge ${liftClass(delta)}">${escape(liftPp(delta))}</span>`
      : '<span class="muted">—</span>';
    return `<tr class="${isFail ? 'row-fail' : ''}" data-check-row="${escape(id.toLowerCase())}">
      <td class="check-label-cell">${labelHtml}${tagHtml}</td>
      <td>${baseCell}</td>
      <td>${skillCell}</td>
      <td class="numeric">${liftCell}</td>
    </tr>`;
  };

  const activeGroups = groupOrder.filter((slug) => checkIds.some((id) => groupByCheck.get(id) === slug));
  const ungrouped = checkIds.filter((id) => !groupByCheck.has(id));
  if (activeGroups.length >= 2) {
    const groupedHtml = [...activeGroups, ...(ungrouped.length ? ['other'] : [])].map((slug) => {
      const ids = slug === 'other' ? ungrouped : checkIds.filter((id) => groupByCheck.get(id) === slug);
      const header = `<tr class="facet-row" data-facet-header><td colspan="4"><strong>${escape(labelForSlug(slug))}</strong> <span class="group-count">${ids.length}</span></td></tr>`;
      return header + ids.map((id) => renderCheckRow(id, false)).join('');
    }).join('');
    const flatHtml = checkIds.map((id) => renderCheckRow(id, true)).join('');
    return `<div class="check-section-head"><h3>Check-by-check comparison (${checkIds.length})</h3><div class="view-switch" role="tablist"><button type="button" class="view-btn active" role="tab" aria-selected="true" data-card-view="${escape(cardId)}" data-mode="grouped">By facet</button><button type="button" class="view-btn" role="tab" aria-selected="false" data-card-view="${escape(cardId)}" data-mode="flat">Worst first</button></div></div>
    <div class="table-scroll"><table class="checks-table"><thead><tr><th>Check</th><th>Baseline (passed · P(pass))</th><th>Skill (passed · P(pass))</th><th>Lift</th></tr></thead>
      <tbody data-card-tbody="${escape(cardId)}" data-mode="grouped">${groupedHtml}</tbody>
      <tbody data-card-tbody="${escape(cardId)}" data-mode="flat" hidden>${flatHtml}</tbody>
    </table></div>`;
  }

  return `<div class="check-section-head"><h3>Check-by-check comparison (${checkIds.length})</h3></div>
  <div class="table-scroll"><table class="checks-table"><thead><tr><th>Check</th><th>Baseline (passed · P(pass))</th><th>Skill (passed · P(pass))</th><th>Lift</th></tr></thead><tbody>${checkIds.map((id) => renderCheckRow(id, false)).join('')}</tbody></table></div>`;
}

function renderMatrixAndCards(rows: TaskTargetRow[]): { matrixHtml: string; cardsHtml: string } {
  const matrixRows = rows.map((row, idx) => {
    const cardId = `card-${idx}`;
    const freshness = rowFreshnessState(row);
    const allCheckNames = [...new Set([
      ...Object.keys(row.skillEntry?.entry.quality.checks ?? {}),
      ...Object.keys(row.baseline?.entry.quality.checks ?? {}),
    ])].join(' ').toLowerCase();
    const weakest = weakestCheckForRow(row);
    const weakestHtml = weakest
      ? `<span class="pill ${weakest.failing ? 'fail' : 'pass'}">${escape(weakest.id)} (${weakest.failing ? `${weakest.stats.passed}/${weakest.stats.total}` : `P=${pct(weakest.stats.mean_pass_probability, 0)}`})</span>`
      : '<span class="muted">—</span>';
    const skillDet = row.skillEntry?.entry.deterministic;
    const baseDet = row.baseline?.entry.deterministic;
    const rewardHtml = skillDet || baseDet
      ? `<span class="badge ${(skillDet ?? baseDet)!.passed === (skillDet ?? baseDet)!.total ? 'pass' : 'fail'}">${(skillDet ?? baseDet)!.passed}/${(skillDet ?? baseDet)!.total}</span>${skillDet && baseDet ? `<span class="sub-metric">base ${baseDet.passed}/${baseDet.total}</span>` : ''}`
      : '<span class="muted">—</span>';
    const sampleN = row.skillEntry?.entry.trials.scored ?? row.baseline?.entry.trials.scored ?? 0;
    const recDate = row.skillEntry?.entry.recorded_at ?? row.baseline?.entry.recorded_at ?? '—';

    return `<tr class="score-row" data-skill="${escape(row.skill)}" data-target="${escape(row.target)}" data-freshness="${freshness}" data-checks="${escape(allCheckNames)}" data-task-name="${escape(row.task.toLowerCase())}">
      <td><a class="task-jump" href="#${cardId}" data-jump="${cardId}"><strong>${escape(row.task)}</strong></a><div class="sub-metric">${escape(row.skill)}</div></td>
      <td><span class="pill ${targetClass(row.target)}">${escape(labelForTarget(row.target))}</span></td>
      <td class="numeric"><div class="reward-cell">${rewardHtml}</div></td>
      <td>${scoreBarHtml(row.baseline?.entry.quality.pass_rate, row.baseline ? `P=${pct(row.baseline.entry.quality.mean_pass_probability, 0)}` : undefined)}</td>
      <td>${scoreBarHtml(row.skillEntry?.entry.quality.pass_rate, row.skillEntry ? `P=${pct(row.skillEntry.entry.quality.mean_pass_probability, 0)}` : undefined)}</td>
      <td class="numeric">${row.liftPassRate !== null ? `<span class="badge ${liftClass(row.liftPassRate)}">${escape(liftPp(row.liftPassRate))}</span>` : '<span class="muted">—</span>'}</td>
      <td>${weakestHtml}</td>
      <td class="numeric">n=${sampleN}<div class="sub-metric">${escape(recDate)}</div></td>
      <td>${rowFreshnessBadgesHtml(row)}</td>
    </tr>`;
  }).join('');

  const cards = rows.map((row, idx) => {
    const cardId = `card-${idx}`;
    const freshness = rowFreshnessState(row);
    const allCheckNames = [...new Set([
      ...Object.keys(row.skillEntry?.entry.quality.checks ?? {}),
      ...Object.keys(row.baseline?.entry.quality.checks ?? {}),
    ])].join(' ').toLowerCase();
    const primaryScore = row.skillEntry
      ? `<span class="badge ${row.skillEntry.entry.quality.pass_rate >= 0.9 ? 'pass' : 'fail'}">Skill ${pct(row.skillEntry.entry.quality.pass_rate)}</span>`
      : '';
    const liftPill = row.liftPassRate !== null
      ? `<span class="badge ${liftClass(row.liftPassRate)}">Lift ${escape(liftPp(row.liftPassRate))}</span>`
      : '';
    return `<details class="task-card" id="${cardId}" data-skill="${escape(row.skill)}" data-target="${escape(row.target)}" data-freshness="${freshness}" data-checks="${escape(allCheckNames)}" data-task-name="${escape(row.task.toLowerCase())}">
      <summary>
        <span class="card-title"><code>${escape(row.task)}</code></span>
        <span class="pill ${targetClass(row.target)}">${escape(labelForTarget(row.target))}</span>
        <span class="card-badges">${primaryScore}${liftPill}${rowFreshnessBadgesHtml(row)}</span>
      </summary>
      <div class="card-body">
        <div class="cond-grid">
          ${renderConditionCard('Baseline', row.baseline)}
          ${renderConditionCard('Skill', row.skillEntry)}
        </div>
        ${renderCheckComparisonTable(row, cardId)}
      </div>
    </details>`;
  }).join('');

  return { matrixHtml: matrixRows, cardsHtml: cards };
}

const STYLE = `
:root{color-scheme:light;--ink:#16243b;--muted:#5c687b;--line:#dce3ed;--blue:#3158cf;--green:#116547;--green-bg:#e7f6ee;--amber:#9a3412;--amber-bg:#ffedd5;--fail-row:#fffaf5;--surface:#ffffff}
*{box-sizing:border-box}
body{margin:0;background:#f4f6fa;color:var(--ink);font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
main{max-width:1380px;margin:0 auto;padding:24px 28px 64px}
header{border-top:3px solid var(--blue);padding:14px 0 18px}
.title-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
h1{font-size:1.65rem;line-height:1.2;letter-spacing:-.03em;margin:0}
h2{font-size:1.125rem;margin:0}
h3{font-size:.98rem;margin:0}
p{margin:6px 0}
code{font:500 .86em/1.4 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;background:#f1f5f9;padding:1px 5px;border-radius:4px}
.muted{color:var(--muted)}
.meta-bar{display:flex;flex-wrap:wrap;gap:6px 18px;margin-top:8px;font-size:.825rem;color:var(--muted)}
.meta-bar strong{color:var(--ink);font-weight:600}
.kpi-strip,.panel,.task-card{background:var(--surface);border:1px solid var(--line);border-radius:12px}
.kpi-strip{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));margin-bottom:18px;overflow:hidden}
.kpi{padding:14px 16px;border-right:1px solid var(--line)}
.kpi:last-child{border-right:0}
.kpi-alert{background:#fff8f1}
.kpi-label{color:var(--muted);font-size:.75rem;font-weight:700;text-transform:uppercase;letter-spacing:.04em}
.kpi-value{font-size:1.55rem;font-weight:700;letter-spacing:-.03em;line-height:1.25;margin:3px 0}
.kpi-note{font-size:.78rem;color:var(--muted);line-height:1.35}
.tone-good{color:var(--green)}
.tone-warn{color:var(--amber)}
.tone-bad{color:#b91c1c}
.panel{padding:18px 20px;margin-bottom:18px}
.panel-head{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:14px}
.cov-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:12px}
.cov-card{border:1px solid var(--line);border-radius:10px;padding:12px 14px;background:#fafcff}
.cov-card.cov-harbor_evals{border-left:3px solid var(--green);background:#f9fefb}
.cov-card.cov-unit_tests{border-left:3px solid var(--blue)}
.cov-card.cov-none{border-left:3px solid #cbd5e1;background:#f8fafc}
.cov-head{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:8px;flex-wrap:wrap}
.cov-skill{font:700 .92rem/1.3 ui-monospace,SFMono-Regular,Consolas,monospace}
.cov-body,.chip-row{display:flex;flex-wrap:wrap;gap:5px;font-size:.78rem}
.chip{display:inline-flex;align-items:center;padding:2px 7px;border-radius:5px;background:#eef2f7;color:var(--ink);font:500 .75rem/1.3 ui-monospace,SFMono-Regular,Consolas,monospace}
.filters{display:flex;gap:12px;align-items:end;flex-wrap:wrap;margin-bottom:14px}
.field{display:flex;flex-direction:column;gap:4px;font-size:.78rem;font-weight:600;color:var(--muted)}
select,input[type=search],button{font:inherit;color:var(--ink);background:white;border:1px solid #b8c5d8;border-radius:7px;min-height:36px;padding:5px 11px}
select{min-width:150px}
input[type=search]{min-width:220px}
button{cursor:pointer}
button:hover{background:#edf2ff;border-color:var(--blue)}
:focus-visible{outline:3px solid #8da7ff;outline-offset:2px}
.count{font-size:.8125rem;color:var(--muted);margin-left:auto}
.table-scroll{overflow-x:auto}
table{width:100%;border-collapse:collapse;text-align:left}
th{font-size:.78rem;color:var(--muted);font-weight:600;white-space:nowrap}
th,td{padding:9px 10px;border-bottom:1px solid var(--line);vertical-align:middle}
th:first-child,td:first-child{padding-left:0}
tbody tr:last-child td{border-bottom:0}
.numeric{font-variant-numeric:tabular-nums;white-space:nowrap}
.task-jump{color:var(--ink);text-decoration:none}
.task-jump:hover{color:var(--blue);text-decoration:underline}
.badge,.pill,.cond-badge{display:inline-flex;align-items:center;border-radius:5px;font-weight:600;white-space:nowrap}
.badge{padding:2px 8px;font-size:.78rem;line-height:1.4}
.pill{padding:2px 7px;font-size:.75rem;line-height:1.35}
.cond-badge{padding:3px 9px;border-radius:999px;font-size:.72rem;font-weight:700;letter-spacing:.05em;text-transform:uppercase}
.cond-skill{background:#e0e7ff;color:#1e40af}
.cond-baseline{background:#e2e8f0;color:#334155}
.cond-neutral{background:#eef1f6;color:var(--muted)}
.pass{color:var(--green);background:var(--green-bg)}
.fail{color:var(--amber);background:var(--amber-bg)}
.neutral{color:var(--muted);background:#eef1f6}
.target-prod{background:#e0e7ff;color:#1e40af}
.target-test{background:#dcfce7;color:#166534}
.target-review{background:#f3e8ff;color:#6b21a8}
.prob-cell{display:flex;align-items:center;gap:7px;min-width:130px}
.bar-track{width:62px;height:7px;background:#e6ecf5;border-radius:999px;overflow:hidden;flex-shrink:0}
.bar-fill{height:100%;border-radius:999px}
.prob-val{font-size:.84rem;font-weight:600}
.sub-metric{font-size:.74rem;color:var(--muted);white-space:nowrap}
.reward-cell{display:flex;flex-direction:column;gap:2px;align-items:flex-start}
.task-card{margin:12px 0;overflow:hidden}
.task-card>summary{padding:13px 18px;display:flex;align-items:center;gap:10px;cursor:pointer;list-style:none;flex-wrap:wrap}
.task-card>summary::-webkit-details-marker{display:none}
.task-card>summary:before{content:'+';color:var(--blue);font-weight:700;width:14px}
.task-card[open]>summary:before{content:'−'}
.task-card[open]>summary{border-bottom:1px solid var(--line);background:#f8faff}
.card-title{font-weight:700;margin-right:2px}
.card-badges{margin-left:auto;display:flex;gap:6px;flex-wrap:wrap;align-items:center}
.card-body{padding:16px 20px}
.cond-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px;margin-bottom:16px}
.cond-card{border:1px solid var(--line);border-radius:10px;padding:13px 15px;background:#fbfcfe}
.cond-empty{background:#f8fafc;border-style:dashed}
.cond-card-head{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:10px;flex-wrap:wrap}
.cond-title-group{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.cond-metrics{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px;margin-bottom:10px}
.mini-label{font-size:.7rem;color:var(--muted);text-transform:uppercase;letter-spacing:.03em}
.mini-val{font-size:1.05rem;font-weight:700;font-variant-numeric:tabular-nums}
.cond-meta{display:flex;flex-wrap:wrap;gap:6px 14px;font-size:.78rem;color:var(--muted);margin-bottom:8px}
.cond-meta strong{color:var(--ink)}
.hash-details{margin-top:8px;font-size:.8rem}
.hash-details>summary{cursor:pointer;color:var(--blue);font-weight:600}
.hash-table{margin-top:8px;font-size:.78rem}
.hash-table th,.hash-table td{padding:5px 8px}
.check-section-head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin:12px 0 8px;flex-wrap:wrap}
.view-switch{display:inline-flex;background:#f1f5f9;border:1px solid var(--line);border-radius:8px;padding:2px;gap:2px}
.view-btn{min-height:28px;padding:3px 10px;font-size:.78rem;font-weight:600;border:0;border-radius:6px;background:transparent;color:var(--muted)}
.view-btn.active{background:white;color:var(--ink);box-shadow:0 1px 2px rgba(15,23,42,.08)}
.checks-table tr.row-fail td{background:var(--fail-row)}
.facet-row td{background:#f8fafc;padding:7px 10px;border-top:1px solid var(--line)}
.group-count{display:inline-flex;align-items:center;justify-content:center;min-width:19px;height:18px;padding:0 5px;border-radius:999px;background:#e2e8f0;color:var(--muted);font-size:.72rem;font-weight:600;margin-left:4px}
.group-tag{display:inline-block;margin-left:7px;padding:1px 6px;border-radius:4px;background:#f1f5f9;color:var(--muted);font-size:.72rem;font-weight:500;text-transform:none}
.check-label-cell{font-weight:600;text-transform:capitalize;min-width:220px}
.check-score-cell{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.tip-wrap{position:relative;display:inline-flex;align-items:center}
.tip-trigger{border-bottom:1px dotted #94a3b8;cursor:help;padding-bottom:1px}
.tip-trigger:hover,.tip-trigger:focus-visible{color:var(--blue);border-bottom-color:var(--blue)}
.tip-card{display:none;position:absolute;left:0;top:calc(100% + 8px);width:min(480px,76vw);padding:12px 14px;background:white;border:1px solid #cbd5e1;border-radius:10px;box-shadow:0 12px 28px rgba(15,23,42,.14);z-index:40;text-align:left;text-transform:none;font-weight:400;line-height:1.45;white-space:normal}
.tip-wrap:hover .tip-card,.tip-wrap:focus-within .tip-card{display:block}
.tip-q{font-size:.84rem;font-weight:600;color:var(--ink);margin-bottom:8px}
.tip-crit{padding:6px 9px;border-radius:6px;margin-top:6px;font-size:.78rem}
.tip-crit strong{display:block;font-size:.7rem;text-transform:uppercase;letter-spacing:.05em;margin-bottom:2px}
.tip-crit p{margin:0;color:var(--ink);white-space:pre-wrap}
.tip-pass{background:#f0fdf4;border-left:3px solid #16a34a}
.tip-pass strong{color:var(--green)}
.tip-fail{background:#fff7ed;border-left:3px solid #ea580c}
.tip-fail strong{color:var(--amber)}
.check-highlight td{background:#eff6ff!important}
footer{font-size:.8125rem;color:var(--muted);margin-top:26px}
[hidden]{display:none!important}
@media(max-width:960px){.kpi-strip{grid-template-columns:repeat(2,minmax(0,1fr))}.kpi{border-bottom:1px solid var(--line)}.cond-grid{grid-template-columns:1fr}.cond-metrics{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media print{body{background:white}main{max-width:none;padding:0}.filters,.view-switch,.tip-card{display:none!important}.panel,.task-card{break-inside:avoid}}
`;

const SCRIPT = `
const skillFilter=document.getElementById('skill-filter');
const targetFilter=document.getElementById('target-filter');
const freshnessFilter=document.getElementById('freshness-filter');
const searchInput=document.getElementById('check-search');
const matrixRows=[...document.querySelectorAll('.score-row')];
const cards=[...document.querySelectorAll('.task-card')];
function applyFilters(){
  const sk=skillFilter.value;
  const tg=targetFilter.value;
  const fr=freshnessFilter.value;
  const q=searchInput.value.trim().toLowerCase();
  let visible=0;
  for(const el of [...matrixRows,...cards]){
    const matchSkill=!sk||el.dataset.skill===sk;
    const matchTarget=!tg||el.dataset.target===tg;
    const matchFresh=!fr||el.dataset.freshness===fr;
    const matchQuery=!q||(el.dataset.checks||'').includes(q)||(el.dataset.taskName||'').includes(q);
    el.hidden=!(matchSkill&&matchTarget&&matchFresh&&matchQuery);
  }
  for(const row of matrixRows){if(!row.hidden)visible++;}
  for(const card of cards){
    const checkRows=[...card.querySelectorAll('tr[data-check-row]')];
    for(const cr of checkRows){
      const hit=Boolean(q)&&cr.dataset.checkRow.includes(q);
      cr.classList.toggle('check-highlight',hit);
    }
  }
  const countEl=document.getElementById('visible-count');
  if(countEl)countEl.textContent=visible+' of '+matrixRows.length+' rows';
}
for(const el of [skillFilter,targetFilter,freshnessFilter])el.addEventListener('change',applyFilters);
searchInput.addEventListener('input',applyFilters);
document.getElementById('expand-all').addEventListener('click',()=>{for(const card of cards)if(!card.hidden)card.open=true;});
document.getElementById('collapse-all').addEventListener('click',()=>{for(const card of cards)card.open=false;});
document.addEventListener('click',(event)=>{
  const jump=event.target&&event.target.closest&&event.target.closest('[data-jump]');
  if(jump){
    const target=document.getElementById(jump.dataset.jump);
    if(target){target.hidden=false;target.open=true;}
    return;
  }
  const viewBtn=event.target&&event.target.closest&&event.target.closest('[data-card-view]');
  if(viewBtn){
    const cardId=viewBtn.dataset.cardView;
    const mode=viewBtn.dataset.mode;
    for(const btn of document.querySelectorAll('[data-card-view="'+cardId+'"]')){
      const active=btn===viewBtn;
      btn.classList.toggle('active',active);
      btn.setAttribute('aria-selected',active?'true':'false');
    }
    for(const tbody of document.querySelectorAll('[data-card-tbody="'+cardId+'"]')){
      tbody.hidden=tbody.dataset.mode!==mode;
    }
  }
});
applyFilters();`;

/** Render a standalone interactive offline HTML scorecard dashboard from a ScorecardSnapshot. */
export function renderScorecardHtml(snapshot: ScorecardSnapshot): string {
  const skillsCovered = snapshot.skills.filter((s) => s.coverageStatus !== 'none').length;
  const harborSkills = snapshot.skills.filter((s) => s.coverageStatus === 'harbor_evals').length;
  const unitTestSkills = snapshot.skills.filter((s) => s.coverageStatus === 'unit_tests').length;
  const uncoveredSkills = snapshot.skills.length - skillsCovered;

  const totalHarborTasks = snapshot.skills.reduce((sum, s) => sum + s.harborTasks.length, 0);
  const recordedTasks = snapshot.scorecards.length;

  const totalEntries = snapshot.entries.length;
  const currentEntries = snapshot.entries.filter((e) => e.staleness.status === 'current').length;
  const staleEntries = totalEntries - currentEntries;

  const skillRows = snapshot.rows.filter((r) => r.skillEntry !== null);
  const meanSkillQuality = skillRows.length > 0
    ? skillRows.reduce((sum, r) => sum + r.skillEntry!.entry.quality.pass_rate, 0) / skillRows.length
    : null;
  const pairedRows = snapshot.rows.filter((r) => r.liftPassRate !== null);
  const meanLift = pairedRows.length > 0
    ? pairedRows.reduce((sum, r) => sum + r.liftPassRate!, 0) / pairedRows.length
    : null;

  // Gather worst failing checks across all skill entries (falling back to baseline if no skill entry).
  const failingChecks: Array<{ task: string; target: string; id: string; passRate: number; meanProb: number; passed: number; total: number }> = [];
  for (const row of snapshot.rows) {
    const primary = row.skillEntry ?? row.baseline;
    if (!primary) continue;
    for (const [id, stats] of Object.entries(primary.entry.quality.checks)) {
      if (stats.pass_rate < 1) {
        failingChecks.push({
          task: row.task,
          target: row.target,
          id,
          passRate: stats.pass_rate,
          meanProb: stats.mean_pass_probability,
          passed: stats.passed,
          total: stats.total,
        });
      }
    }
  }
  failingChecks.sort((a, b) =>
    a.passRate - b.passRate
    || a.meanProb - b.meanProb
    || compareCodepoint(a.task, b.task)
    || compareCodepoint(a.id, b.id),
  );
  const worstSummary = failingChecks.length > 0
    ? `${failingChecks[0].id} (${failingChecks[0].passed}/${failingChecks[0].total} on ${failingChecks[0].task})`
    : 'All recorded checks at 100%';

  const uniqueSkills = [...new Set(snapshot.rows.map((r) => r.skill))].sort(compareCodepoint);
  const { matrixHtml, cardsHtml } = renderMatrixAndCards(snapshot.rows);

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'">
<title>Eval Scorecard · agent-tooling</title><style>${STYLE}</style></head><body><main>
<header>
  <div class="title-row"><h1>Eval Scorecard</h1><span class="cond-badge cond-skill">Offline Dashboard</span></div>
  <div class="meta-bar">
    <span>Source <strong>evals/scorecards/**/*.json</strong></span>
    <span>Freshness <strong>Live working-tree content hashes</strong></span>
    <span>Baseline rule <strong>Ignores skill_hash</strong></span>
  </div>
</header>

<section class="kpi-strip" aria-label="Scorecard overview">
  <div class="kpi"><div class="kpi-label">Skills covered</div><div class="kpi-value">${skillsCovered}<span class="muted"> / ${snapshot.skills.length}</span></div><div class="kpi-note">${harborSkills} Harbor evals · ${unitTestSkills} unit tests · ${uncoveredSkills} none</div></div>
  <div class="kpi"><div class="kpi-label">Tasks evaluated</div><div class="kpi-value">${recordedTasks}<span class="muted"> / ${totalHarborTasks}</span></div><div class="kpi-note">${snapshot.rows.length} task/target rows · ${totalEntries} entries</div></div>
  <div class="kpi${staleEntries > 0 ? ' kpi-alert' : ''}"><div class="kpi-label">Freshness</div><div class="kpi-value ${staleEntries === 0 ? 'tone-good' : 'tone-warn'}">${currentEntries} current</div><div class="kpi-note">${staleEntries} stale against working tree</div></div>
  <div class="kpi"><div class="kpi-label">Mean skill quality</div><div class="kpi-value${scoreTone(meanSkillQuality)}">${pct(meanSkillQuality)}</div><div class="kpi-note">${pairedRows.length ? `Mean lift ${escape(liftPp(meanLift))} across ${pairedRows.length} paired rows` : 'No baseline pairs yet'}</div></div>
  <div class="kpi${failingChecks.length > 0 ? ' kpi-alert' : ''}"><div class="kpi-label">Checks &lt; 100%</div><div class="kpi-value ${failingChecks.length === 0 ? 'tone-good' : 'tone-warn'}">${failingChecks.length}</div><div class="kpi-note">${escape(worstSummary)}</div></div>
</section>

${renderCoveragePanel(snapshot.skills)}

<section class="panel">
  <div class="panel-head"><h2>Eval matrix</h2><span class="count" id="visible-count" aria-live="polite"></span></div>
  <div class="filters">
    <label class="field">Skill<select id="skill-filter"><option value="">All skills</option>${uniqueSkills.map((s) => `<option value="${escape(s)}">${escape(s)}</option>`).join('')}</select></label>
    <label class="field">Target<select id="target-filter"><option value="">All targets</option><option value="review">Review</option><option value="production_code">Production code</option><option value="test_code">Test code</option></select></label>
    <label class="field">Freshness<select id="freshness-filter"><option value="">All states</option><option value="current">Current</option><option value="stale">Stale</option></select></label>
    <label class="field">Search checks or tasks<input id="check-search" type="search" placeholder="e.g. dependency_inversion"></label>
    <button id="expand-all" type="button">Expand all</button>
    <button id="collapse-all" type="button">Collapse all</button>
  </div>
  ${snapshot.rows.length
    ? `<div class="table-scroll"><table><thead><tr><th>Task</th><th>Target</th><th>Reward</th><th>Baseline</th><th>Skill</th><th>Lift</th><th>Weakest check</th><th>Trials / Date</th><th>Status</th></tr></thead><tbody>${matrixHtml}</tbody></table></div>`
    : '<p class="muted">No scorecards recorded yet. Run <code>pnpm eval scorecard record &lt;judge-dir...&gt;</code>.</p>'}
</section>

<section>
  <div class="panel-head"><h2>Task &amp; check details</h2><span class="muted">Click any card to inspect Baseline vs Skill checks and hash provenance</span></div>
  ${cardsHtml || '<p class="muted">No recorded task cards to display.</p>'}
</section>

<footer>Self-contained offline dashboard built from checked-in <code>evals/scorecards/**/*.json</code> and live working-tree content hashes. No network requests or API calls were made.</footer>
</main><script>${SCRIPT}</script></body></html>`;
}

/** Build and write the standalone offline scorecard HTML dashboard (default: eval-results/scorecard.html). */
export function writeScorecardHtml(repoRoot: string, outputFile?: string): { path: string; snapshot: ScorecardSnapshot } {
  const output = outputFile ? resolve(outputFile) : join(repoRoot, 'eval-results/scorecard.html');
  if (extname(output).toLowerCase() !== '.html') {
    throw new Error('Scorecard HTML output must end in .html');
  }
  const snapshot = buildScorecardSnapshot(repoRoot);
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, renderScorecardHtml(snapshot));
  return { path: output, snapshot };
}
