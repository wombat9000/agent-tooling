#!/usr/bin/env node
/**
 * Static offline HTML dashboard generator (`pnpm rubrics:dashboard`).
 * Reads snapshot JSONs from <data>/runs/*.json and authoritative rubrics/*.json
 * to build a single-file interactive HTML dashboard with inline SVG charts.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import type { JudgeMode } from '../skills/judge-code/scripts/rubrics.mts';
import {
  REPO_ROOT,
  compareCodepoint,
  diffRubricHashes,
  equalStringRecords,
  escapeHtml,
  loadRubricCatalog,
  loadSnapshotsFromDir,
  safeJsonForScript,
  type CatalogCheckInfo,
  type FixtureCheckSnapshot,
  type InstalledSkillInfo,
  type LoadedSnapshotRecord,
  type RepoSnapshot,
  type RubricCatalog,
  type RubricFixturesSnapshot,
  type SnapshotCheckSummary,
  type SnapshotFileEntry,
} from './snapshot.mts';
import { AUTHORITATIVE_RUBRICS_DIR } from './sync.mts';

const USAGE = `Usage: node rubrics/dashboard.mts --data <dir> [--out <file.html>]

Build a self-contained offline HTML dashboard from rubric scanner snapshots.

  --data DIR     Private data directory containing runs/*.json (required)
  --out FILE     Output HTML path (default: <data>/index.html)
  --help, -h     Show this help
`;

export interface TrendPoint {
  id: string;
  file: string;
  timestamp: string;
  commit: string;
  commit_short: string;
  branch: string | null;
  dirty: boolean;
  file_count: number;
  target_count: number;
  check_count: number;
  calibrated_pass_rate: number;
  raw_pass_rate: number;
  all_files_pass_rate: number | null;
  mean_pass_probability: number | null;
  cost_usd: number | null;
  elapsed_ms: number;
  model: string;
  returned_model: string | null;
  judge_version: string;
  rubrics_digest: string;
  rubric_hashes: Record<string, string>;
  version_changed: boolean;
  change_reasons: string[];
  delta_calibrated: number | null;
  delta_raw: number | null;
  delta_mean_prob: number | null;
  checks: Record<string, SnapshotCheckSummary>;
  files: SnapshotFileEntry[];
}

export interface RepoModeSeries {
  repo: string;
  mode: JudgeMode;
  points: TrendPoint[];
  latest: TrendPoint;
  previous: TrendPoint | null;
  version_change_count: number;
  installed_judge_code: InstalledSkillInfo | null;
}

export interface RepoSummary {
  name: string;
  modes: JudgeMode[];
  installed_judge_code: InstalledSkillInfo | null;
  installed_status: 'current' | 'outdated' | 'unknown';
  latest_commit: string;
  latest_commit_short: string;
  latest_branch: string | null;
  latest_dirty: boolean;
  latest_timestamp: string;
  total_runs: number;
  total_cost_usd: number;
  by_mode: Partial<Record<JudgeMode, RepoModeSeries>>;
}

export interface HeatmapRow {
  check_id: string;
  rubric_slug: string | null;
  threshold: number;
  scope: string | null;
  instructions: string;
  pass_criteria: string;
  fail_criteria: string;
  by_repo: Record<string, {
    pass_rate: number;
    raw_pass_rate: number;
    passed: number;
    total: number;
    mean_pass_probability: number | null;
    min_pass_probability: number | null;
    threshold: number;
  }>;
  worst_pass_rate: number;
}

export interface FixtureTrendPoint {
  file: string;
  timestamp: string;
  judge_version: string;
  combined_hash: string;
  status: 'passed' | 'failed';
  fixtures_passed: number;
  fixtures_total: number;
  fixture_pass_rate: number;
  checks_passed: number;
  checks_total: number;
  check_pass_rate: number;
  min_margin: number | null;
  mean_margin: number | null;
  max_jitter: number | null;
  mean_jitter: number | null;
  repeats: number;
  cost_usd: number | null;
  elapsed_ms: number;
  version_changed: boolean;
  change_reasons: string[];
  checks: FixtureCheckSnapshot[];
}

export interface DashboardModel {
  generated_at: string;
  catalog: RubricCatalog;
  warnings: string[];
  repos: RepoSummary[];
  modes_present: JudgeMode[];
  heatmaps: Partial<Record<JudgeMode, { repos: string[]; rows: HeatmapRow[] }>>;
  fixtures: {
    points: FixtureTrendPoint[];
    latest: FixtureTrendPoint | null;
  };
  totals: {
    repo_count: number;
    repo_runs: number;
    fixture_runs: number;
    total_cost_usd: number;
    latest_calibrated_mean: number | null;
    latest_raw_mean: number | null;
    outdated_repos: number;
  };
}

function summarizeVersionChange(
  prev: { judge_version: string; rubric_hashes: Record<string, string> },
  curr: { judge_version: string; rubric_hashes: Record<string, string> },
): string[] {
  const reasons: string[] = [];
  if (prev.judge_version !== curr.judge_version) {
    reasons.push(`judge_version: ${prev.judge_version} -> ${curr.judge_version}`);
  }
  if (!equalStringRecords(prev.rubric_hashes, curr.rubric_hashes)) {
    const diff = diffRubricHashes(prev.rubric_hashes, curr.rubric_hashes);
    const parts: string[] = [];
    if (diff.modified.length > 0) parts.push(`updated ${diff.modified.join(', ')}`);
    if (diff.added.length > 0) parts.push(`added ${diff.added.join(', ')}`);
    if (diff.removed.length > 0) parts.push(`removed ${diff.removed.join(', ')}`);
    reasons.push(`rubrics: ${parts.join('; ')}`);
  }
  return reasons;
}

function sortHotspotFiles(files: SnapshotFileEntry[]): SnapshotFileEntry[] {
  return [...files].sort((a, b) =>
    (b.failed_count - a.failed_count)
    || ((a.min_pass_probability ?? 1) - (b.min_pass_probability ?? 1))
    || (a.pass_rate - b.pass_rate)
    || compareCodepoint(a.path, b.path),
  );
}

function classifyInstalledStatus(
  installed: InstalledSkillInfo | null,
  latestTag: string | null,
): 'current' | 'outdated' | 'unknown' {
  if (!installed?.ref || !latestTag) return 'unknown';
  return installed.ref === latestTag ? 'current' : 'outdated';
}

export function buildDashboardModel(options: {
  repoSnapshots: LoadedSnapshotRecord<RepoSnapshot>[];
  fixtureSnapshots: LoadedSnapshotRecord<RubricFixturesSnapshot>[];
  warnings?: string[];
  catalog: RubricCatalog;
  generatedAt?: string;
}): DashboardModel {
  const { repoSnapshots, fixtureSnapshots, catalog } = options;
  const warnings = options.warnings ?? [];
  const generatedAt = options.generatedAt ?? new Date().toISOString();

  // Group repo snapshots by repo name -> mode
  const grouped = new Map<string, Map<JudgeMode, LoadedSnapshotRecord<RepoSnapshot>[]>>();
  for (const record of repoSnapshots) {
    const repoName = record.snapshot.repo.name;
    const mode = record.snapshot.scan.mode;
    let byMode = grouped.get(repoName);
    if (!byMode) {
      byMode = new Map();
      grouped.set(repoName, byMode);
    }
    let list = byMode.get(mode);
    if (!list) {
      list = [];
      byMode.set(mode, list);
    }
    list.push(record);
  }

  const modeOrder: JudgeMode[] = ['file', 'structure', 'code'];
  const modesPresentSet = new Set<JudgeMode>();
  const repos: RepoSummary[] = [];

  for (const repoName of [...grouped.keys()].sort(compareCodepoint)) {
    const byModeMap = grouped.get(repoName)!;
    const modes = modeOrder.filter((m) => byModeMap.has(m));
    const byMode: Partial<Record<JudgeMode, RepoModeSeries>> = {};

    let latestOverall: RepoSnapshot | null = null;
    let totalRuns = 0;
    let totalCost = 0;

    for (const mode of modes) {
      modesPresentSet.add(mode);
      const records = byModeMap.get(mode)!;
      totalRuns += records.length;

      const points: TrendPoint[] = records.map((rec, idx) => {
        const snap = rec.snapshot;
        if (!latestOverall || compareCodepoint(snap.timestamp, latestOverall.timestamp) >= 0) {
          latestOverall = snap;
        }
        if (typeof snap.metrics.cost_usd === 'number' && Number.isFinite(snap.metrics.cost_usd)) {
          totalCost += snap.metrics.cost_usd;
        }
        const prev = idx > 0 ? records[idx - 1].snapshot : null;
        const changeReasons = prev ? summarizeVersionChange(prev, snap) : [];
        const versionChanged = changeReasons.length > 0;
        const deltaCalibrated = prev
          ? snap.metrics.calibrated_pass_rate - prev.metrics.calibrated_pass_rate
          : null;
        const deltaRaw = prev
          ? snap.metrics.raw_pass_rate - prev.metrics.raw_pass_rate
          : null;
        const deltaMeanProb = prev
          && typeof snap.metrics.mean_pass_probability === 'number'
          && typeof prev.metrics.mean_pass_probability === 'number'
          ? snap.metrics.mean_pass_probability - prev.metrics.mean_pass_probability
          : null;

        return {
          id: `${repoName}::${mode}::${idx}`,
          file: rec.file,
          timestamp: snap.timestamp,
          commit: snap.repo.commit,
          commit_short: snap.repo.commit_short,
          branch: snap.repo.branch,
          dirty: snap.repo.dirty,
          file_count: snap.metrics.file_count,
          target_count: snap.metrics.target_count,
          check_count: snap.metrics.check_count,
          calibrated_pass_rate: snap.metrics.calibrated_pass_rate,
          raw_pass_rate: snap.metrics.raw_pass_rate,
          all_files_pass_rate: snap.metrics.all_files_pass_rate ?? null,
          mean_pass_probability: snap.metrics.mean_pass_probability,
          cost_usd: snap.metrics.cost_usd,
          elapsed_ms: snap.metrics.elapsed_ms,
          model: snap.scan.model,
          returned_model: snap.scan.returned_model,
          judge_version: snap.judge_version,
          rubrics_digest: snap.rubrics_digest,
          rubric_hashes: snap.rubric_hashes,
          version_changed: versionChanged,
          change_reasons: changeReasons,
          delta_calibrated: deltaCalibrated,
          delta_raw: deltaRaw,
          delta_mean_prob: deltaMeanProb,
          checks: snap.checks,
          files: sortHotspotFiles(snap.files),
        };
      });

      const latest = points[points.length - 1];
      const previous = points.length >= 2 ? points[points.length - 2] : null;
      const latestSnap = records[records.length - 1].snapshot;
      byMode[mode] = {
        repo: repoName,
        mode,
        points,
        latest,
        previous,
        version_change_count: points.filter((p) => p.version_changed).length,
        installed_judge_code: latestSnap.repo.installed_judge_code,
      };
    }

    const latestRef = latestOverall!;
    const installed = latestRef.repo.installed_judge_code;
    repos.push({
      name: repoName,
      modes,
      installed_judge_code: installed,
      installed_status: classifyInstalledStatus(installed, catalog.agent_tooling.latest_tag),
      latest_commit: latestRef.repo.commit,
      latest_commit_short: latestRef.repo.commit_short,
      latest_branch: latestRef.repo.branch,
      latest_dirty: latestRef.repo.dirty,
      latest_timestamp: latestRef.timestamp,
      total_runs: totalRuns,
      total_cost_usd: totalCost,
      by_mode: byMode,
    });
  }

  const modesPresent = modeOrder.filter((m) => modesPresentSet.has(m));

  // Build per-mode cross-repo check heatmaps from the latest run of each repo
  const heatmaps: Partial<Record<JudgeMode, { repos: string[]; rows: HeatmapRow[] }>> = {};
  for (const mode of modesPresent) {
    const modeRepos = repos.filter((r) => r.by_mode[mode] !== undefined).map((r) => r.name);
    const checkIds = new Set<string>();
    for (const rName of modeRepos) {
      const latest = repos.find((r) => r.name === rName)!.by_mode[mode]!.latest;
      for (const cid of Object.keys(latest.checks)) checkIds.add(cid);
    }
    const rows: HeatmapRow[] = [...checkIds].map((checkId) => {
      const catalogInfo: CatalogCheckInfo | undefined = catalog.checks_by_id[checkId];
      const byRepo: HeatmapRow['by_repo'] = {};
      let worst = 1;
      let fallbackThreshold = 0.8;
      let fallbackGroup: string | null = null;
      for (const rName of modeRepos) {
        const check = repos.find((r) => r.name === rName)!.by_mode[mode]!.latest.checks[checkId];
        if (!check) continue;
        fallbackThreshold = check.threshold;
        if (check.rubric_group) fallbackGroup = check.rubric_group;
        byRepo[rName] = {
          pass_rate: check.pass_rate,
          raw_pass_rate: check.raw_pass_rate,
          passed: check.passed,
          total: check.total,
          mean_pass_probability: check.mean_pass_probability,
          min_pass_probability: check.min_pass_probability,
          threshold: check.threshold,
        };
        if (check.pass_rate < worst) worst = check.pass_rate;
      }
      return {
        check_id: checkId,
        rubric_slug: catalogInfo?.rubric_slug ?? fallbackGroup,
        threshold: catalogInfo?.pass_threshold ?? fallbackThreshold,
        scope: catalogInfo?.scope ?? null,
        instructions: catalogInfo?.instructions ?? '',
        pass_criteria: catalogInfo?.criteria.pass ?? '',
        fail_criteria: catalogInfo?.criteria.fail ?? '',
        by_repo: byRepo,
        worst_pass_rate: worst,
      };
    });
    rows.sort((a, b) => a.worst_pass_rate - b.worst_pass_rate || compareCodepoint(a.check_id, b.check_id));
    heatmaps[mode] = { repos: modeRepos, rows };
  }

  // Build fixture trend series
  let fixtureCost = 0;
  const fixturePoints: FixtureTrendPoint[] = fixtureSnapshots.map((rec, idx) => {
    const snap = rec.snapshot;
    if (typeof snap.metrics.cost_usd === 'number' && Number.isFinite(snap.metrics.cost_usd)) {
      fixtureCost += snap.metrics.cost_usd;
    }
    const prev = idx > 0 ? fixtureSnapshots[idx - 1].snapshot : null;
    const changeReasons = prev ? summarizeVersionChange(prev, snap) : [];
    if (prev && !equalStringRecords(prev.fixture_hashes, snap.fixture_hashes)) {
      const fDiff = diffRubricHashes(prev.fixture_hashes, snap.fixture_hashes);
      const changedCount = fDiff.added.length + fDiff.removed.length + fDiff.modified.length;
      if (changedCount > 0) changeReasons.push(`fixtures: ${changedCount} file(s) changed`);
    }
    return {
      file: rec.file,
      timestamp: snap.timestamp,
      judge_version: snap.judge_version,
      combined_hash: snap.combined_hash,
      status: snap.metrics.status,
      fixtures_passed: snap.metrics.fixtures_passed,
      fixtures_total: snap.metrics.fixtures_total,
      fixture_pass_rate: snap.metrics.fixture_pass_rate,
      checks_passed: snap.metrics.checks_passed,
      checks_total: snap.metrics.checks_total,
      check_pass_rate: snap.metrics.check_pass_rate,
      min_margin: snap.metrics.min_margin,
      mean_margin: snap.metrics.mean_margin,
      max_jitter: snap.metrics.max_jitter,
      mean_jitter: snap.metrics.mean_jitter,
      repeats: snap.scan.repeats,
      cost_usd: snap.metrics.cost_usd,
      elapsed_ms: snap.metrics.elapsed_ms,
      version_changed: changeReasons.length > 0,
      change_reasons: changeReasons,
      checks: snap.checks,
    };
  });

  // Aggregate latest calibrated/raw means across repo latest primary runs (prefer file, else structure/code)
  const latestPrimaries = repos
    .map((r) => r.by_mode.file?.latest ?? r.by_mode.structure?.latest ?? r.by_mode.code?.latest)
    .filter((p): p is TrendPoint => p !== undefined);
  const latestCalibratedMean = latestPrimaries.length > 0
    ? latestPrimaries.reduce((sum, p) => sum + p.calibrated_pass_rate, 0) / latestPrimaries.length
    : null;
  const latestRawMean = latestPrimaries.length > 0
    ? latestPrimaries.reduce((sum, p) => sum + p.raw_pass_rate, 0) / latestPrimaries.length
    : null;

  const totalCostUsd = repos.reduce((sum, r) => sum + r.total_cost_usd, 0) + fixtureCost;

  return {
    generated_at: generatedAt,
    catalog,
    warnings,
    repos,
    modes_present: modesPresent,
    heatmaps,
    fixtures: {
      points: fixturePoints,
      latest: fixturePoints.length > 0 ? fixturePoints[fixturePoints.length - 1] : null,
    },
    totals: {
      repo_count: repos.length,
      repo_runs: repoSnapshots.length,
      fixture_runs: fixtureSnapshots.length,
      total_cost_usd: totalCostUsd,
      latest_calibrated_mean: latestCalibratedMean,
      latest_raw_mean: latestRawMean,
      outdated_repos: repos.filter((r) => r.installed_status === 'outdated').length,
    },
  };
}

function pct(value: number | null | undefined, decimals = 1): string {
  return typeof value === 'number' && Number.isFinite(value) ? `${(value * 100).toFixed(decimals)}%` : '—';
}

function deltaPp(delta: number | null | undefined): string {
  if (typeof delta !== 'number' || !Number.isFinite(delta)) return '—';
  const pp = delta * 100;
  const rounded = Math.abs(pp) < 0.05 ? 0 : pp;
  const sign = rounded > 0 ? '+' : '';
  return `${sign}${rounded.toFixed(1)}pp`;
}

function fmtUsd(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  if (value === 0) return '$0.00';
  if (value < 0.01) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(3)}`;
}

function scoreTone(rate: number | null | undefined): string {
  if (typeof rate !== 'number' || !Number.isFinite(rate)) return '';
  if (rate >= 0.9) return ' tone-good';
  if (rate >= 0.75) return ' tone-warn';
  return ' tone-bad';
}

function renderInstalledBadge(repo: RepoSummary, latestTag: string | null): string {
  const inst = repo.installed_judge_code;
  if (!inst) return '<span class="pill neutral">not tracked</span>';
  const ref = inst.ref ?? (inst.computed_hash ? inst.computed_hash.slice(0, 8) : 'installed');
  if (repo.installed_status === 'current') {
    return `<span class="pill pass" title="Matches latest tag ${escapeHtml(latestTag ?? '')}">${escapeHtml(ref)} (current)</span>`;
  }
  if (repo.installed_status === 'outdated') {
    return `<span class="pill warn" title="Latest agent-tooling tag is ${escapeHtml(latestTag ?? '')}">${escapeHtml(ref)} &rarr; ${escapeHtml(latestTag ?? '')}</span>`;
  }
  return `<span class="pill neutral">${escapeHtml(ref)}</span>`;
}

function renderCatalogPanel(catalog: RubricCatalog): string {
  const rows = catalog.rubrics.map((r) => {
    const customThresholds = r.checks
      .filter((c) => Math.abs(c.pass_threshold - 0.8) > 1e-9)
      .map((c) => `${c.id} (&ge;${c.pass_threshold.toFixed(2)})`);
    return `<tr>
      <td><code>${escapeHtml(r.slug)}</code></td>
      <td><code>${escapeHtml(r.id)}</code></td>
      <td><span class="pill target-${escapeHtml(r.target)}">${escapeHtml(r.target)}</span></td>
      <td class="numeric">${r.checks.length}</td>
      <td>${customThresholds.length > 0 ? escapeHtml(customThresholds.join(', ')) : '<span class="muted">all &ge;0.80</span>'}</td>
      <td><code>${escapeHtml(r.sha256.slice(0, 12))}</code></td>
    </tr>`;
  }).join('');

  return `<details class="panel catalog-panel">
    <summary class="panel-summary">
      <span><strong>Authoritative rubric catalog</strong> (${catalog.rubrics.length} rubrics in <code>rubrics/*.json</code>)</span>
      <span class="muted numeric">agent-tooling ${escapeHtml(catalog.agent_tooling.judge_version)}${catalog.agent_tooling.latest_tag ? ` · latest tag ${escapeHtml(catalog.agent_tooling.latest_tag)}` : ''}</span>
    </summary>
    <div class="table-scroll" style="margin-top:12px">
      <table>
        <thead><tr><th>Slug</th><th>Rubric ID</th><th>Target</th><th>Checks</th><th>Custom thresholds</th><th>SHA-256</th></tr></thead>
        <tbody>${rows || '<tr><td colspan="6" class="muted">No authoritative rubrics found.</td></tr>'}</tbody>
      </table>
    </div>
  </details>`;
}

const STYLE = `
:root{color-scheme:light;--ink:#16243b;--muted:#5c687b;--line:#dce3ed;--bg:#f4f6fa;--surface:#ffffff;--blue:#3158cf;--teal:#0d9488;--purple:#7c3aed;--green:#116547;--green-bg:#e7f6ee;--amber:#9a3412;--amber-bg:#ffedd5;--red:#b91c1c;--red-bg:#fee2e2}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:14.5px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
main{max-width:1420px;margin:0 auto;padding:22px 26px 64px}
header{border-top:3px solid var(--blue);padding:12px 0 18px}
.title-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
h1{font-size:1.6rem;line-height:1.2;letter-spacing:-.03em;margin:0}
h2{font-size:1.1rem;margin:0}
h3{font-size:.95rem;margin:0}
p{margin:6px 0}
code{font:500 .84em/1.4 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;background:#f1f5f9;padding:1px 5px;border-radius:4px}
.muted{color:var(--muted)}
.numeric{font-variant-numeric:tabular-nums;white-space:nowrap}
.meta-bar{display:flex;flex-wrap:wrap;gap:6px 18px;margin-top:8px;font-size:.82rem;color:var(--muted)}
.meta-bar strong{color:var(--ink);font-weight:600}
.kpi-strip,.panel{background:var(--surface);border:1px solid var(--line);border-radius:12px}
.kpi-strip{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));margin-bottom:18px;overflow:hidden}
.kpi{padding:14px 16px;border-right:1px solid var(--line)}
.kpi:last-child{border-right:0}
.kpi-alert{background:#fff8f1}
.kpi-label{color:var(--muted);font-size:.73rem;font-weight:700;text-transform:uppercase;letter-spacing:.04em}
.kpi-value{font-size:1.5rem;font-weight:700;letter-spacing:-.03em;line-height:1.25;margin:3px 0}
.kpi-note{font-size:.77rem;color:var(--muted);line-height:1.35}
.tone-good{color:var(--green)}
.tone-warn{color:var(--amber)}
.tone-bad{color:var(--red)}
.panel{padding:18px 20px;margin-bottom:18px}
.panel-head{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:14px}
.panel-summary{display:flex;align-items:center;justify-content:space-between;gap:12px;cursor:pointer;list-style:none;flex-wrap:wrap}
.panel-summary::-webkit-details-marker{display:none}
.panel-summary::before{content:'+ ';color:var(--blue);font-weight:700}
details[open]>.panel-summary::before{content:'− '}
.badge,.pill,.chip{display:inline-flex;align-items:center;gap:4px;border-radius:5px;font-weight:600;white-space:nowrap}
.badge{padding:2px 8px;font-size:.76rem;line-height:1.4}
.pill{padding:2px 7px;font-size:.74rem;line-height:1.35}
.chip{padding:2px 7px;font-size:.74rem;background:#eef2f7;color:var(--ink);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-weight:500}
.pill-header{padding:3px 9px;border-radius:999px;font-size:.71rem;font-weight:700;letter-spacing:.05em;text-transform:uppercase;background:#e0e7ff;color:#1e40af}
.pass{color:var(--green);background:var(--green-bg)}
.warn{color:var(--amber);background:var(--amber-bg)}
.fail{color:var(--red);background:var(--red-bg)}
.neutral{color:var(--muted);background:#eef1f6}
.target-production_code{background:#e0e7ff;color:#1e40af}
.target-project_structure{background:#f3e8ff;color:#6b21a8}
.target-test_code{background:#dcfce7;color:#166534}
.target-review{background:#fef3c7;color:#92400e}
.table-scroll{overflow-x:auto}
table{width:100%;border-collapse:collapse;text-align:left}
th{font-size:.76rem;color:var(--muted);font-weight:600;white-space:nowrap;border-bottom:1px solid var(--line)}
th,td{padding:8px 10px;border-bottom:1px solid var(--line);vertical-align:middle}
th:first-child,td:first-child{padding-left:0}
tbody tr:last-child td{border-bottom:0}
.tabs{display:inline-flex;background:#f1f5f9;border:1px solid var(--line);border-radius:8px;padding:2px;gap:2px;flex-wrap:wrap}
.tab-btn{border:0;background:transparent;color:var(--muted);font:inherit;font-size:.82rem;font-weight:600;padding:5px 11px;border-radius:6px;cursor:pointer}
.tab-btn:hover{color:var(--ink);background:rgba(255,255,255,.6)}
.tab-btn.active{background:#fff;color:var(--ink);box-shadow:0 1px 2px rgba(15,23,42,.08)}
.controls{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:12px}
input[type=search],select{font:inherit;font-size:.84rem;color:var(--ink);background:#fff;border:1px solid #b8c5d8;border-radius:7px;padding:6px 10px;min-height:34px}
input[type=search]{min-width:210px}
label.toggle{display:inline-flex;align-items:center;gap:6px;font-size:.82rem;color:var(--muted);cursor:pointer;user-select:none}
.repo-row{cursor:pointer}
.repo-row:hover td{background:#f8faff}
.repo-row.selected td{background:#eff4ff}
.chart-box{border:1px solid var(--line);border-radius:10px;padding:12px 14px;background:#fcfdff;margin-bottom:16px}
.chart-legend{display:flex;flex-wrap:wrap;gap:14px;align-items:center;font-size:.78rem;color:var(--muted);margin-bottom:8px}
.legend-item{display:inline-flex;align-items:center;gap:6px}
.legend-swatch{display:inline-block;width:16px;height:3px;border-radius:2px}
.legend-swatch.dashed{background:repeating-linear-gradient(90deg,var(--teal) 0 5px,transparent 5px 8px)}
.legend-swatch.dotted{background:repeating-linear-gradient(90deg,var(--purple) 0 2px,transparent 2px 5px)}
.legend-marker{display:inline-block;width:9px;height:9px;transform:rotate(45deg);background:#f59e0b;border:1px solid #b45309}
.svg-wrap{width:100%;overflow-x:auto}
svg.trend-svg{display:block;width:100%;max-width:100%;height:auto}
.chart-point{cursor:pointer}
.chart-point:hover{stroke-width:3}
.split-grid{display:grid;grid-template-columns:1.2fr 1fr;gap:16px;align-items:start}
.sub-card{border:1px solid var(--line);border-radius:10px;padding:14px 16px;background:#fcfdff}
.bar-wrap{display:flex;align-items:center;gap:7px;min-width:118px}
.bar-track{width:56px;height:7px;background:#e6ecf5;border-radius:999px;overflow:hidden;flex-shrink:0}
.bar-fill{height:100%;border-radius:999px}
.heat-cell{display:inline-flex;flex-direction:column;align-items:flex-end;gap:1px;padding:4px 8px;border-radius:6px;min-width:86px;font-variant-numeric:tabular-nums}
.heat-cell strong{font-size:.82rem;line-height:1.2}
.heat-cell span{font-size:.71rem;opacity:.85}
.fail-chips{display:flex;flex-wrap:wrap;gap:4px}
.fail-chip{display:inline-flex;align-items:center;gap:4px;padding:1px 6px;border-radius:4px;font-size:.73rem;background:#fff1f2;color:#9f1239;border:1px solid #fecdd3;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.version-banner{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:8px 12px;border-radius:8px;background:#fffbeb;border:1px solid #fde68a;color:#92400e;font-size:.82rem;margin-bottom:12px}
.warn-banner{padding:10px 14px;border-radius:8px;background:#fff7ed;border:1px solid #fed7aa;color:#9a3412;font-size:.82rem;margin-bottom:14px}
.run-row{cursor:pointer}
.run-row:hover td{background:#f8faff}
.run-row.active-run td{background:#eff4ff}
.tip-wrap{position:relative;display:inline-flex;align-items:center}
.tip-trigger{border-bottom:1px dotted #94a3b8;cursor:help}
.tip-card{display:none;position:absolute;left:0;top:calc(100% + 6px);width:min(440px,74vw);padding:10px 12px;background:#fff;border:1px solid #cbd5e1;border-radius:9px;box-shadow:0 10px 24px rgba(15,23,42,.14);z-index:50;white-space:normal;font-weight:400;line-height:1.4}
.tip-wrap:hover .tip-card,.tip-wrap:focus-within .tip-card{display:block}
.tip-pass{background:#f0fdf4;border-left:3px solid #16a34a;padding:5px 8px;border-radius:5px;margin-top:6px;font-size:.77rem}
.tip-fail{background:#fff7ed;border-left:3px solid #ea580c;padding:5px 8px;border-radius:5px;margin-top:5px;font-size:.77rem}
.empty-state{padding:24px 16px;text-align:center;color:var(--muted);border:1px dashed var(--line);border-radius:10px;background:#fafbfd}
footer{font-size:.8rem;color:var(--muted);margin-top:24px}
[hidden]{display:none!important}
@media(max-width:1024px){.kpi-strip{grid-template-columns:repeat(2,minmax(0,1fr))}.kpi{border-bottom:1px solid var(--line)}.split-grid{grid-template-columns:1fr}}
`;

const CLIENT_SCRIPT = `
(function(){
  const rawEl = document.getElementById('dashboard-data');
  if (!rawEl) return;
  const DATA = JSON.parse(rawEl.textContent || '{}');

  function esc(v) {
    return String(v ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }
  function pct(v, d = 1) {
    return typeof v === 'number' && Number.isFinite(v) ? (v * 100).toFixed(d) + '%' : '—';
  }
  function deltaPp(v) {
    if (typeof v !== 'number' || !Number.isFinite(v)) return '—';
    const pp = v * 100;
    const r = Math.abs(pp) < 0.05 ? 0 : pp;
    return (r > 0 ? '+' : '') + r.toFixed(1) + 'pp';
  }
  function fmtUsd(v) {
    if (typeof v !== 'number' || !Number.isFinite(v)) return '—';
    if (v === 0) return '$0.00';
    return v < 0.01 ? '$' + v.toFixed(4) : '$' + v.toFixed(3);
  }
  function shortDate(ts) {
    if (!ts) return '—';
    return ts.replace('T', ' ').slice(0, 16) + 'Z';
  }
  function barColor(rate) {
    if (rate >= 0.9) return '#15803d';
    if (rate >= 0.75) return '#ca8a04';
    return '#dc2626';
  }
  function heatColors(rate) {
    if (rate >= 0.95) return { bg: '#dcfce7', fg: '#14532d' };
    if (rate >= 0.85) return { bg: '#ecfccb', fg: '#365314' };
    if (rate >= 0.7) return { bg: '#fef9c3', fg: '#713f12' };
    if (rate >= 0.5) return { bg: '#ffedd5', fg: '#9a3412' };
    return { bg: '#fee2e2', fg: '#991b1b' };
  }
  function scoreBar(rate) {
    if (typeof rate !== 'number' || !Number.isFinite(rate)) return '<span class="muted">—</span>';
    const w = Math.max(0, Math.min(100, Math.round(rate * 100)));
    return '<div class="bar-wrap"><div class="bar-track"><div class="bar-fill" style="width:' + w + '%;background:' + barColor(rate) + '"></div></div><span class="numeric">' + pct(rate) + '</span></div>';
  }

  let selectedRepo = DATA.repos && DATA.repos.length > 0 ? DATA.repos[0].name : null;
  let selectedMode = null;
  let selectedRunIdx = null;
  let heatmapMode = DATA.modes_present && DATA.modes_present.length > 0 ? DATA.modes_present[0] : 'file';
  let fileSearch = '';
  let failingOnly = true;
  let heatSearch = '';
  let heatGroup = '';

  function ensureSelection() {
    if (!DATA.repos || DATA.repos.length === 0) return null;
    let repoObj = DATA.repos.find((r) => r.name === selectedRepo) || DATA.repos[0];
    selectedRepo = repoObj.name;
    if (!selectedMode || !repoObj.by_mode[selectedMode]) {
      selectedMode = repoObj.modes[0] || null;
    }
    const series = selectedMode ? repoObj.by_mode[selectedMode] : null;
    if (!series) return { repoObj, series: null, run: null };
    if (selectedRunIdx === null || selectedRunIdx < 0 || selectedRunIdx >= series.points.length) {
      selectedRunIdx = series.points.length - 1;
    }
    return { repoObj, series, run: series.points[selectedRunIdx] };
  }

  function renderTrendSvg(points, activeIdx) {
    const W = 820, H = 225, padL = 48, padR = 24, padT = 22, padB = 34;
    const plotW = W - padL - padR;
    const plotH = H - padT - padB;
    const xAt = (i) => points.length <= 1 ? padL + plotW / 2 : padL + (i / (points.length - 1)) * plotW;
    const yAt = (v) => padT + (1 - Math.max(0, Math.min(1, v))) * plotH;

    const gridLines = [0, 0.25, 0.5, 0.75, 1].map((g) => {
      const y = yAt(g).toFixed(1);
      return '<line x1="' + padL + '" y1="' + y + '" x2="' + (W - padR) + '" y2="' + y + '" stroke="#e2e8f0" stroke-width="1"/>'
        + '<text x="' + (padL - 8) + '" y="' + (Number(y) + 4) + '" text-anchor="end" font-size="11" fill="#64748b">' + Math.round(g * 100) + '%</text>';
    }).join('');

    const versionLines = points.map((p, i) => {
      if (!p.version_changed) return '';
      const x = xAt(i).toFixed(1);
      const label = esc(p.change_reasons.join(' | '));
      return '<g><line x1="' + x + '" y1="' + padT + '" x2="' + x + '" y2="' + (H - padB) + '" stroke="#f59e0b" stroke-width="1.5" stroke-dasharray="4 3"/>'
        + '<polygon points="' + x + ',' + (padT - 7) + ' ' + (Number(x) + 5) + ',' + (padT - 2) + ' ' + x + ',' + (padT + 3) + ' ' + (Number(x) - 5) + ',' + (padT - 2) + '" fill="#f59e0b" stroke="#b45309" stroke-width="1"><title>Rubric / judge change: ' + label + '</title></polygon></g>';
    }).join('');

    const polyline = (getter, stroke, dash) => {
      const coords = points
        .map((p, i) => {
          const val = getter(p);
          return typeof val === 'number' && Number.isFinite(val) ? xAt(i).toFixed(1) + ',' + yAt(val).toFixed(1) : null;
        })
        .filter(Boolean);
      if (coords.length < 2) return '';
      return '<polyline fill="none" stroke="' + stroke + '" stroke-width="2.2" ' + (dash ? 'stroke-dasharray="' + dash + '"' : '') + ' points="' + coords.join(' ') + '"/>';
    };

    const dots = points.map((p, i) => {
      const x = xAt(i).toFixed(1);
      const yc = yAt(p.calibrated_pass_rate).toFixed(1);
      const yr = yAt(p.raw_pass_rate).toFixed(1);
      const ym = typeof p.mean_pass_probability === 'number' ? yAt(p.mean_pass_probability).toFixed(1) : null;
      const isActive = i === activeIdx;
      const tip = esc(
        shortDate(p.timestamp) + ' · ' + p.commit_short + (p.dirty ? ' (dirty)' : '')
        + '\\nCalibrated: ' + pct(p.calibrated_pass_rate)
        + ' | Raw: ' + pct(p.raw_pass_rate)
        + ' | Mean P(pass): ' + pct(p.mean_pass_probability)
        + (p.version_changed ? '\\nVersion change: ' + p.change_reasons.join('; ') : '')
      );
      return '<g class="chart-point" data-select-run="' + i + '">'
        + (isActive ? '<line x1="' + x + '" y1="' + padT + '" x2="' + x + '" y2="' + (H - padB) + '" stroke="#3158cf" stroke-opacity="0.25" stroke-width="10"/>' : '')
        + '<circle cx="' + x + '" cy="' + yr + '" r="' + (isActive ? 4.5 : 3.2) + '" fill="#0d9488" stroke="#fff" stroke-width="1"><title>' + tip + '</title></circle>'
        + (ym !== null ? '<circle cx="' + x + '" cy="' + ym + '" r="' + (isActive ? 4.2 : 3) + '" fill="#7c3aed" stroke="#fff" stroke-width="1"><title>' + tip + '</title></circle>' : '')
        + '<circle cx="' + x + '" cy="' + yc + '" r="' + (isActive ? 6 : 4.2) + '" fill="#3158cf" stroke="#fff" stroke-width="1.5"><title>' + tip + '</title></circle>'
        + '</g>';
    }).join('');

    const step = Math.max(1, Math.ceil(points.length / 6));
    const xLabels = points.map((p, i) => {
      if (i !== 0 && i !== points.length - 1 && i % step !== 0) return '';
      const x = xAt(i).toFixed(1);
      return '<text x="' + x + '" y="' + (H - 10) + '" text-anchor="middle" font-size="10.5" fill="#64748b">' + esc(p.timestamp.slice(5, 10) + ' ' + p.commit_short) + '</text>';
    }).join('');

    return '<svg class="trend-svg" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Score trend chart">'
      + gridLines
      + versionLines
      + polyline((p) => p.raw_pass_rate, '#0d9488', '6 3')
      + polyline((p) => p.mean_pass_probability, '#7c3aed', '2 4')
      + polyline((p) => p.calibrated_pass_rate, '#3158cf', '')
      + dots
      + xLabels
      + '</svg>';
  }

  function renderFixtureTrendSvg(points) {
    const W = 820, H = 195, padL = 48, padR = 24, padT = 20, padB = 32;
    const plotW = W - padL - padR;
    const plotH = H - padT - padB;
    const xAt = (i) => points.length <= 1 ? padL + plotW / 2 : padL + (i / (points.length - 1)) * plotW;
    const yAt = (v) => padT + (1 - Math.max(0, Math.min(1, v))) * plotH;

    const grid = [0, 0.5, 1].map((g) => {
      const y = yAt(g).toFixed(1);
      return '<line x1="' + padL + '" y1="' + y + '" x2="' + (W - padR) + '" y2="' + y + '" stroke="#e2e8f0" stroke-width="1"/>'
        + '<text x="' + (padL - 8) + '" y="' + (Number(y) + 4) + '" text-anchor="end" font-size="11" fill="#64748b">' + Math.round(g * 100) + '%</text>';
    }).join('');

    const line = (getter, stroke, dash) => {
      const coords = points.map((p, i) => {
        const val = getter(p);
        return typeof val === 'number' && Number.isFinite(val) ? xAt(i).toFixed(1) + ',' + yAt(val).toFixed(1) : null;
      }).filter(Boolean);
      if (coords.length < 2) return '';
      return '<polyline fill="none" stroke="' + stroke + '" stroke-width="2" ' + (dash ? 'stroke-dasharray="' + dash + '"' : '') + ' points="' + coords.join(' ') + '"/>';
    };

    const dots = points.map((p, i) => {
      const x = xAt(i).toFixed(1);
      const yPass = yAt(p.check_pass_rate).toFixed(1);
      const yJit = typeof p.max_jitter === 'number' ? yAt(p.max_jitter).toFixed(1) : null;
      const tip = esc(shortDate(p.timestamp) + ' · ' + p.judge_version + '\\nChecks passed: ' + p.checks_passed + '/' + p.checks_total + ' (' + pct(p.check_pass_rate) + ')\\nMin margin: ' + (p.min_margin !== null ? p.min_margin.toFixed(3) : '—') + ' | Max jitter: ' + (p.max_jitter !== null ? p.max_jitter.toFixed(3) : '—'));
      return (p.version_changed ? '<line x1="' + x + '" y1="' + padT + '" x2="' + x + '" y2="' + (H - padB) + '" stroke="#f59e0b" stroke-width="1.3" stroke-dasharray="4 3"/>' : '')
        + (yJit !== null ? '<circle cx="' + x + '" cy="' + yJit + '" r="3.5" fill="#ea580c" stroke="#fff" stroke-width="1"><title>' + tip + '</title></circle>' : '')
        + '<circle cx="' + x + '" cy="' + yPass + '" r="4.5" fill="#15803d" stroke="#fff" stroke-width="1.5"><title>' + tip + '</title></circle>';
    }).join('');

    const step = Math.max(1, Math.ceil(points.length / 6));
    const labels = points.map((p, i) => {
      if (i !== 0 && i !== points.length - 1 && i % step !== 0) return '';
      return '<text x="' + xAt(i).toFixed(1) + '" y="' + (H - 10) + '" text-anchor="middle" font-size="10.5" fill="#64748b">' + esc(p.timestamp.slice(5, 10) + ' ' + p.judge_version) + '</text>';
    }).join('');

    return '<svg class="trend-svg" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Rubric fixture health trend">'
      + grid
      + line((p) => p.check_pass_rate, '#15803d', '')
      + line((p) => p.max_jitter, '#ea580c', '4 3')
      + dots + labels + '</svg>';
  }

  function renderRepoDetail() {
    const container = document.getElementById('repo-detail-root');
    if (!container) return;
    const sel = ensureSelection();
    if (!sel || !sel.series || !sel.run) {
      container.innerHTML = '<div class="empty-state">No repository snapshots recorded yet. Run <code>pnpm rubrics:scan --config &lt;config.json&gt;</code> to populate snapshots.</div>';
      return;
    }
    const { repoObj, series, run } = sel;

    // Highlight overview table row
    document.querySelectorAll('.repo-row').forEach((tr) => {
      tr.classList.toggle('selected', tr.dataset.repo === repoObj.name);
    });

    const repoTabs = DATA.repos.map((r) =>
      '<button type="button" class="tab-btn' + (r.name === repoObj.name ? ' active' : '') + '" data-pick-repo="' + esc(r.name) + '">' + esc(r.name) + '</button>'
    ).join('');
    const modeTabs = repoObj.modes.map((m) =>
      '<button type="button" class="tab-btn' + (m === selectedMode ? ' active' : '') + '" data-pick-mode="' + esc(m) + '">' + esc(m) + ' (' + repoObj.by_mode[m].points.length + ')</button>'
    ).join('');

    const versionBanner = run.version_changed
      ? '<div class="version-banner"><strong>Rubric / judge change at this run:</strong> ' + esc(run.change_reasons.join(' · ')) + ' <span class="muted">(deltas vs previous run reflect rubric/judge changes as well as code changes)</span></div>'
      : '';

    const filteredFiles = run.files.filter((f) => {
      if (failingOnly && selectedMode === 'file' && f.failed_count === 0) return false;
      if (fileSearch) {
        const q = fileSearch.toLowerCase();
        const failedIds = Object.keys(f.checks).filter((k) => f.checks[k].choice === 'fail').join(' ').toLowerCase();
        return f.path.toLowerCase().includes(q) || failedIds.includes(q);
      }
      return true;
    });

    const hotspotRows = filteredFiles.slice(0, 40).map((f) => {
      const failedChecks = Object.entries(f.checks)
        .filter(([, c]) => c.choice === 'fail')
        .sort((a, b) => (a[1].pass_probability ?? 0) - (b[1].pass_probability ?? 0));
      const chips = failedChecks.length > 0
        ? '<div class="fail-chips">' + failedChecks.map(([cid, c]) => {
            const thr = run.checks[cid] ? run.checks[cid].threshold : 0.8;
            const pText = typeof c.pass_probability === 'number' ? c.pass_probability.toFixed(2) : 'fail';
            return '<span class="fail-chip" title="Threshold &ge; ' + thr.toFixed(2) + '">' + esc(cid) + ' (' + pText + ')</span>';
          }).join('') + '</div>'
        : '<span class="pill pass">all checks passed</span>';
      return '<tr>'
        + '<td><code>' + esc(f.path) + '</code></td>'
        + '<td class="numeric">' + (f.failed_count > 0 ? '<span class="pill fail">' + f.failed_count + '</span>' : '<span class="pill pass">0</span>') + '</td>'
        + '<td>' + scoreBar(f.pass_rate) + '</td>'
        + '<td class="numeric">' + (typeof f.min_pass_probability === 'number' ? f.min_pass_probability.toFixed(2) : '—') + '</td>'
        + '<td>' + chips + '</td>'
        + '</tr>';
    }).join('');

    const checkEntries = Object.entries(run.checks).sort((a, b) =>
      (a[1].pass_rate - b[1].pass_rate)
      || ((a[1].mean_pass_probability ?? 1) - (b[1].mean_pass_probability ?? 1))
      || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)
    );
    const checkRows = checkEntries.map(([cid, c]) => {
      const cat = DATA.catalog && DATA.catalog.checks_by_id ? DATA.catalog.checks_by_id[cid] : null;
      const label = cat
        ? '<span class="tip-wrap"><span class="tip-trigger" tabindex="0">' + esc(cid) + '</span><div class="tip-card"><strong>' + esc(cat.instructions) + '</strong><div class="tip-pass"><strong>Pass:</strong> ' + esc(cat.criteria.pass) + '</div><div class="tip-fail"><strong>Fail:</strong> ' + esc(cat.criteria.fail) + '</div></div></span>'
        : '<code>' + esc(cid) + '</code>';
      const thrBadge = Math.abs(c.threshold - 0.8) > 1e-9
        ? '<span class="pill warn">&ge;' + c.threshold.toFixed(2) + '</span>'
        : '<span class="pill neutral">&ge;' + c.threshold.toFixed(2) + '</span>';
      return '<tr>'
        + '<td>' + label + (c.rubric_group ? ' <span class="muted" style="font-size:.75rem">' + esc(c.rubric_group) + '</span>' : '') + '</td>'
        + '<td class="numeric">' + thrBadge + '</td>'
        + '<td class="numeric">' + c.passed + '/' + c.total + '</td>'
        + '<td>' + scoreBar(c.pass_rate) + '</td>'
        + '<td class="numeric">' + pct(c.raw_pass_rate) + '</td>'
        + '<td class="numeric">' + pct(c.mean_pass_probability) + '</td>'
        + '</tr>';
    }).join('');

    const runRows = [...series.points].reverse().map((p, revIdx) => {
      const idx = series.points.length - 1 - revIdx;
      const dClass = p.delta_calibrated === null ? 'neutral' : p.delta_calibrated > 0.005 ? 'pass' : p.delta_calibrated < -0.005 ? 'fail' : 'neutral';
      return '<tr class="run-row' + (idx === selectedRunIdx ? ' active-run' : '') + '" data-select-run="' + idx + '">'
        + '<td class="numeric">' + esc(shortDate(p.timestamp)) + '</td>'
        + '<td><code>' + esc(p.commit_short) + '</code>' + (p.dirty ? ' <span class="pill warn">dirty</span>' : '') + (p.branch ? ' <span class="muted">' + esc(p.branch) + '</span>' : '') + '</td>'
        + '<td class="numeric">' + p.file_count + '</td>'
        + '<td class="numeric"><strong>' + pct(p.calibrated_pass_rate) + '</strong></td>'
        + '<td class="numeric">' + pct(p.raw_pass_rate) + '</td>'
        + '<td class="numeric">' + pct(p.mean_pass_probability) + '</td>'
        + '<td class="numeric"><span class="pill ' + dClass + '">' + esc(deltaPp(p.delta_calibrated)) + '</span>' + (p.version_changed ? ' <span class="pill warn" title="' + esc(p.change_reasons.join('; ')) + '">rubric &Delta;</span>' : '') + '</td>'
        + '<td><code>' + esc(p.judge_version) + '</code></td>'
        + '<td class="numeric">' + esc(fmtUsd(p.cost_usd)) + '</td>'
        + '</tr>';
    }).join('');

    container.innerHTML =
      '<div class="controls">'
      + '<div class="tabs" role="tablist" aria-label="Select repository">' + repoTabs + '</div>'
      + '<div class="tabs" role="tablist" aria-label="Select mode">' + modeTabs + '</div>'
      + '<span class="muted numeric" style="margin-left:auto">Inspecting run ' + (selectedRunIdx + 1) + ' of ' + series.points.length + ' · ' + esc(run.model) + '</span>'
      + '</div>'
      + '<div class="chart-box">'
      + '<div class="chart-legend">'
      + '<span class="legend-item"><span class="legend-swatch" style="background:#3158cf"></span>Calibrated pass rate</span>'
      + '<span class="legend-item"><span class="legend-swatch dashed"></span>Raw pass rate (model choice)</span>'
      + '<span class="legend-item"><span class="legend-swatch dotted"></span>Mean P(pass)</span>'
      + '<span class="legend-item"><span class="legend-marker"></span>Judge or rubric hash changed</span>'
      + '<span class="muted" style="margin-left:auto">Click any point or history row to inspect</span>'
      + '</div>'
      + '<div class="svg-wrap">' + renderTrendSvg(series.points, selectedRunIdx) + '</div>'
      + '</div>'
      + versionBanner
      + '<div class="split-grid">'
      + '<div class="sub-card">'
      + '<div class="panel-head"><h3>Hotspot files (' + filteredFiles.length + ' shown / ' + run.files.length + ' total)</h3>'
      + '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">'
      + '<input type="search" id="file-search-input" placeholder="Filter file or check..." value="' + esc(fileSearch) + '">'
      + '<label class="toggle"><input type="checkbox" id="failing-only-toggle"' + (failingOnly ? ' checked' : '') + '> Failing only</label>'
      + '</div></div>'
      + (filteredFiles.length > 0
        ? '<div class="table-scroll"><table><thead><tr><th>File / Target</th><th>Failed</th><th>Calibrated</th><th>Min P</th><th>Failing checks</th></tr></thead><tbody>' + hotspotRows + '</tbody></table></div>'
        : '<p class="muted">' + (failingOnly && selectedMode === 'file' && !fileSearch && run.files.length > 0
          ? 'All ' + run.files.length + ' file(s) passed every check. Uncheck "Failing only" to inspect all files.'
          : 'No files match the current filter.') + '</p>')
      + '</div>'
      + '<div class="sub-card">'
      + '<div class="panel-head"><h3>Per-check breakdown (' + checkEntries.length + ')</h3><span class="muted numeric">' + esc(shortDate(run.timestamp)) + ' · ' + esc(run.commit_short) + '</span></div>'
      + '<div class="table-scroll"><table><thead><tr><th>Check</th><th>Threshold</th><th>Passed</th><th>Calibrated</th><th>Raw</th><th>Mean P</th></tr></thead><tbody>' + checkRows + '</tbody></table></div>'
      + '</div>'
      + '</div>'
      + '<details style="margin-top:14px"' + (series.points.length <= 10 ? ' open' : '') + '>'
      + '<summary class="panel-summary" style="font-size:.9rem"><span><strong>Run history</strong> (' + series.points.length + ' snapshots)</span></summary>'
      + '<div class="table-scroll" style="margin-top:8px"><table><thead><tr><th>Timestamp</th><th>Commit / Branch</th><th>Files</th><th>Calibrated</th><th>Raw</th><th>Mean P</th><th>Delta</th><th>Judge version</th><th>Cost</th></tr></thead><tbody>' + runRows + '</tbody></table></div>'
      + '</details>';
  }

  function renderHeatmap() {
    const container = document.getElementById('heatmap-root');
    if (!container) return;
    const modes = DATA.modes_present || [];
    if (modes.length === 0) {
      container.innerHTML = '<div class="empty-state">No runs available for cross-repo comparison yet.</div>';
      return;
    }
    if (!DATA.heatmaps[heatmapMode]) heatmapMode = modes[0];
    const map = DATA.heatmaps[heatmapMode];
    const groups = [...new Set(map.rows.map((r) => r.rubric_slug).filter(Boolean))].sort();
    const visibleRows = map.rows.filter((r) => {
      if (heatGroup && r.rubric_slug !== heatGroup) return false;
      if (heatSearch) {
        const q = heatSearch.toLowerCase();
        return r.check_id.toLowerCase().includes(q) || (r.rubric_slug || '').toLowerCase().includes(q);
      }
      return true;
    });

    const modeTabs = modes.map((m) =>
      '<button type="button" class="tab-btn' + (m === heatmapMode ? ' active' : '') + '" data-heat-mode="' + esc(m) + '">' + esc(m) + '</button>'
    ).join('');
    const groupOptions = '<option value="">All rubrics</option>' + groups.map((g) =>
      '<option value="' + esc(g) + '"' + (g === heatGroup ? ' selected' : '') + '>' + esc(g) + '</option>'
    ).join('');

    const headerCols = map.repos.map((r) => '<th class="numeric">' + esc(r) + '</th>').join('');
    const bodyRows = visibleRows.map((row) => {
      const label = row.instructions
        ? '<span class="tip-wrap"><span class="tip-trigger" tabindex="0">' + esc(row.check_id) + '</span><div class="tip-card"><strong>' + esc(row.instructions) + '</strong><div class="tip-pass"><strong>Pass:</strong> ' + esc(row.pass_criteria) + '</div><div class="tip-fail"><strong>Fail:</strong> ' + esc(row.fail_criteria) + '</div></div></span>'
        : '<code>' + esc(row.check_id) + '</code>';
      const thrBadge = Math.abs(row.threshold - 0.8) > 1e-9
        ? '<span class="pill warn">&ge;' + row.threshold.toFixed(2) + '</span>'
        : '<span class="pill neutral">&ge;' + row.threshold.toFixed(2) + '</span>';
      const cells = map.repos.map((rName) => {
        const c = row.by_repo[rName];
        if (!c) return '<td class="numeric muted">—</td>';
        const col = heatColors(c.pass_rate);
        return '<td class="numeric"><span class="heat-cell" style="background:' + col.bg + ';color:' + col.fg + '" title="Calibrated ' + pct(c.pass_rate) + ' | Raw ' + pct(c.raw_pass_rate) + ' | Mean P ' + pct(c.mean_pass_probability) + '"><strong>' + pct(c.pass_rate, 0) + '</strong><span>' + c.passed + '/' + c.total + ' · P=' + (c.mean_pass_probability !== null ? c.mean_pass_probability.toFixed(2) : '—') + '</span></span></td>';
      }).join('');
      return '<tr><td>' + label + (row.rubric_slug ? ' <span class="muted" style="font-size:.75rem">' + esc(row.rubric_slug) + '</span>' : '') + '</td><td class="numeric">' + thrBadge + '</td>' + cells + '</tr>';
    }).join('');

    container.innerHTML =
      '<div class="controls">'
      + '<div class="tabs">' + modeTabs + '</div>'
      + '<select id="heat-group-select" aria-label="Filter rubric group">' + groupOptions + '</select>'
      + '<input type="search" id="heat-search-input" placeholder="Search check ID..." value="' + esc(heatSearch) + '">'
      + '<span class="muted numeric" style="margin-left:auto">' + visibleRows.length + ' of ' + map.rows.length + ' checks</span>'
      + '</div>'
      + '<div class="table-scroll"><table><thead><tr><th>Check</th><th>Threshold</th>' + headerCols + '</tr></thead><tbody>' + bodyRows + '</tbody></table></div>';
  }

  function renderFixtures() {
    const container = document.getElementById('fixtures-root');
    if (!container) return;
    const fx = DATA.fixtures;
    if (!fx || !fx.latest) {
      container.innerHTML = '<div class="empty-state">No rubric fixture snapshots recorded yet. Enable <code>fixtures.enabled: true</code> in your scan config to track fixture health over time.</div>';
      return;
    }
    const latest = fx.latest;
    const rows = [...latest.checks].sort((a, b) =>
      (Number(a.passed) - Number(b.passed))
      || ((a.margin ?? 1) - (b.margin ?? 1))
      || (a.fixture_id < b.fixture_id ? -1 : a.fixture_id > b.fixture_id ? 1 : 0)
    ).map((c) => {
      const probRange = c.min_pass_probability !== null && c.max_pass_probability !== null
        ? (c.min_pass_probability.toFixed(2) === c.max_pass_probability.toFixed(2)
          ? c.min_pass_probability.toFixed(2)
          : c.min_pass_probability.toFixed(2) + '..' + c.max_pass_probability.toFixed(2))
        : '—';
      const marginClass = c.margin === null ? 'neutral' : c.margin >= 0.15 ? 'pass' : c.margin >= 0 ? 'warn' : 'fail';
      const jitterClass = c.jitter === null ? 'neutral' : c.jitter <= 0.05 ? 'pass' : c.jitter <= 0.15 ? 'warn' : 'fail';
      return '<tr>'
        + '<td><code>' + esc(c.fixture_id) + '</code></td>'
        + '<td><code>' + esc(c.check_id) + '</code></td>'
        + '<td><span class="pill neutral">' + esc(c.expected) + '</span></td>'
        + '<td class="numeric"><span class="pill ' + (c.passed ? 'pass' : 'fail') + '">' + c.matches + '/' + c.repeats + '</span></td>'
        + '<td class="numeric">' + esc(probRange) + '</td>'
        + '<td class="numeric">' + (c.pass_threshold !== null ? '&ge;' + c.pass_threshold.toFixed(2) : '—') + '</td>'
        + '<td class="numeric"><span class="pill ' + marginClass + '">' + (c.margin !== null ? (c.margin >= 0 ? '+' : '') + c.margin.toFixed(3) : '—') + '</span></td>'
        + '<td class="numeric"><span class="pill ' + jitterClass + '">' + (c.jitter !== null ? c.jitter.toFixed(3) : '—') + '</span></td>'
        + '</tr>';
    }).join('');

    container.innerHTML =
      '<div class="chart-box">'
      + '<div class="chart-legend">'
      + '<span class="legend-item"><span class="legend-swatch" style="background:#15803d"></span>Fixture check pass rate</span>'
      + '<span class="legend-item"><span class="legend-swatch" style="background:#ea580c"></span>Max repeat jitter</span>'
      + '<span class="muted numeric" style="margin-left:auto">Latest: ' + esc(shortDate(latest.timestamp)) + ' · ' + latest.fixtures_passed + '/' + latest.fixtures_total + ' fixtures · ' + latest.checks_passed + '/' + latest.checks_total + ' checks · repeats=' + latest.repeats + ' · min margin=' + (latest.min_margin !== null ? latest.min_margin.toFixed(3) : '—') + ' · max jitter=' + (latest.max_jitter !== null ? latest.max_jitter.toFixed(3) : '—') + '</span>'
      + '</div>'
      + '<div class="svg-wrap">' + renderFixtureTrendSvg(fx.points) + '</div>'
      + '</div>'
      + '<div class="table-scroll"><table><thead><tr><th>Fixture</th><th>Check</th><th>Expect</th><th>Repeats</th><th>P(pass) range</th><th>Threshold</th><th>Margin</th><th>Jitter</th></tr></thead><tbody>' + rows + '</tbody></table></div>';
  }

  document.addEventListener('click', (ev) => {
    const t = ev.target;
    if (!t || !t.closest) return;
    const repoBtn = t.closest('[data-pick-repo], .repo-row');
    if (repoBtn) {
      const name = repoBtn.dataset.pickRepo || repoBtn.dataset.repo;
      if (name && name !== selectedRepo) {
        selectedRepo = name;
        selectedRunIdx = null;
        renderRepoDetail();
      }
      return;
    }
    const modeBtn = t.closest('[data-pick-mode]');
    if (modeBtn) {
      selectedMode = modeBtn.dataset.pickMode;
      selectedRunIdx = null;
      renderRepoDetail();
      return;
    }
    const runPick = t.closest('[data-select-run]');
    if (runPick) {
      selectedRunIdx = Number(runPick.dataset.selectRun);
      renderRepoDetail();
      return;
    }
    const heatBtn = t.closest('[data-heat-mode]');
    if (heatBtn) {
      heatmapMode = heatBtn.dataset.heatMode;
      heatGroup = '';
      renderHeatmap();
    }
  });

  document.addEventListener('input', (ev) => {
    const t = ev.target;
    if (!t) return;
    if (t.id === 'file-search-input') {
      fileSearch = t.value;
      const pos = t.selectionStart;
      renderRepoDetail();
      const el = document.getElementById('file-search-input');
      if (el) { el.focus(); if (typeof pos === 'number') el.setSelectionRange(pos, pos); }
    } else if (t.id === 'heat-search-input') {
      heatSearch = t.value;
      const pos = t.selectionStart;
      renderHeatmap();
      const el = document.getElementById('heat-search-input');
      if (el) { el.focus(); if (typeof pos === 'number') el.setSelectionRange(pos, pos); }
    }
  });

  document.addEventListener('change', (ev) => {
    const t = ev.target;
    if (!t) return;
    if (t.id === 'failing-only-toggle') {
      failingOnly = t.checked;
      renderRepoDetail();
    } else if (t.id === 'heat-group-select') {
      heatGroup = t.value;
      renderHeatmap();
    }
  });

  renderRepoDetail();
  renderHeatmap();
  renderFixtures();
})();
`;

export function renderDashboardHtml(model: DashboardModel): string {
  const latestTag = model.catalog.agent_tooling.latest_tag;
  const fxLatest = model.fixtures.latest;

  const repoOverviewRows = model.repos.map((repo) => {
    const fileSeries = repo.by_mode.file;
    const structSeries = repo.by_mode.structure;
    const codeSeries = repo.by_mode.code;

    const formatModeCell = (series: RepoModeSeries | undefined): string => {
      if (!series) return '<span class="muted">—</span>';
      const p = series.latest;
      const d = p.delta_calibrated;
      const dBadge = d !== null
        ? `<span class="pill ${d > 0.005 ? 'pass' : d < -0.005 ? 'fail' : 'neutral'}" title="${p.version_changed ? 'Crossed rubric/judge change' : 'Delta vs previous run'}">${escapeHtml(deltaPp(d))}${p.version_changed ? ' *' : ''}</span>`
        : '';
      return `<div><strong class="numeric${scoreTone(p.calibrated_pass_rate)}">${pct(p.calibrated_pass_rate)}</strong> <span class="muted numeric" style="font-size:.76rem">(raw ${pct(p.raw_pass_rate)} · P=${pct(p.mean_pass_probability, 0)})</span> ${dBadge}</div>`;
    };

    const modeCells = [
      `<td>${formatModeCell(fileSeries)}</td>`,
      `<td>${formatModeCell(structSeries)}</td>`,
      ...(model.modes_present.includes('code') ? [`<td>${formatModeCell(codeSeries)}</td>`] : []),
    ].join('');

    return `<tr class="repo-row" data-repo="${escapeHtml(repo.name)}">
      <td><strong>${escapeHtml(repo.name)}</strong><div class="muted" style="font-size:.75rem">${repo.total_runs} run(s) · ${escapeHtml(repo.latest_timestamp.slice(0, 10))}</div></td>
      <td><code>${escapeHtml(repo.latest_commit_short)}</code>${repo.latest_dirty ? ' <span class="pill warn">dirty</span>' : ''}${repo.latest_branch ? `<div class="muted" style="font-size:.75rem">${escapeHtml(repo.latest_branch)}</div>` : ''}</td>
      ${modeCells}
      <td>${renderInstalledBadge(repo, latestTag)}</td>
      <td class="numeric">${escapeHtml(fmtUsd(repo.total_cost_usd))}</td>
    </tr>`;
  }).join('');

  const warningsHtml = model.warnings.length > 0
    ? `<div class="warn-banner"><strong>Snapshot warnings (${model.warnings.length}):</strong> ${escapeHtml(model.warnings.join(' | '))}</div>`
    : '';

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'">
<title>Rubric Quality Dashboard · agent-tooling</title><style>${STYLE}</style></head><body><main>
<header>
  <div class="title-row"><h1>Rubric Quality Dashboard</h1><span class="pill-header">Offline · Local</span></div>
  <div class="meta-bar">
    <span>agent-tooling <strong>${escapeHtml(model.catalog.agent_tooling.judge_version)}</strong></span>
    <span>Latest tag <strong>${escapeHtml(latestTag ?? 'none')}</strong></span>
    <span>Authoritative rubrics <strong>${model.catalog.rubrics.length}</strong></span>
    <span>Built <strong>${escapeHtml(model.generated_at.replace('T', ' ').slice(0, 19))}Z</strong></span>
  </div>
</header>

${warningsHtml}

<section class="kpi-strip" aria-label="Dashboard overview">
  <div class="kpi"><div class="kpi-label">Repositories</div><div class="kpi-value">${model.totals.repo_count}</div><div class="kpi-note">${model.totals.repo_runs} repo snapshot(s) · ${model.totals.fixture_runs} fixture run(s)</div></div>
  <div class="kpi"><div class="kpi-label">Mean calibrated pass</div><div class="kpi-value${scoreTone(model.totals.latest_calibrated_mean)}">${pct(model.totals.latest_calibrated_mean)}</div><div class="kpi-note">Raw model pass: ${pct(model.totals.latest_raw_mean)}</div></div>
  <div class="kpi${model.totals.outdated_repos > 0 ? ' kpi-alert' : ''}"><div class="kpi-label">Installed judge-code</div><div class="kpi-value ${model.totals.outdated_repos === 0 ? 'tone-good' : 'tone-warn'}">${model.totals.outdated_repos === 0 ? 'Up to date' : `${model.totals.outdated_repos} outdated`}</div><div class="kpi-note">Latest release tag: ${escapeHtml(latestTag ?? 'n/a')}</div></div>
  <div class="kpi${fxLatest && fxLatest.status === 'failed' ? ' kpi-alert' : ''}"><div class="kpi-label">Rubric fixtures</div><div class="kpi-value${fxLatest ? (fxLatest.status === 'passed' ? ' tone-good' : ' tone-bad') : ''}">${fxLatest ? `${fxLatest.checks_passed}/${fxLatest.checks_total}` : '—'}</div><div class="kpi-note">${fxLatest ? `min margin ${fxLatest.min_margin !== null ? fxLatest.min_margin.toFixed(2) : '—'} · max jitter ${fxLatest.max_jitter !== null ? fxLatest.max_jitter.toFixed(2) : '—'}` : 'No fixture runs yet'}</div></div>
  <div class="kpi"><div class="kpi-label">Recorded spend</div><div class="kpi-value">${escapeHtml(fmtUsd(model.totals.total_cost_usd))}</div><div class="kpi-note">OpenRouter total across saved runs</div></div>
</section>

<section class="panel">
  <div class="panel-head"><h2>Repositories overview</h2><span class="muted">Click a row to inspect trend history, hotspots, and per-check breakdown (* = rubric/judge change)</span></div>
  ${model.repos.length > 0
    ? `<div class="table-scroll"><table><thead><tr><th>Repository</th><th>Latest commit</th><th>File mode</th><th>Structure mode</th>${model.modes_present.includes('code') ? '<th>Code mode</th>' : ''}<th>Installed judge-code</th><th>Total cost</th></tr></thead><tbody>${repoOverviewRows}</tbody></table></div>`
    : '<div class="empty-state">No repository snapshots found in <code>runs/*.json</code>.</div>'}
</section>

<section class="panel">
  <div class="panel-head"><h2>Repository trends &amp; hotspot explorer</h2></div>
  <div id="repo-detail-root"></div>
</section>

<section class="panel">
  <div class="panel-head"><h2>Cross-repo check heatmap (latest runs)</h2><span class="muted">Calibrated pass rates &amp; thresholds per check</span></div>
  <div id="heatmap-root"></div>
</section>

<section class="panel">
  <div class="panel-head"><h2>Rubric health (<code>rubrics/fixtures</code>)</h2><span class="muted">Calibration margins &amp; repeat jitter across fixture runs</span></div>
  <div id="fixtures-root"></div>
</section>

${renderCatalogPanel(model.catalog)}

<footer>Self-contained offline dashboard generated by <code>rubrics/dashboard.mts</code>. Zero external network requests, zero source code stored in snapshots.</footer>
</main>
<script id="dashboard-data" type="application/json">${safeJsonForScript(model)}</script>
<script>${CLIENT_SCRIPT}</script>
</body></html>`;
}

export interface GenerateDashboardOptions {
  dataDir: string;
  outFile?: string;
  rubricsDir?: string;
  repoRoot?: string;
}

export function generateDashboard(options: GenerateDashboardOptions): {
  outPath: string;
  model: DashboardModel;
  elapsedMs: number;
} {
  const startMs = performance.now();
  const dataDir = resolve(options.dataDir);
  const outPath = resolve(options.outFile ?? join(dataDir, 'index.html'));
  if (extname(outPath).toLowerCase() !== '.html') {
    throw new Error('Dashboard output path (--out) must end in .html');
  }

  const loaded = loadSnapshotsFromDir(dataDir);
  const catalog = loadRubricCatalog(options.rubricsDir ?? AUTHORITATIVE_RUBRICS_DIR, options.repoRoot ?? REPO_ROOT);
  const model = buildDashboardModel({
    repoSnapshots: loaded.repoSnapshots,
    fixtureSnapshots: loaded.fixtureSnapshots,
    warnings: loaded.warnings,
    catalog,
  });

  const html = renderDashboardHtml(model);
  mkdirSync(dirname(outPath), { recursive: true, mode: 0o700 });
  writeFileSync(outPath, html, { encoding: 'utf8', mode: 0o600 });
  return {
    outPath,
    model,
    elapsedMs: Math.round(performance.now() - startMs),
  };
}

function main(): void {
  const { values } = parseArgs({
    options: {
      data: { type: 'string' },
      out: { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });

  if (values.help) {
    console.log(USAGE);
    return;
  }

  if (!values.data?.trim()) {
    throw new Error(`Missing required --data <dir>\n\n${USAGE}`);
  }

  const { outPath, model, elapsedMs } = generateDashboard({
    dataDir: values.data,
    outFile: values.out,
  });

  console.log(
    `Dashboard built in ${elapsedMs}ms: ${outPath} `
    + `(${model.totals.repo_count} repo(s), ${model.totals.repo_runs} repo run(s), ${model.totals.fixture_runs} fixture run(s))`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
