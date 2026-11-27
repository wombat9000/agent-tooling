#!/usr/bin/env node
/**
 * Static offline HTML dashboard generator (`pnpm rubrics:dashboard`).
 * Reads snapshot JSONs from <data>/runs/*.json and authoritative rubrics/*.json
 * to build a single-file interactive HTML dashboard with inline SVG charts,
 * linter-style punch-list overviews, and Feature / Module Architecture breakdowns.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import type { JudgeMode } from '../skills/judge-code/scripts/rubrics.mts';
import {
  REPO_ROOT,
  classifyCheckFailure,
  compareCodepoint,
  countChecksFindings,
  countSummaryFindings,
  diffRubricHashes,
  equalStringRecords,
  escapeHtml,
  loadRubricCatalog,
  loadSnapshotsFromDir,
  safeJsonForScript,
  sumFindingCounts,
  type CatalogCheckInfo,
  type FindingCounts,
  type FixtureCheckSnapshot,
  type InstalledSkillInfo,
  type LoadedSnapshotRecord,
  type ModuleSkipReason,
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

export interface DashboardModuleCheckFinding {
  check_id: string;
  rubric_slug: string | null;
  scope: string | null;
  severity: 'hard' | 'borderline';
  pass_probability: number | null;
  threshold: number;
}

export interface DashboardModuleView {
  name: string;
  path: string;
  status: 'scored' | 'skipped' | 'error';
  skip_reason?: ModuleSkipReason;
  error?: string;
  file_count: number;
  bytes?: number;
  failed_count: number;
  hard_fail_count: number;
  borderline_count: number;
  passed_count: number;
  total_checks: number;
  min_pass_probability: number | null;
  failing_checks: DashboardModuleCheckFinding[];
}

export interface RepoModuleArchitecture {
  timestamp: string;
  commit_short: string;
  total_modules: number;
  scored_modules: number;
  skipped_modules: number;
  errored_modules: number;
  modules_with_findings: number;
  findings: FindingCounts;
  modules: DashboardModuleView[];
}

export interface RepoRuleFindingSummary {
  check_id: string;
  mode: JudgeMode;
  rubric_slug: string | null;
  failed: number;
  hard: number;
  borderline: number;
  total: number;
  min_pass_probability: number | null;
  threshold: number;
}

export interface RepoHotspotSummary {
  path: string;
  failed_count: number;
  hard_fail_count: number;
  borderline_count: number;
  min_pass_probability: number | null;
  failing_checks: string[];
}

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
  findings: FindingCounts;
  affected_targets: number;
  delta_findings: number | null;
  delta_hard_fails: number | null;
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
  modules: DashboardModuleView[];
  modules_scored: number;
  modules_skipped: number;
  modules_errored: number;
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
  total_findings: FindingCounts;
  file_findings: FindingCounts | null;
  structure_findings: FindingCounts | null;
  module_findings: FindingCounts | null;
  worst_rules: RepoRuleFindingSummary[];
  top_hotspots: RepoHotspotSummary[];
  module_architecture: RepoModuleArchitecture | null;
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
    failed: number;
    hard_failed: number;
    borderline_failed: number;
    mean_pass_probability: number | null;
    min_pass_probability: number | null;
    threshold: number;
  }>;
  total_findings: number;
  total_hard_fails: number;
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
    total_findings: FindingCounts;
    file_findings: FindingCounts;
    structure_findings: FindingCounts;
    module_findings: FindingCounts;
    modules_scanned: number;
    modules_with_findings: number;
    modules_skipped: number;
    modules_errored: number;
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
  return [...files].sort((a, b) => {
    const ca = countChecksFindings(a.checks);
    const cb = countChecksFindings(b.checks);
    return (cb.hard - ca.hard)
      || (cb.total - ca.total)
      || (b.failed_count - a.failed_count)
      || ((a.min_pass_probability ?? 1) - (b.min_pass_probability ?? 1))
      || (a.pass_rate - b.pass_rate)
      || compareCodepoint(a.path, b.path);
  });
}

function buildFailingModuleChecks(
  checks: Record<string, { choice: 'pass' | 'fail'; model_choice?: 'pass' | 'borderline' | 'fail'; pass_probability: number | null }>,
  snapChecks: Record<string, SnapshotCheckSummary>,
  catalog: RubricCatalog,
): DashboardModuleCheckFinding[] {
  const findings: DashboardModuleCheckFinding[] = [];
  for (const [checkId, score] of Object.entries(checks)) {
    const severity = classifyCheckFailure(score);
    if (!severity) continue;
    const cat = catalog.checks_by_id[checkId];
    const summary = snapChecks[checkId];
    findings.push({
      check_id: checkId,
      rubric_slug: cat?.rubric_slug ?? summary?.rubric_group ?? null,
      scope: cat?.scope ?? null,
      severity,
      pass_probability: score.pass_probability,
      threshold: summary?.threshold ?? cat?.pass_threshold ?? 0.8,
    });
  }
  findings.sort((a, b) =>
    (Number(b.severity === 'hard') - Number(a.severity === 'hard'))
    || ((a.pass_probability ?? 0) - (b.pass_probability ?? 0))
    || compareCodepoint(a.check_id, b.check_id),
  );
  return findings;
}

function moduleSortTier(mod: DashboardModuleView): number {
  if (mod.status === 'scored' && mod.failed_count > 0) return 0;
  if (mod.status === 'error') return 1;
  if (mod.status === 'skipped') return 2;
  return 3;
}

function sortModuleViews(modules: DashboardModuleView[]): DashboardModuleView[] {
  return [...modules].sort((a, b) => {
    const tierDiff = moduleSortTier(a) - moduleSortTier(b);
    if (tierDiff !== 0) return tierDiff;
    if (a.status === 'scored' && b.status === 'scored') {
      return (b.hard_fail_count - a.hard_fail_count)
        || (b.failed_count - a.failed_count)
        || ((a.min_pass_probability ?? 1) - (b.min_pass_probability ?? 1))
        || compareCodepoint(a.name, b.name)
        || compareCodepoint(a.path, b.path);
    }
    return compareCodepoint(a.name, b.name) || compareCodepoint(a.path, b.path);
  });
}

function buildModuleViewsForSnapshot(snap: RepoSnapshot, catalog: RubricCatalog): DashboardModuleView[] {
  if (Array.isArray(snap.modules)) {
    return sortModuleViews(
      snap.modules.map((m) => {
        const failing = buildFailingModuleChecks(m.checks ?? {}, snap.checks, catalog);
        const totalChecks = Object.keys(m.checks ?? {}).length;
        const hardCount = failing.filter((c) => c.severity === 'hard').length;
        const borderlineCount = failing.filter((c) => c.severity === 'borderline').length;
        return {
          name: m.name,
          path: m.path,
          status: m.status,
          ...(m.skip_reason ? { skip_reason: m.skip_reason } : {}),
          ...(m.error ? { error: m.error } : {}),
          file_count: m.file_count,
          ...(m.bytes !== undefined ? { bytes: m.bytes } : {}),
          failed_count: m.status === 'scored' ? failing.length : 0,
          hard_fail_count: m.status === 'scored' ? hardCount : 0,
          borderline_count: m.status === 'scored' ? borderlineCount : 0,
          passed_count: m.status === 'scored' ? Math.max(0, totalChecks - failing.length) : 0,
          total_checks: totalChecks,
          min_pass_probability: m.min_pass_probability,
          failing_checks: failing,
        };
      }),
    );
  }

  // Backwards-compatible fallback for legacy mode === 'code' snapshots without `modules`.
  if (snap.scan.mode === 'code' && snap.files.length > 0) {
    return sortModuleViews(
      snap.files.map((f) => {
        const failing = buildFailingModuleChecks(f.checks ?? {}, snap.checks, catalog);
        const totalChecks = Object.keys(f.checks ?? {}).length;
        const hardCount = failing.filter((c) => c.severity === 'hard').length;
        const borderlineCount = failing.filter((c) => c.severity === 'borderline').length;
        return {
          name: f.path === '.' ? snap.repo.name : f.path,
          path: f.path,
          status: 'scored' as const,
          file_count: snap.files.length === 1 ? snap.metrics.file_count : 0,
          failed_count: failing.length,
          hard_fail_count: hardCount,
          borderline_count: borderlineCount,
          passed_count: Math.max(0, totalChecks - failing.length),
          total_checks: totalChecks,
          min_pass_probability: f.min_pass_probability,
          failing_checks: failing,
        };
      }),
    );
  }

  return [];
}

function computeSnapshotFindings(snap: RepoSnapshot): FindingCounts {
  const checkSummaries = Object.values(snap.checks ?? {});
  if (checkSummaries.length > 0) {
    return sumFindingCounts(checkSummaries.map(countSummaryFindings));
  }
  if (Array.isArray(snap.modules) && snap.modules.length > 0) {
    return sumFindingCounts(
      snap.modules
        .filter((m) => m.status === 'scored')
        .map((m) => countChecksFindings(m.checks ?? {})),
    );
  }
  return sumFindingCounts((snap.files ?? []).map((f) => countChecksFindings(f.checks ?? {})));
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
        const findings = computeSnapshotFindings(snap);
        const prevFindings = prev ? computeSnapshotFindings(prev) : null;
        const deltaFindings = prevFindings ? findings.total - prevFindings.total : null;
        const deltaHardFails = prevFindings ? findings.hard - prevFindings.hard : null;
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

        const modules = buildModuleViewsForSnapshot(snap, catalog);
        const sortedFiles = sortHotspotFiles(snap.files ?? []);
        const affectedTargets = modules.length > 0
          ? modules.filter((m) => m.status === 'scored' && m.failed_count > 0).length
          : sortedFiles.filter((f) => f.failed_count > 0).length;
        const modulesScored = modules.filter((m) => m.status === 'scored').length;
        const modulesSkipped = modules.filter((m) => m.status === 'skipped').length;
        const modulesErrored = modules.filter((m) => m.status === 'error').length;

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
          findings,
          affected_targets: affectedTargets,
          delta_findings: deltaFindings,
          delta_hard_fails: deltaHardFails,
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
          files: sortedFiles,
          modules,
          modules_scored: modulesScored,
          modules_skipped: modulesSkipped,
          modules_errored: modulesErrored,
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

    const fileFindings = byMode.file?.latest.findings ?? null;
    const structureFindings = byMode.structure?.latest.findings ?? null;
    const moduleFindings = byMode.code?.latest.findings ?? null;
    const totalFindings = sumFindingCounts(
      [fileFindings, structureFindings, moduleFindings].filter((f): f is FindingCounts => f !== null),
    );

    const worstRules: RepoRuleFindingSummary[] = [];
    for (const mode of modes) {
      const latestPoint = byMode[mode]!.latest;
      for (const [checkId, summary] of Object.entries(latestPoint.checks)) {
        const fc = countSummaryFindings(summary);
        if (fc.total === 0) continue;
        worstRules.push({
          check_id: checkId,
          mode,
          rubric_slug: catalog.checks_by_id[checkId]?.rubric_slug ?? summary.rubric_group,
          failed: fc.total,
          hard: fc.hard,
          borderline: fc.borderline,
          total: summary.total,
          min_pass_probability: summary.min_pass_probability,
          threshold: summary.threshold,
        });
      }
    }
    worstRules.sort((a, b) =>
      (b.hard - a.hard)
      || (b.failed - a.failed)
      || ((a.min_pass_probability ?? 1) - (b.min_pass_probability ?? 1))
      || compareCodepoint(a.check_id, b.check_id),
    );

    const topHotspots: RepoHotspotSummary[] = (byMode.file?.latest.files ?? [])
      .filter((f) => f.failed_count > 0)
      .slice(0, 6)
      .map((f) => {
        const fc = countChecksFindings(f.checks);
        const failingIds = Object.entries(f.checks)
          .filter(([, s]) => s.choice === 'fail')
          .sort((a, b) =>
            (Number(classifyCheckFailure(b[1]) === 'hard') - Number(classifyCheckFailure(a[1]) === 'hard'))
            || ((a[1].pass_probability ?? 0) - (b[1].pass_probability ?? 0))
            || compareCodepoint(a[0], b[0]),
          )
          .map(([cid]) => cid);
        return {
          path: f.path,
          failed_count: fc.total,
          hard_fail_count: fc.hard,
          borderline_count: fc.borderline,
          min_pass_probability: f.min_pass_probability,
          failing_checks: failingIds,
        };
      });

    const latestCode = byMode.code?.latest ?? null;
    const moduleArchitecture: RepoModuleArchitecture | null = latestCode && latestCode.modules.length > 0
      ? {
        timestamp: latestCode.timestamp,
        commit_short: latestCode.commit_short,
        total_modules: latestCode.modules.length,
        scored_modules: latestCode.modules_scored,
        skipped_modules: latestCode.modules_skipped,
        errored_modules: latestCode.modules_errored,
        modules_with_findings: latestCode.modules.filter((m) => m.status === 'scored' && m.failed_count > 0).length,
        findings: latestCode.findings,
        modules: latestCode.modules,
      }
      : null;

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
      total_findings: totalFindings,
      file_findings: fileFindings,
      structure_findings: structureFindings,
      module_findings: moduleFindings,
      worst_rules: worstRules.slice(0, 10),
      top_hotspots: topHotspots,
      module_architecture: moduleArchitecture,
      by_mode: byMode,
    });
  }

  // Sort repos worst-first by hard fails -> total findings -> repo name
  repos.sort((a, b) =>
    (b.total_findings.hard - a.total_findings.hard)
    || (b.total_findings.total - a.total_findings.total)
    || compareCodepoint(a.name, b.name),
  );

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
      let totalFindingsForCheck = 0;
      let totalHardFailsForCheck = 0;
      let fallbackThreshold = 0.8;
      let fallbackGroup: string | null = null;
      for (const rName of modeRepos) {
        const check = repos.find((r) => r.name === rName)!.by_mode[mode]!.latest.checks[checkId];
        if (!check || check.total === 0) continue;
        fallbackThreshold = check.threshold;
        if (check.rubric_group) fallbackGroup = check.rubric_group;
        const fc = countSummaryFindings(check);
        totalFindingsForCheck += fc.total;
        totalHardFailsForCheck += fc.hard;
        byRepo[rName] = {
          pass_rate: check.pass_rate,
          raw_pass_rate: check.raw_pass_rate,
          passed: check.passed,
          total: check.total,
          failed: fc.total,
          hard_failed: fc.hard,
          borderline_failed: fc.borderline,
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
        total_findings: totalFindingsForCheck,
        total_hard_fails: totalHardFailsForCheck,
        worst_pass_rate: worst,
      };
    });
    rows.sort((a, b) =>
      (b.total_hard_fails - a.total_hard_fails)
      || (b.total_findings - a.total_findings)
      || (a.worst_pass_rate - b.worst_pass_rate)
      || compareCodepoint(a.check_id, b.check_id),
    );
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

  // Aggregate latest calibrated/raw means (kept for backwards compatibility) and punch-list totals
  const latestPrimaries = repos
    .map((r) => r.by_mode.file?.latest ?? r.by_mode.structure?.latest ?? r.by_mode.code?.latest)
    .filter((p): p is TrendPoint => p !== undefined);
  const latestCalibratedMean = latestPrimaries.length > 0
    ? latestPrimaries.reduce((sum, p) => sum + p.calibrated_pass_rate, 0) / latestPrimaries.length
    : null;
  const latestRawMean = latestPrimaries.length > 0
    ? latestPrimaries.reduce((sum, p) => sum + p.raw_pass_rate, 0) / latestPrimaries.length
    : null;

  const totalFindings = sumFindingCounts(repos.map((r) => r.total_findings));
  const totalFileFindings = sumFindingCounts(
    repos.map((r) => r.file_findings).filter((f): f is FindingCounts => f !== null),
  );
  const totalStructureFindings = sumFindingCounts(
    repos.map((r) => r.structure_findings).filter((f): f is FindingCounts => f !== null),
  );
  const totalModuleFindings = sumFindingCounts(
    repos.map((r) => r.module_findings).filter((f): f is FindingCounts => f !== null),
  );
  const modulesScanned = repos.reduce((sum, r) => sum + (r.module_architecture?.total_modules ?? 0), 0);
  const modulesWithFindings = repos.reduce((sum, r) => sum + (r.module_architecture?.modules_with_findings ?? 0), 0);
  const modulesSkipped = repos.reduce((sum, r) => sum + (r.module_architecture?.skipped_modules ?? 0), 0);
  const modulesErrored = repos.reduce((sum, r) => sum + (r.module_architecture?.errored_modules ?? 0), 0);
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
      total_findings: totalFindings,
      file_findings: totalFileFindings,
      structure_findings: totalStructureFindings,
      module_findings: totalModuleFindings,
      modules_scanned: modulesScanned,
      modules_with_findings: modulesWithFindings,
      modules_skipped: modulesSkipped,
      modules_errored: modulesErrored,
      latest_calibrated_mean: latestCalibratedMean,
      latest_raw_mean: latestRawMean,
      outdated_repos: repos.filter((r) => r.installed_status === 'outdated').length,
    },
  };
}

function fmtUsd(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  if (value === 0) return '$0.00';
  if (value < 0.01) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(3)}`;
}

function parseSemverTag(tag: string): [number, number, number, boolean] | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(-.+)?$/.exec(tag.trim());
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3]), Boolean(m[4])];
}

export function formatToolingVersion(judgeVersion: string, latestTag: string | null): string {
  if (!latestTag || judgeVersion === latestTag) return judgeVersion;
  const curr = parseSemverTag(judgeVersion);
  const latest = parseSemverTag(latestTag);
  if (curr && latest) {
    for (let i = 0; i < 3; i += 1) {
      if (latest[i] !== curr[i]) {
        return latest[i] > curr[i]
          ? `${judgeVersion} · update available: ${latestTag}`
          : `${judgeVersion} · latest tag: ${latestTag}`;
      }
    }
    if (!latest[3] && curr[3]) {
      return `${judgeVersion} · latest tag: ${latestTag}`;
    }
  }
  return `${judgeVersion} · latest tag: ${latestTag}`;
}

export function computeNiceAxisTicks(maxVal: number): { max: number; ticks: number[] } {
  const safeMax = Number.isFinite(maxVal) && maxVal > 0 ? maxVal : 4;
  const rawStep = safeMax / 3;
  const mag = 10 ** Math.floor(Math.log10(rawStep));
  const norm = rawStep / mag;
  const niceMult = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10;
  const step = Math.max(1, niceMult * mag);
  const top = Math.max(step, Math.ceil(safeMax / step) * step);
  const ticks: number[] = [];
  for (let v = 0; v <= top; v += step) {
    ticks.push(v);
  }
  return { max: top, ticks };
}

export function formatVersionDeltaLabel(prevVersion: string | null, currVersion: string): string {
  const shorten = (v: string): string => {
    const clean = v.replace(/-\d+-g[0-9a-f]+$/i, '');
    const m = /^(v?\d+\.\d+)\.0$/.exec(clean);
    return m ? m[1] : clean;
  };
  if (prevVersion && prevVersion !== currVersion) {
    const p = shorten(prevVersion);
    const c = shorten(currVersion);
    return p !== c ? `${p} → ${c}` : `${prevVersion} → ${currVersion}`;
  }
  return 'rubric Δ';
}

export function stripSharedPathPrefix(paths: readonly string[]): string {
  if (paths.length < 2) return '';
  const dirLists = paths.map((p) => {
    const parts = p.split('/');
    return parts.length > 1 ? parts.slice(0, -1) : [];
  });
  let common = dirLists[0];
  for (let i = 1; i < dirLists.length && common.length > 0; i += 1) {
    const next = dirLists[i];
    let k = 0;
    while (k < common.length && k < next.length && common[k] === next[k]) k += 1;
    common = common.slice(0, k);
  }
  return common.length > 0 ? `${common.join('/')}/` : '';
}

function errorsTone(counts: FindingCounts): string {
  if (counts.hard > 0) return ' tone-bad';
  return ' tone-good';
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

  const versionLabel = formatToolingVersion(catalog.agent_tooling.judge_version, catalog.agent_tooling.latest_tag);
  return `<details class="panel catalog-panel">
    <summary class="panel-summary">
      <span><strong>Authoritative rubric catalog</strong> (${catalog.rubrics.length} rubrics in <code>rubrics/*.json</code>)</span>
      <span class="muted numeric">agent-tooling ${escapeHtml(versionLabel)}</span>
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
:root{color-scheme:light;--ink:#142136;--muted:#5b677a;--line:#dce3ed;--bg:#f4f6fa;--surface:#ffffff;--surface-alt:#f8fafd;--blue:#2563eb;--blue-soft:#eff6ff;--teal:#0d9488;--purple:#7c3aed;--green:#15803d;--green-bg:#dcfce7;--amber:#9a3412;--amber-bg:#ffedd5;--red:#b91c1c;--red-bg:#fee2e2}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
main{max-width:1440px;margin:0 auto;padding:20px 24px 56px;min-width:0}
header{border-top:3px solid var(--blue);padding:12px 0 16px}
.title-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
h1{font-size:1.55rem;line-height:1.2;letter-spacing:-.03em;margin:0}
h2{font-size:1.12rem;letter-spacing:-.015em;margin:0}
h3{font-size:.94rem;letter-spacing:-.01em;margin:0}
p{margin:6px 0}
code{font:500 .83em/1.4 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;background:#f1f5f9;padding:1px 5px;border-radius:4px}
.muted{color:var(--muted)}
.numeric{font-variant-numeric:tabular-nums;white-space:nowrap}
.meta-bar{display:flex;flex-wrap:wrap;gap:6px 18px;margin-top:8px;font-size:.82rem;color:var(--muted)}
.meta-bar strong{color:var(--ink);font-weight:600}
:focus-visible{outline:2px solid var(--blue);outline-offset:2px;border-radius:4px}
.kpi-bar{display:grid;grid-template-columns:minmax(0,1.55fr) minmax(0,1fr);gap:14px;margin-bottom:18px;align-items:stretch}
.kpi-group,.panel{background:var(--surface);border:1px solid var(--line);border-radius:12px;min-width:0}
.kpi-group{display:flex;flex-direction:column;overflow:hidden}
.kpi-group-tooling{background:var(--surface-alt)}
.kpi-group-eyebrow{font-size:.69rem;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);padding:7px 14px 5px;border-bottom:1px solid var(--line);background:#f1f5f9}
.kpi-grid{display:grid;grid-template-columns:repeat(var(--kpi-cols,2),minmax(0,1fr));flex:1}
.kpi{padding:14px 16px;border-right:1px solid var(--line);min-width:0}
.kpi:last-child{border-right:0}
.kpi-danger{background:#fef2f2}
.kpi-alert{background:#fff8f1}
.kpi-label{color:var(--muted);font-size:.72rem;font-weight:700;text-transform:uppercase;letter-spacing:.04em}
.kpi-value{font-size:1.55rem;font-weight:700;letter-spacing:-.03em;line-height:1.2;margin:4px 0 3px;font-variant-numeric:tabular-nums}
.kpi-value-sm{font-size:1.25rem}
.kpi-sub{font-size:.79rem;color:var(--muted);line-height:1.35;font-variant-numeric:tabular-nums}
.tone-good{color:var(--green)}
.tone-warn{color:var(--amber)}
.tone-bad{color:var(--red)}
.panel{padding:18px 20px;margin-bottom:18px}
.panel-head{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:12px}
.panel-summary{display:flex;align-items:center;justify-content:space-between;gap:12px;cursor:pointer;list-style:none;flex-wrap:wrap}
.panel-summary::-webkit-details-marker{display:none}
.panel-summary::before{content:'+ ';color:var(--blue);font-weight:700}
details[open]>.panel-summary::before{content:'− '}
.pill{display:inline-flex;align-items:center;gap:4px;border-radius:5px;padding:2px 7px;font-size:.72rem;font-weight:600;line-height:1.35;white-space:nowrap}
.pill-header{padding:3px 9px;border-radius:999px;font-size:.7rem;font-weight:700;letter-spacing:.05em;text-transform:uppercase;background:#e0e7ff;color:#1e40af}
.pass{color:var(--green);background:var(--green-bg)}
.warn{color:var(--amber);background:var(--amber-bg)}
.fail{color:var(--red);background:var(--red-bg)}
.neutral{color:var(--muted);background:#eef1f6}
.target-production_code{background:#e0e7ff;color:#1e40af}
.target-project_structure{background:#f3e8ff;color:#6b21a8}
.target-test_code{background:#dcfce7;color:#166534}
.target-review{background:#fef3c7;color:#92400e}
.table-scroll{overflow-x:auto;max-width:100%}
table{width:100%;border-collapse:collapse;text-align:left}
th{font-size:.75rem;color:var(--muted);font-weight:600;white-space:nowrap;border-bottom:1px solid var(--line)}
th,td{padding:8px 10px;border-bottom:1px solid var(--line);vertical-align:middle}
th:first-child,td:first-child{padding-left:0}
tbody tr:last-child td{border-bottom:0}
.tabs{display:inline-flex;background:#f1f5f9;border:1px solid var(--line);border-radius:8px;padding:2px;gap:2px;flex-wrap:wrap}
.tab-btn{border:0;background:transparent;color:var(--muted);font:inherit;font-size:.8rem;font-weight:600;padding:5px 11px;border-radius:6px;cursor:pointer;font-variant-numeric:tabular-nums}
.tab-btn:hover{color:var(--ink);background:rgba(255,255,255,.65)}
.tab-btn.active{background:#fff;color:var(--ink);box-shadow:0 1px 2px rgba(15,23,42,.08)}
.tab-btn.tab-muted{opacity:.68}
.mode-control{display:inline-flex;align-items:center;gap:8px;flex-wrap:wrap}
.control-label{font-size:.73rem;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:var(--muted)}
.controls{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:12px}
input[type=search],select{font:inherit;font-size:.82rem;color:var(--ink);background:#fff;border:1px solid #b8c5d8;border-radius:7px;padding:5px 10px;min-height:32px;max-width:100%}
input[type=search]{min-width:180px;width:220px}
label.toggle{display:inline-flex;align-items:center;gap:6px;font-size:.8rem;color:var(--muted);cursor:pointer;user-select:none}
.heat-repo-th{vertical-align:top;padding:6px 8px;min-width:155px;white-space:normal}
.repo-col-btn{display:flex;flex-direction:column;align-items:flex-end;gap:3px;width:100%;border:1px solid transparent;border-radius:8px;background:transparent;padding:7px 9px;text-align:right;cursor:pointer;font:inherit;color:var(--ink);transition:background .12s,border-color .12s}
.repo-col-btn:hover{background:#f8fafc;border-color:#cbd5e1}
.repo-col-btn.selected{background:var(--blue-soft);border-color:#93c5fd;box-shadow:inset 0 2px 0 var(--blue)}
.repo-col-title{display:flex;align-items:baseline;justify-content:flex-end;gap:7px;flex-wrap:wrap;width:100%}
.repo-col-name{font-size:.86rem;font-weight:700;color:var(--ink)}
.repo-col-meta{font-size:.71rem;color:var(--muted);line-height:1.35;font-weight:400}
.heat-cell-btn{display:inline-flex;flex-direction:column;align-items:flex-end;gap:1px;padding:5px 9px;border-radius:6px;min-width:98px;border:1px solid transparent;cursor:pointer;font:inherit;font-variant-numeric:tabular-nums;text-align:right;transition:transform .08s,box-shadow .12s}
.heat-cell-btn:hover{box-shadow:0 0 0 1px rgba(37,99,235,.45)}
.heat-cell-btn.heat-cell-active{box-shadow:0 0 0 2px var(--blue);border-color:var(--blue)}
.heat-cell-btn strong{font-size:.82rem;line-height:1.2}
.heat-cell-btn span{font-size:.7rem;opacity:.86;line-height:1.2}
.heat-col-selected{background:#f8fbff}
.thr-custom{display:inline-flex;align-items:center;gap:5px;color:var(--muted);cursor:help;font-variant-numeric:tabular-nums}
.thr-dot{width:6px;height:6px;border-radius:999px;background:#64748b;display:inline-block;flex-shrink:0}
.num-err{color:var(--red);font-weight:700;font-variant-numeric:tabular-nums}
.num-ok{color:var(--green);font-weight:600;font-variant-numeric:tabular-nums}
.num-warn{color:var(--amber);font-weight:600;font-variant-numeric:tabular-nums}
.num-sub{color:var(--muted);font-size:.76rem;font-variant-numeric:tabular-nums;margin-left:4px}
.filter-banner{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;padding:8px 12px;border-radius:8px;background:var(--blue-soft);border:1px solid #bfdbfe;color:#1e3a8a;font-size:.82rem;margin-bottom:12px}
.clear-btn,.link-btn{border:1px solid #cbd5e1;background:#fff;color:var(--ink);font:inherit;font-size:.76rem;font-weight:600;padding:3px 9px;border-radius:6px;cursor:pointer}
.clear-btn:hover,.link-btn:hover{background:#f8fafc;border-color:#94a3b8}
.single-run-note,.quiet-note{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;padding:9px 13px;border-radius:8px;background:var(--surface-alt);border:1px solid var(--line);color:var(--muted);font-size:.82rem;margin-bottom:14px}
.quiet-note{margin-top:14px;margin-bottom:0}
.chart-box{border:1px solid var(--line);border-radius:10px;padding:12px 14px;background:var(--surface-alt);margin-bottom:14px}
.chart-legend{display:flex;flex-wrap:wrap;gap:12px;align-items:center;font-size:.78rem;color:var(--muted);margin-bottom:8px}
.legend-item{display:inline-flex;align-items:center;gap:6px}
.legend-swatch{display:inline-block;width:16px;height:3px;border-radius:2px}
.legend-swatch.dashed{background:repeating-linear-gradient(90deg,var(--teal) 0 5px,transparent 5px 8px)}
.legend-swatch.dashed-slate{background:repeating-linear-gradient(90deg,#64748b 0 5px,transparent 5px 8px)}
.legend-swatch.dotted{background:repeating-linear-gradient(90deg,var(--purple) 0 2px,transparent 2px 5px)}
.svg-wrap{width:100%;overflow-x:auto}
svg.trend-svg{display:block;width:100%;max-width:100%;height:auto}
.chart-point{cursor:pointer}
.split-grid{display:grid;grid-template-columns:minmax(0,1.05fr) minmax(0,1fr);gap:16px;align-items:start}
.sub-card{border:1px solid var(--line);border-radius:10px;padding:14px 16px;background:var(--surface-alt);min-width:0}
.arch-card{border:1px solid #c7d2fe;border-radius:10px;padding:14px 16px;background:#fafbff;margin-bottom:14px;min-width:0}
.rule-pick-row{cursor:pointer}
.rule-pick-row:hover td{background:#f1f5f9}
.rule-pick-row.active-rule-row td{background:var(--blue-soft)}
.rule-tags{display:flex;flex-wrap:wrap;gap:4px;max-width:100%}
.rule-tag{display:inline-flex;align-items:center;gap:4px;padding:2px 7px;border-radius:5px;border:1px solid var(--line);background:#fff;color:var(--ink);font:500 .73rem/1.3 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;cursor:pointer;max-width:100%;overflow-wrap:anywhere;text-align:left}
.rule-tag:hover{border-color:var(--blue);background:var(--blue-soft)}
.rule-tag-hard{border-color:#fca5a5;background:#fff5f5;color:#991b1b}
.rule-tag-borderline{border-color:#e2e8f0;background:#f8fafc;color:var(--muted)}
.rule-tag-active{border-color:var(--blue);background:var(--blue-soft);color:#1e3a8a;font-weight:700}
.rule-tag-more{border-style:dashed;color:var(--blue);background:transparent}
.file-path-cell{overflow-wrap:anywhere;word-break:break-word;min-width:140px}
.file-dir{color:var(--muted);font:400 .78rem/1.35 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.file-name{color:var(--ink);font:600 .8rem/1.35 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.hotspot-footer{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-top:10px;padding-top:8px;border-top:1px solid var(--line);font-size:.8rem;color:var(--muted)}
.version-banner{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:8px 12px;border-radius:8px;background:#fffbeb;border:1px solid #fde68a;color:#92400e;font-size:.81rem;margin-bottom:12px}
.warn-banner{padding:10px 14px;border-radius:8px;background:#fff7ed;border:1px solid #fed7aa;color:#9a3412;font-size:.82rem;margin-bottom:14px}
.run-row{cursor:pointer}
.run-row:hover td{background:#f1f5f9}
.run-row.active-run td{background:var(--blue-soft)}
.fixture-details{border:1px solid var(--line);border-radius:10px;padding:10px 14px;background:var(--surface-alt)}
.tip-wrap{position:relative;display:inline-flex;align-items:center;max-width:100%}
.tip-trigger{border-bottom:1px dotted #94a3b8;cursor:help;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.82rem}
.tip-card{display:none;position:absolute;left:0;top:calc(100% + 6px);width:min(420px,74vw);padding:10px 12px;background:#fff;border:1px solid #cbd5e1;border-radius:9px;box-shadow:0 10px 24px rgba(15,23,42,.14);z-index:50;white-space:normal;font-weight:400;line-height:1.4;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:var(--ink)}
.tip-wrap:hover .tip-card,.tip-wrap:focus-within .tip-card{display:block}
.tip-pass{background:#f0fdf4;border-left:3px solid #16a34a;padding:5px 8px;border-radius:5px;margin-top:6px;font-size:.77rem}
.tip-fail{background:#fff7ed;border-left:3px solid #ea580c;padding:5px 8px;border-radius:5px;margin-top:5px;font-size:.77rem}
.empty-state{padding:24px 16px;text-align:center;color:var(--muted);border:1px dashed var(--line);border-radius:10px;background:var(--surface-alt)}
footer{font-size:.8rem;color:var(--muted);margin-top:24px}
[hidden]{display:none!important}
@media(max-width:1080px){.kpi-bar{grid-template-columns:1fr}.split-grid{grid-template-columns:minmax(0,1fr)}}
@media(max-width:640px){.kpi-grid{grid-template-columns:1fr}.kpi{border-right:0;border-bottom:1px solid var(--line)}.kpi:last-child{border-bottom:0}main{padding:14px 12px 44px}}
`;

const CLIENT_SCRIPT = `
(function(){
  const rawEl = document.getElementById('dashboard-data');
  if (!rawEl) return;
  const DATA = JSON.parse(rawEl.textContent || '{}');
  const DEFAULT_HOTSPOT_LIMIT = 15;
  const MAX_VISIBLE_RULE_TAGS = 3;

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
  function fmtUsd(v) {
    if (typeof v !== 'number' || !Number.isFinite(v)) return '—';
    if (v === 0) return '$0.00';
    return v < 0.01 ? '$' + v.toFixed(4) : '$' + v.toFixed(3);
  }
  function fmtKiB(bytes) {
    if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes <= 0) return '';
    return (bytes / 1024).toFixed(1) + ' KiB';
  }
  function shortDate(ts) {
    if (!ts) return '—';
    return ts.replace('T', ' ').slice(0, 16) + 'Z';
  }
  function isoDay(ts) {
    return ts ? String(ts).slice(0, 10) : '—';
  }
  function modeLabel(m) {
    return m === 'code' ? 'module' : m;
  }
  function modeToHash(m) {
    return m === 'code' ? 'module' : m;
  }
  function hashToMode(m) {
    if (m === 'module') return 'code';
    if (m === 'file' || m === 'structure' || m === 'code') return m;
    return null;
  }
  function classifyScore(score) {
    if (!score || score.choice !== 'fail') return null;
    if (score.model_choice === 'fail') return 'hard';
    if (score.model_choice === 'pass' || score.model_choice === 'borderline') return 'borderline';
    return typeof score.pass_probability === 'number' && score.pass_probability >= 0.5 ? 'borderline' : 'hard';
  }
  function countFileFindings(checks) {
    let hard = 0, borderline = 0;
    for (const score of Object.values(checks || {})) {
      const k = classifyScore(score);
      if (k === 'hard') hard += 1;
      else if (k === 'borderline') borderline += 1;
    }
    return { total: hard + borderline, hard, borderline };
  }
  function countCheckSummaryFindings(c) {
    const total = Math.max(0, c.total - c.passed);
    const hard = Math.max(0, Math.min(total, c.total - c.raw_passed));
    return { total, hard, borderline: Math.max(0, total - hard) };
  }
  function computeNiceTicks(maxVal) {
    const safeMax = Number.isFinite(maxVal) && maxVal > 0 ? maxVal : 4;
    const rawStep = safeMax / 3;
    const mag = Math.pow(10, Math.floor(Math.log10(rawStep)));
    const norm = rawStep / mag;
    const niceMult = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10;
    const step = Math.max(1, niceMult * mag);
    const top = Math.max(step, Math.ceil(safeMax / step) * step);
    const ticks = [];
    for (let v = 0; v <= top; v += step) ticks.push(v);
    return { max: top, ticks };
  }
  function formatVersionLabel(prevVersion, currVersion) {
    const shorten = (v) => {
      const clean = String(v || '').replace(/-\\d+-g[0-9a-f]+$/i, '');
      const m = /^(v?\\d+\\.\\d+)\\.0$/.exec(clean);
      return m ? m[1] : clean;
    };
    if (prevVersion && prevVersion !== currVersion) {
      const p = shorten(prevVersion);
      const c = shorten(currVersion);
      return p !== c ? p + ' → ' + c : prevVersion + ' → ' + currVersion;
    }
    return 'rubric Δ';
  }
  function sharedPathPrefix(paths) {
    if (!paths || paths.length < 2) return '';
    const dirLists = paths.map((p) => {
      const parts = String(p).split('/');
      return parts.length > 1 ? parts.slice(0, -1) : [];
    });
    let common = dirLists[0];
    for (let i = 1; i < dirLists.length && common.length > 0; i += 1) {
      const next = dirLists[i];
      let k = 0;
      while (k < common.length && k < next.length && common[k] === next[k]) k += 1;
      common = common.slice(0, k);
    }
    return common.length > 0 ? common.join('/') + '/' : '';
  }
  function renderShortPath(fullPath, prefix) {
    const rel = prefix && fullPath.startsWith(prefix) ? fullPath.slice(prefix.length) : fullPath;
    const slash = rel.lastIndexOf('/');
    if (slash === -1) {
      return '<span class="file-name" title="' + esc(fullPath) + '">' + esc(rel) + '</span>';
    }
    return '<span title="' + esc(fullPath) + '"><span class="file-dir">' + esc(rel.slice(0, slash + 1)) + '</span><span class="file-name">' + esc(rel.slice(slash + 1)) + '</span></span>';
  }
  function renderThresholdCell(threshold) {
    const isCustom = Math.abs(threshold - 0.8) > 1e-9;
    if (!isCustom) return '<span class="muted numeric">&ge;' + threshold.toFixed(2) + '</span>';
    return '<span class="thr-custom" title="Non-default pass threshold &ge;' + threshold.toFixed(2) + ' (default is 0.80)"><span class="thr-dot" aria-hidden="true"></span>&ge;' + threshold.toFixed(2) + '</span>';
  }
  function renderErrorsInline(fc) {
    if (!fc || fc.total === 0) return '<span class="pill pass">clean</span>';
    if (fc.hard > 0) {
      return '<span class="num-err">' + fc.hard + '</span>' + (fc.borderline > 0 ? '<span class="num-sub">+' + fc.borderline + 'w</span>' : '');
    }
    return '<span class="muted numeric">0</span><span class="num-sub">+' + fc.borderline + 'w</span>';
  }
  function heatCellStyle(c) {
    if (c.hard_failed === 0 && c.borderline_failed === 0) return { bg: '#ecfdf5', fg: '#14532d' };
    if (c.hard_failed === 0) return { bg: '#fffbeb', fg: '#78350f' };
    const hardRate = c.total > 0 ? c.hard_failed / c.total : 1;
    if (hardRate >= 0.35) return { bg: '#fecdd3', fg: '#881337' };
    if (hardRate >= 0.15) return { bg: '#ffe4e6', fg: '#9f1239' };
    return { bg: '#fff1f2', fg: '#991b1b' };
  }
  function checkLabelWithTip(cid) {
    const cat = DATA.catalog && DATA.catalog.checks_by_id ? DATA.catalog.checks_by_id[cid] : null;
    if (!cat) return '<code>' + esc(cid) + '</code>';
    return '<span class="tip-wrap"><span class="tip-trigger" tabindex="0">' + esc(cid) + '</span>'
      + '<div class="tip-card"><strong>' + esc(cat.instructions) + '</strong>'
      + '<div class="tip-pass"><strong>Pass:</strong> ' + esc(cat.criteria.pass) + '</div>'
      + '<div class="tip-fail"><strong>Fail:</strong> ' + esc(cat.criteria.fail) + '</div></div></span>';
  }

  let selectedRepo = DATA.repos && DATA.repos.length > 0 ? DATA.repos[0].name : null;
  let selectedMode = null;
  let selectedRunIdx = null;
  let trendMetric = 'errors';
  let heatmapMode = DATA.modes_present && DATA.modes_present.length > 0 ? DATA.modes_present[0] : 'file';
  let activeRule = '';
  let fileSearch = '';
  let failingOnly = true;
  let showAllFiles = false;
  let expandedFiles = new Set();
  let moduleSearch = '';
  let moduleFailingOnly = false;
  let heatSearch = '';
  let heatGroup = '';
  let lastWrittenHash = null;

  function ensureSelection() {
    if (!DATA.repos || DATA.repos.length === 0) return null;
    const repoObj = DATA.repos.find((r) => r.name === selectedRepo) || DATA.repos[0];
    selectedRepo = repoObj.name;
    if (!selectedMode || (selectedMode !== 'code' && !repoObj.by_mode[selectedMode])) {
      selectedMode = repoObj.modes[0] || null;
    }
    const series = selectedMode ? repoObj.by_mode[selectedMode] || null : null;
    if (!series) return { repoObj, series: null, run: null };
    if (selectedRunIdx === null || selectedRunIdx < 0 || selectedRunIdx >= series.points.length) {
      selectedRunIdx = series.points.length - 1;
    }
    return { repoObj, series, run: series.points[selectedRunIdx] };
  }

  function buildHash() {
    const params = new URLSearchParams();
    if (selectedRepo) params.set('repo', selectedRepo);
    if (selectedMode) params.set('mode', modeToHash(selectedMode));
    if (activeRule) params.set('rule', activeRule);
    const s = params.toString();
    return s ? '#' + s : '';
  }

  function syncUrlHash(push) {
    const next = buildHash();
    if (!next || window.location.hash === next) return;
    lastWrittenHash = next;
    try {
      if (push) {
        window.location.hash = next;
      } else if (window.history && window.history.replaceState) {
        window.history.replaceState(null, '', next);
      }
    } catch (_) {
      // Ignore restricted history environments
    }
  }

  function applyHashState() {
    const raw = (window.location.hash || '').replace(/^#/, '');
    if (!raw) return;
    const params = new URLSearchParams(raw);
    const repoParam = params.get('repo');
    if (repoParam && DATA.repos && DATA.repos.some((r) => r.name === repoParam)) {
      selectedRepo = repoParam;
      selectedRunIdx = null;
      showAllFiles = false;
      expandedFiles = new Set();
    }
    const modeParam = hashToMode(params.get('mode'));
    if (modeParam) {
      selectedMode = modeParam;
      selectedRunIdx = null;
      if (DATA.heatmaps && DATA.heatmaps[modeParam]) {
        heatmapMode = modeParam;
      }
    }
    const ruleParam = (params.get('rule') || '').trim();
    activeRule = ruleParam;
    if (selectedMode === 'code') {
      moduleSearch = ruleParam;
    } else {
      fileSearch = ruleParam;
    }
  }

  function renderVersionMarkers(points, xAt, padT, bottomY) {
    return points.map((p, i) => {
      if (!p.version_changed) return '';
      const x = xAt(i);
      const prev = i > 0 ? points[i - 1] : null;
      const shortLabel = formatVersionLabel(prev ? prev.judge_version : null, p.judge_version);
      const fullTip = esc(p.change_reasons.join(' | '));
      const anchor = x > 700 ? 'end' : x < 120 ? 'start' : 'middle';
      return '<g>'
        + '<line x1="' + x.toFixed(1) + '" y1="' + padT + '" x2="' + x.toFixed(1) + '" y2="' + bottomY + '" stroke="#d97706" stroke-width="1.3" stroke-dasharray="4 3"/>'
        + '<text x="' + x.toFixed(1) + '" y="' + (padT - 6) + '" text-anchor="' + anchor + '" font-size="10" font-weight="600" fill="#b45309">' + esc(shortLabel) + '<title>Rubric / judge change: ' + fullTip + '</title></text>'
        + '</g>';
    }).join('');
  }

  function renderErrorsTrendSvg(points, activeIdx) {
    const W = 820, H = 225, padL = 50, padR = 24, padT = 24, padB = 34;
    const plotW = W - padL - padR;
    const plotH = H - padT - padB;
    const maxVal = Math.max(...points.map((p) => p.findings ? p.findings.total : 0), 1);
    const axis = computeNiceTicks(maxVal);
    const xAt = (i) => points.length <= 1 ? padL + plotW / 2 : padL + (i / (points.length - 1)) * plotW;
    const yAt = (v) => padT + (1 - Math.max(0, Math.min(1, v / axis.max))) * plotH;

    const gridLines = axis.ticks.map((g) => {
      const y = yAt(g).toFixed(1);
      return '<line x1="' + padL + '" y1="' + y + '" x2="' + (W - padR) + '" y2="' + y + '" stroke="#e2e8f0" stroke-width="1"/>'
        + '<text x="' + (padL - 8) + '" y="' + (Number(y) + 4) + '" text-anchor="end" font-size="11" fill="#64748b">' + g + '</text>';
    }).join('');

    const versionLines = renderVersionMarkers(points, xAt, padT, H - padB);

    const polyline = (getter, stroke, dash, width) => {
      const coords = points.map((p, i) => xAt(i).toFixed(1) + ',' + yAt(getter(p)).toFixed(1));
      if (coords.length < 2) return '';
      return '<polyline fill="none" stroke="' + stroke + '" stroke-width="' + width + '" ' + (dash ? 'stroke-dasharray="' + dash + '"' : '') + ' points="' + coords.join(' ') + '"/>';
    };

    const dots = points.map((p, i) => {
      const x = xAt(i).toFixed(1);
      const yt = yAt(p.findings.total).toFixed(1);
      const yh = yAt(p.findings.hard).toFixed(1);
      const isActive = i === activeIdx;
      const tip = esc(
        shortDate(p.timestamp) + ' · ' + p.commit_short + (p.dirty ? ' (dirty)' : '')
        + '\\nErrors (raw FAIL): ' + p.findings.hard + ' (+' + p.findings.borderline + ' borderline)'
        + '\\nCalibrated pass: ' + pct(p.calibrated_pass_rate) + ' | Raw pass: ' + pct(p.raw_pass_rate)
        + (p.version_changed ? '\\nChange: ' + p.change_reasons.join('; ') : '')
      );
      return '<g class="chart-point" role="button" tabindex="0" aria-label="Select snapshot ' + esc(isoDay(p.timestamp)) + '" data-select-run="' + i + '">'
        + (isActive ? '<line x1="' + x + '" y1="' + padT + '" x2="' + x + '" y2="' + (H - padB) + '" stroke="#2563eb" stroke-opacity="0.18" stroke-width="10"/>' : '')
        + '<circle cx="' + x + '" cy="' + yt + '" r="' + (isActive ? 4.4 : 3.2) + '" fill="#64748b" stroke="#fff" stroke-width="1"><title>' + tip + '</title></circle>'
        + '<circle cx="' + x + '" cy="' + yh + '" r="' + (isActive ? 6 : 4.3) + '" fill="#b91c1c" stroke="#fff" stroke-width="1.5"><title>' + tip + '</title></circle>'
        + '</g>';
    }).join('');

    const step = Math.max(1, Math.ceil(points.length / 6));
    const xLabels = points.map((p, i) => {
      if (i !== 0 && i !== points.length - 1 && i % step !== 0) return '';
      const x = xAt(i).toFixed(1);
      return '<text x="' + x + '" y="' + (H - 10) + '" text-anchor="middle" font-size="10.5" fill="#64748b">' + esc(p.timestamp.slice(5, 10) + ' ' + p.commit_short) + '</text>';
    }).join('');

    return '<svg class="trend-svg" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Errors trend chart">'
      + gridLines + versionLines
      + polyline((p) => p.findings.total, '#64748b', '5 3', 1.8)
      + polyline((p) => p.findings.hard, '#b91c1c', '', 2.4)
      + dots + xLabels + '</svg>';
  }

  function renderRateTrendSvg(points, activeIdx) {
    const W = 820, H = 225, padL = 50, padR = 24, padT = 24, padB = 34;
    const plotW = W - padL - padR;
    const plotH = H - padT - padB;
    const xAt = (i) => points.length <= 1 ? padL + plotW / 2 : padL + (i / (points.length - 1)) * plotW;
    const yAt = (v) => padT + (1 - Math.max(0, Math.min(1, v))) * plotH;

    const gridLines = [0, 0.25, 0.5, 0.75, 1].map((g) => {
      const y = yAt(g).toFixed(1);
      return '<line x1="' + padL + '" y1="' + y + '" x2="' + (W - padR) + '" y2="' + y + '" stroke="#e2e8f0" stroke-width="1"/>'
        + '<text x="' + (padL - 8) + '" y="' + (Number(y) + 4) + '" text-anchor="end" font-size="11" fill="#64748b">' + Math.round(g * 100) + '%</text>';
    }).join('');

    const versionLines = renderVersionMarkers(points, xAt, padT, H - padB);

    const polyline = (getter, stroke, dash) => {
      const coords = points.map((p, i) => {
        const val = getter(p);
        return typeof val === 'number' && Number.isFinite(val) ? xAt(i).toFixed(1) + ',' + yAt(val).toFixed(1) : null;
      }).filter(Boolean);
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
        + '\\nRaw pass: ' + pct(p.raw_pass_rate) + ' | Calibrated: ' + pct(p.calibrated_pass_rate)
        + ' | Mean P(pass): ' + pct(p.mean_pass_probability)
        + '\\nErrors: ' + p.findings.hard + ' (+' + p.findings.borderline + ' borderline)'
      );
      return '<g class="chart-point" role="button" tabindex="0" aria-label="Select snapshot ' + esc(isoDay(p.timestamp)) + '" data-select-run="' + i + '">'
        + (isActive ? '<line x1="' + x + '" y1="' + padT + '" x2="' + x + '" y2="' + (H - padB) + '" stroke="#2563eb" stroke-opacity="0.18" stroke-width="10"/>' : '')
        + '<circle cx="' + x + '" cy="' + yc + '" r="' + (isActive ? 4.5 : 3.2) + '" fill="#0d9488" stroke="#fff" stroke-width="1"><title>' + tip + '</title></circle>'
        + (ym !== null ? '<circle cx="' + x + '" cy="' + ym + '" r="' + (isActive ? 4.2 : 3) + '" fill="#7c3aed" stroke="#fff" stroke-width="1"><title>' + tip + '</title></circle>' : '')
        + '<circle cx="' + x + '" cy="' + yr + '" r="' + (isActive ? 6 : 4.2) + '" fill="#2563eb" stroke="#fff" stroke-width="1.5"><title>' + tip + '</title></circle>'
        + '</g>';
    }).join('');

    const step = Math.max(1, Math.ceil(points.length / 6));
    const xLabels = points.map((p, i) => {
      if (i !== 0 && i !== points.length - 1 && i % step !== 0) return '';
      const x = xAt(i).toFixed(1);
      return '<text x="' + x + '" y="' + (H - 10) + '" text-anchor="middle" font-size="10.5" fill="#64748b">' + esc(p.timestamp.slice(5, 10) + ' ' + p.commit_short) + '</text>';
    }).join('');

    return '<svg class="trend-svg" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Pass rate trend chart">'
      + gridLines + versionLines
      + polyline((p) => p.calibrated_pass_rate, '#0d9488', '6 3')
      + polyline((p) => p.mean_pass_probability, '#7c3aed', '2 4')
      + polyline((p) => p.raw_pass_rate, '#2563eb', '')
      + dots + xLabels + '</svg>';
  }

  function renderFixtureTrendSvg(points) {
    const W = 820, H = 190, padL = 50, padR = 24, padT = 24, padB = 32;
    const plotW = W - padL - padR;
    const plotH = H - padT - padB;
    const xAt = (i) => points.length <= 1 ? padL + plotW / 2 : padL + (i / (points.length - 1)) * plotW;
    const yAt = (v) => padT + (1 - Math.max(0, Math.min(1, v))) * plotH;

    const grid = [0, 0.5, 1].map((g) => {
      const y = yAt(g).toFixed(1);
      return '<line x1="' + padL + '" y1="' + y + '" x2="' + (W - padR) + '" y2="' + y + '" stroke="#e2e8f0" stroke-width="1"/>'
        + '<text x="' + (padL - 8) + '" y="' + (Number(y) + 4) + '" text-anchor="end" font-size="11" fill="#64748b">' + Math.round(g * 100) + '%</text>';
    }).join('');

    const versionLines = renderVersionMarkers(points, xAt, padT, H - padB);

    const coords = points.map((p, i) => xAt(i).toFixed(1) + ',' + yAt(p.check_pass_rate).toFixed(1));
    const line = coords.length >= 2
      ? '<polyline fill="none" stroke="#15803d" stroke-width="2.2" points="' + coords.join(' ') + '"/>'
      : '';

    const dots = points.map((p, i) => {
      const x = xAt(i).toFixed(1);
      const yPass = yAt(p.check_pass_rate).toFixed(1);
      const tip = esc(
        shortDate(p.timestamp) + ' · ' + p.judge_version
        + '\\nChecks passed: ' + p.checks_passed + '/' + p.checks_total + ' (' + pct(p.check_pass_rate) + ')'
        + '\\nMin margin: ' + (p.min_margin !== null ? p.min_margin.toFixed(3) : '—')
        + ' | Max jitter: ' + (p.max_jitter !== null ? p.max_jitter.toFixed(3) : '—')
      );
      return '<circle cx="' + x + '" cy="' + yPass + '" r="4.5" fill="#15803d" stroke="#fff" stroke-width="1.5"><title>' + tip + '</title></circle>';
    }).join('');

    const step = Math.max(1, Math.ceil(points.length / 6));
    const labels = points.map((p, i) => {
      if (i !== 0 && i !== points.length - 1 && i % step !== 0) return '';
      return '<text x="' + xAt(i).toFixed(1) + '" y="' + (H - 10) + '" text-anchor="middle" font-size="10.5" fill="#64748b">' + esc(p.timestamp.slice(5, 10) + ' ' + p.judge_version) + '</text>';
    }).join('');

    return '<svg class="trend-svg" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Rubric fixture pass rate trend">'
      + grid + versionLines + line + dots + labels + '</svg>';
  }

  function renderHeatmap() {
    const container = document.getElementById('heatmap-root');
    if (!container) return;
    const repos = DATA.repos || [];
    const modes = DATA.modes_present || [];
    if (repos.length === 0 || modes.length === 0) {
      container.innerHTML = '<div class="empty-state">No repository snapshots found in <code>runs/*.json</code>.</div>';
      return;
    }
    if (!DATA.heatmaps[heatmapMode]) heatmapMode = modes[0];
    const map = DATA.heatmaps[heatmapMode];
    const latestTag = DATA.catalog && DATA.catalog.agent_tooling ? DATA.catalog.agent_tooling.latest_tag : null;
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
      '<button type="button" role="tab" aria-selected="' + (m === heatmapMode ? 'true' : 'false') + '" class="tab-btn' + (m === heatmapMode ? ' active' : '') + '" data-heat-mode="' + esc(m) + '">' + esc(modeLabel(m)) + '</button>'
    ).join('');
    const groupOptions = '<option value="">All rubrics</option>' + groups.map((g) =>
      '<option value="' + esc(g) + '"' + (g === heatGroup ? ' selected' : '') + '>' + esc(g) + '</option>'
    ).join('');

    const headerCols = repos.map((repo) => {
      const isSelected = repo.name === selectedRepo;
      const errSummary = repo.total_findings.total === 0
        ? '<span class="pill pass">clean</span>'
        : (repo.total_findings.hard > 0
          ? '<span class="num-err">' + repo.total_findings.hard + ' err</span>' + (repo.total_findings.borderline > 0 ? '<span class="num-sub">+' + repo.total_findings.borderline + 'w</span>' : '')
          : '<span class="muted numeric">0 err</span><span class="num-sub">+' + repo.total_findings.borderline + 'w</span>');
      const modeCoverage = repo.modes.length + ' ' + (repo.modes.length === 1 ? 'mode' : 'modes') + ' · last run ' + isoDay(repo.latest_timestamp);
      const outdatedBadge = repo.installed_status === 'outdated' && repo.installed_judge_code
        ? '<div><span class="pill warn" title="Installed judge-code skill is outdated">judge-code ' + esc(repo.installed_judge_code.ref || 'outdated') + (latestTag ? ' → ' + esc(latestTag) : '') + '</span></div>'
        : '';
      return '<th class="heat-repo-th' + (isSelected ? ' heat-col-selected' : '') + '">'
        + '<button type="button" class="repo-col-btn' + (isSelected ? ' selected' : '') + '" data-pick-repo="' + esc(repo.name) + '" aria-pressed="' + (isSelected ? 'true' : 'false') + '">'
        + '<div class="repo-col-title"><span class="repo-col-name">' + esc(repo.name) + '</span><span>' + errSummary + '</span></div>'
        + '<div class="repo-col-meta"><code>' + esc(repo.latest_commit_short) + '</code>' + (repo.latest_dirty ? ' <span class="pill warn">dirty</span>' : '') + ' · ' + esc(modeCoverage) + '</div>'
        + outdatedBadge
        + '</button></th>';
    }).join('');

    const bodyRows = visibleRows.map((row) => {
      const label = row.instructions
        ? '<span class="tip-wrap"><span class="tip-trigger" tabindex="0">' + esc(row.check_id) + '</span><div class="tip-card"><strong>' + esc(row.instructions) + '</strong><div class="tip-pass"><strong>Pass:</strong> ' + esc(row.pass_criteria) + '</div><div class="tip-fail"><strong>Fail:</strong> ' + esc(row.fail_criteria) + '</div></div></span>'
        : '<code>' + esc(row.check_id) + '</code>';
      const cells = repos.map((repo) => {
        const rName = repo.name;
        const isColSel = rName === selectedRepo;
        const c = row.by_repo[rName];
        if (!c) return '<td class="numeric muted' + (isColSel ? ' heat-col-selected' : '') + '">—</td>';
        const col = heatCellStyle(c);
        const isActiveCell = isColSel && selectedMode === heatmapMode && activeRule === row.check_id;
        let topLine;
        let subLine;
        if (c.hard_failed > 0) {
          topLine = c.hard_failed + ' err';
          subLine = (c.borderline_failed > 0 ? '+' + c.borderline_failed + 'w · ' : '') + 'of ' + c.total;
        } else if (c.borderline_failed > 0) {
          topLine = '0 err';
          subLine = '+' + c.borderline_failed + 'w · of ' + c.total;
        } else {
          topLine = 'clean';
          subLine = 'P=' + (c.mean_pass_probability !== null ? c.mean_pass_probability.toFixed(2) : '—');
        }
        const tip = rName + ' · ' + row.check_id + ': ' + c.hard_failed + ' errors, ' + c.borderline_failed + ' borderline of ' + c.total + ' (mean P ' + pct(c.mean_pass_probability) + ')';
        return '<td class="numeric' + (isColSel ? ' heat-col-selected' : '') + '">'
          + '<button type="button" class="heat-cell-btn' + (isActiveCell ? ' heat-cell-active' : '') + '" style="background:' + col.bg + ';color:' + col.fg + '" '
          + 'data-heat-cell-repo="' + esc(rName) + '" data-heat-cell-rule="' + esc(row.check_id) + '" data-heat-cell-mode="' + esc(heatmapMode) + '" '
          + 'aria-pressed="' + (isActiveCell ? 'true' : 'false') + '" title="' + esc(tip) + '">'
          + '<strong>' + esc(topLine) + '</strong><span>' + esc(subLine) + '</span>'
          + '</button></td>';
      }).join('');
      return '<tr><td>' + label + (row.rubric_slug ? ' <span class="muted" style="font-size:.74rem">' + esc(row.rubric_slug) + '</span>' : '') + '</td><td class="numeric">' + renderThresholdCell(row.threshold) + '</td>' + cells + '</tr>';
    }).join('');

    container.innerHTML =
      '<div class="controls">'
      + '<div class="mode-control"><span class="control-label">Mode</span><div class="tabs" role="tablist" aria-label="Heatmap mode">' + modeTabs + '</div></div>'
      + '<select id="heat-group-select" aria-label="Filter rubric group">' + groupOptions + '</select>'
      + '<input type="search" id="heat-search-input" placeholder="Search rule ID..." value="' + esc(heatSearch) + '">'
      + '<span class="muted numeric" style="margin-left:auto">' + visibleRows.length + ' of ' + map.rows.length + ' rules</span>'
      + '</div>'
      + '<div class="table-scroll"><table><thead><tr><th>Rule</th><th>Threshold</th>' + headerCols + '</tr></thead><tbody>' + bodyRows + '</tbody></table></div>';
  }

  function renderRulesBreakdownCard(run, checkEntries) {
    const checkRows = checkEntries.map(([cid, c]) => {
      const fc = countCheckSummaryFindings(c);
      const isActive = activeRule === cid;
      return '<tr class="rule-pick-row' + (isActive ? ' active-rule-row' : '') + '" role="button" tabindex="0" aria-pressed="' + (isActive ? 'true' : 'false') + '" data-filter-rule="' + esc(cid) + '">'
        + '<td>' + checkLabelWithTip(cid) + (c.rubric_group ? ' <span class="muted" style="font-size:.74rem">' + esc(c.rubric_group) + '</span>' : '') + '</td>'
        + '<td class="numeric">' + renderThresholdCell(c.threshold) + '</td>'
        + '<td class="numeric">' + (fc.hard > 0 ? '<span class="num-err">' + fc.hard + '</span><span class="num-sub">/' + c.total + '</span>' : '<span class="muted">0</span>') + '</td>'
        + '<td class="numeric">' + (fc.borderline > 0 ? '<span class="muted">' + fc.borderline + '</span>' : '<span class="muted">0</span>') + '</td>'
        + '<td class="numeric">' + (typeof c.min_pass_probability === 'number' ? c.min_pass_probability.toFixed(2) : '—') + '</td>'
        + '<td class="numeric">' + pct(c.mean_pass_probability) + '</td>'
        + '</tr>';
    }).join('');

    const failingCount = checkEntries.filter(([, c]) => c.passed < c.total).length;
    return '<div class="sub-card">'
      + '<div class="panel-head"><h3>Worst-offending rules (' + failingCount + ' failing / ' + checkEntries.length + ')</h3><span class="muted numeric">' + esc(isoDay(run.timestamp)) + ' · <code>' + esc(run.commit_short) + '</code></span></div>'
      + '<div class="table-scroll"><table><thead><tr><th>Rule</th><th>Threshold</th><th>Errors</th><th>Borderline</th><th>Min P</th><th>Mean P</th></tr></thead><tbody>' + checkRows + '</tbody></table></div>'
      + '</div>';
  }

  function renderModuleArchitectureView(repoObj, run) {
    if (!run || !run.modules || run.modules.length === 0) {
      return '<div class="quiet-note" id="module-architecture-slot"><span>Module architecture checks are off. Add <code>modules</code> / <code>moduleRoots</code> to enable.</span></div>';
    }
    const allModules = run.modules;
    const filtered = allModules.filter((m) => {
      if (moduleFailingOnly && m.status === 'scored' && m.failed_count === 0) return false;
      if (activeRule) {
        return (m.failing_checks || []).some((c) => c.check_id === activeRule);
      }
      if (moduleSearch) {
        const q = moduleSearch.toLowerCase();
        const checkIds = (m.failing_checks || []).map((c) => c.check_id).join(' ').toLowerCase();
        return m.name.toLowerCase().includes(q)
          || m.path.toLowerCase().includes(q)
          || checkIds.includes(q)
          || (m.error || '').toLowerCase().includes(q);
      }
      return true;
    });

    const rows = filtered.map((m) => {
      const sizeBits = [];
      if (m.file_count > 0) sizeBits.push(m.file_count + ' file' + (m.file_count === 1 ? '' : 's'));
      const kb = fmtKiB(m.bytes);
      if (kb) sizeBits.push(kb);
      const subMeta = '<div class="muted" style="font-size:.74rem"><code>' + esc(m.path) + '</code>' + (sizeBits.length ? ' · ' + esc(sizeBits.join(' · ')) : '') + '</div>';

      let statusCell;
      let detailCell;
      if (m.status === 'skipped') {
        statusCell = '<span class="pill warn">skipped: ' + esc(m.skip_reason || 'oversize') + '</span>';
        detailCell = '<span class="muted">' + esc(m.error || 'Skipped during scan') + '</span>';
      } else if (m.status === 'error') {
        statusCell = '<span class="pill fail">error</span>';
        detailCell = '<span class="tone-bad" style="font-size:.8rem">' + esc(m.error || 'Module scan failed') + '</span>';
      } else if (m.failed_count === 0) {
        statusCell = '<span class="pill pass">clean</span>';
        detailCell = '<span class="muted">All ' + m.total_checks + ' architectural checks passed</span>';
      } else {
        statusCell = renderErrorsInline({ total: m.failed_count, hard: m.hard_fail_count, borderline: m.borderline_count });
        detailCell = '<div class="rule-tags">' + m.failing_checks.map((c) => {
          const cls = 'rule-tag ' + (c.severity === 'hard' ? 'rule-tag-hard' : 'rule-tag-borderline') + (activeRule === c.check_id ? ' rule-tag-active' : '');
          const pText = typeof c.pass_probability === 'number' ? c.pass_probability.toFixed(2) : 'fail';
          return '<button type="button" class="' + cls + '" data-filter-rule="' + esc(c.check_id) + '" aria-pressed="' + (activeRule === c.check_id ? 'true' : 'false') + '" title="' + esc(c.severity === 'hard' ? 'Error (raw FAIL)' : 'Borderline (P < ' + c.threshold.toFixed(2) + ')') + '">' + esc(c.check_id) + ' (' + esc(pText) + ')</button>';
        }).join('') + '</div>';
      }

      return '<tr>'
        + '<td><strong>' + esc(m.name) + '</strong>' + subMeta + '</td>'
        + '<td class="numeric">' + statusCell + '</td>'
        + '<td class="numeric">' + (typeof m.min_pass_probability === 'number' ? m.min_pass_probability.toFixed(2) : '—') + '</td>'
        + '<td>' + detailCell + '</td>'
        + '</tr>';
    }).join('');

    const statusSummary = [
      run.modules_scored + '/' + allModules.length + ' scored',
      run.modules_skipped > 0 ? run.modules_skipped + ' skipped' : null,
      run.modules_errored > 0 ? run.modules_errored + ' errored' : null,
    ].filter(Boolean).join(' · ');

    const checkEntries = Object.entries(run.checks || {}).sort((a, b) => {
      const fa = countCheckSummaryFindings(a[1]);
      const fb = countCheckSummaryFindings(b[1]);
      return (fb.hard - fa.hard) || (fb.total - fa.total) || ((a[1].min_pass_probability ?? 1) - (b[1].min_pass_probability ?? 1)) || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
    });

    return '<div class="arch-card" id="module-architecture-section">'
      + '<div class="panel-head">'
      + '<div><h3>Feature / Module Architecture (' + allModules.length + ' module' + (allModules.length === 1 ? '' : 's') + ')</h3>'
      + '<div class="muted numeric" style="font-size:.78rem">' + esc(statusSummary) + ' · ' + esc(isoDay(run.timestamp)) + ' · <code>' + esc(run.commit_short) + '</code></div></div>'
      + '<div class="numeric">' + renderErrorsInline(run.findings) + '</div>'
      + '</div>'
      + '<div class="controls" style="margin-bottom:10px">'
      + '<input type="search" id="module-search-input" placeholder="Filter module, path, or rule..." value="' + esc(moduleSearch) + '">'
      + '<label class="toggle"><input type="checkbox" id="module-failing-only-toggle"' + (moduleFailingOnly ? ' checked' : '') + '> Failing &amp; skipped only</label>'
      + '<span class="muted numeric" style="margin-left:auto">' + filtered.length + ' of ' + allModules.length + ' shown</span>'
      + '</div>'
      + (filtered.length > 0
        ? '<div class="table-scroll"><table><thead><tr><th>Module</th><th>Errors</th><th>Min P</th><th>Failing architectural checks</th></tr></thead><tbody>' + rows + '</tbody></table></div>'
        : '<p class="muted">No modules match the current filter.</p>')
      + '</div>'
      + (checkEntries.length > 0 ? renderRulesBreakdownCard(run, checkEntries) : '');
  }

  function renderRepoDetail() {
    const container = document.getElementById('repo-detail-root');
    if (!container) return;
    const sel = ensureSelection();
    if (!sel) {
      container.innerHTML = '<div class="empty-state">No repository snapshots recorded yet. Run <code>pnpm rubrics:scan --config &lt;config.json&gt;</code> to populate snapshots.</div>';
      return;
    }
    const { repoObj, series, run } = sel;

    const availableModes = [...repoObj.modes];
    if (!availableModes.includes('code')) availableModes.push('code');
    const modeTabs = availableModes.map((m) => {
      const mSeries = repoObj.by_mode[m];
      const isSelected = m === selectedMode;
      const errCount = mSeries ? mSeries.latest.findings.hard : null;
      const suffix = errCount === null ? '' : (errCount > 0 ? ' · ' + errCount : '');
      return '<button type="button" role="tab" aria-selected="' + (isSelected ? 'true' : 'false') + '" class="tab-btn' + (isSelected ? ' active' : '') + (!mSeries ? ' tab-muted' : '') + '" data-pick-mode="' + esc(m) + '">' + esc(modeLabel(m)) + esc(suffix) + '</button>';
    }).join('');

    const headerMeta = '<code>' + esc(repoObj.latest_commit_short) + '</code>'
      + (repoObj.latest_dirty ? ' <span class="pill warn">dirty</span>' : '')
      + (repoObj.latest_branch ? ' · ' + esc(repoObj.latest_branch) : '')
      + ' · ' + repoObj.modes.length + ' ' + (repoObj.modes.length === 1 ? 'mode' : 'modes')
      + ' · last run ' + esc(isoDay(repoObj.latest_timestamp));

    const detailHeader =
      '<div class="panel-head">'
      + '<div><h2>' + esc(repoObj.name) + '</h2><div class="muted numeric" style="font-size:.79rem;margin-top:2px">' + headerMeta + '</div></div>'
      + '<div class="mode-control"><span class="control-label">Mode</span><div class="tabs" role="tablist" aria-label="Select inspection mode">' + modeTabs + '</div></div>'
      + '</div>';

    if (!series || !run) {
      container.innerHTML = detailHeader
        + '<div class="quiet-note" id="module-architecture-slot"><span>Module architecture checks are off. Add <code>modules</code> / <code>moduleRoots</code> to enable.</span></div>';
      return;
    }

    const activeRuleBanner = activeRule
      ? '<div class="filter-banner" id="active-rule-banner"><span>Filtered by rule <code>' + esc(activeRule) + '</code></span><button type="button" class="clear-btn" data-clear-rule>Clear filter &times;</button></div>'
      : '';

    let trendBlock;
    if (series.points.length < 2) {
      trendBlock = '<div class="single-run-note">'
        + '<span>First snapshot ' + esc(isoDay(run.timestamp)) + ' · trend appears after the next run</span>'
        + '<span class="muted numeric">Run 1/1 · ' + esc(run.model) + '</span>'
        + '</div>';
    } else {
      const legendItems = trendMetric === 'errors'
        ? '<span class="legend-item"><span class="legend-swatch" style="background:#b91c1c"></span>Errors (raw FAIL)</span>'
          + '<span class="legend-item"><span class="legend-swatch dashed-slate"></span>Total (incl. borderline)</span>'
        : '<span class="legend-item"><span class="legend-swatch" style="background:#2563eb"></span>Raw pass rate</span>'
          + '<span class="legend-item"><span class="legend-swatch dashed"></span>Calibrated pass rate</span>'
          + '<span class="legend-item"><span class="legend-swatch dotted"></span>Mean P(pass)</span>';
      trendBlock = '<div class="chart-box">'
        + '<div class="chart-legend">'
        + '<div class="tabs" role="tablist" aria-label="Trend metric">'
        + '<button type="button" role="tab" aria-selected="' + (trendMetric === 'errors' ? 'true' : 'false') + '" class="tab-btn' + (trendMetric === 'errors' ? ' active' : '') + '" data-trend-metric="errors">Errors</button>'
        + '<button type="button" role="tab" aria-selected="' + (trendMetric === 'rates' ? 'true' : 'false') + '" class="tab-btn' + (trendMetric === 'rates' ? ' active' : '') + '" data-trend-metric="rates">Pass rates</button>'
        + '</div>'
        + legendItems
        + '<span class="muted numeric" style="margin-left:auto">Run ' + (selectedRunIdx + 1) + '/' + series.points.length + ' · ' + esc(run.model) + '</span>'
        + '</div>'
        + '<div class="svg-wrap">' + (trendMetric === 'errors' ? renderErrorsTrendSvg(series.points, selectedRunIdx) : renderRateTrendSvg(series.points, selectedRunIdx)) + '</div>'
        + '</div>';
    }

    const versionBanner = run.version_changed
      ? '<div class="version-banner"><strong>Rubric / judge change at this snapshot:</strong> ' + esc(run.change_reasons.join(' · ')) + '</div>'
      : '';

    let modeBody = '';
    if (selectedMode === 'code') {
      modeBody = renderModuleArchitectureView(repoObj, run);
    } else {
      const checkEntries = Object.entries(run.checks).sort((a, b) => {
        const fa = countCheckSummaryFindings(a[1]);
        const fb = countCheckSummaryFindings(b[1]);
        return (fb.hard - fa.hard)
          || (fb.total - fa.total)
          || ((a[1].min_pass_probability ?? 1) - (b[1].min_pass_probability ?? 1))
          || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
      });

      const filteredFiles = run.files.filter((f) => {
        if (activeRule) {
          return Boolean(f.checks && f.checks[activeRule] && f.checks[activeRule].choice === 'fail');
        }
        if (failingOnly && selectedMode === 'file' && f.failed_count === 0) return false;
        if (fileSearch) {
          const q = fileSearch.toLowerCase();
          const failedIds = Object.keys(f.checks).filter((k) => f.checks[k].choice === 'fail').join(' ').toLowerCase();
          return f.path.toLowerCase().includes(q) || failedIds.includes(q);
        }
        return true;
      });

      const prefix = sharedPathPrefix(run.files.map((f) => f.path));
      const visibleFiles = showAllFiles ? filteredFiles : filteredFiles.slice(0, DEFAULT_HOTSPOT_LIMIT);

      const hotspotRows = visibleFiles.map((f) => {
        const fc = countFileFindings(f.checks);
        const failedChecks = Object.entries(f.checks)
          .filter(([, c]) => c.choice === 'fail')
          .sort((a, b) =>
            (Number(b[0] === activeRule) - Number(a[0] === activeRule))
            || ((a[1].pass_probability ?? 0) - (b[1].pass_probability ?? 0))
            || (Number(classifyScore(b[1]) === 'hard') - Number(classifyScore(a[1]) === 'hard'))
            || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)
          );

        let rulesCell;
        if (failedChecks.length === 0) {
          rulesCell = '<span class="pill pass">clean</span>';
        } else {
          const isExpanded = expandedFiles.has(f.path);
          const shownChecks = isExpanded ? failedChecks : failedChecks.slice(0, MAX_VISIBLE_RULE_TAGS);
          const remaining = failedChecks.length - shownChecks.length;
          const tags = shownChecks.map(([cid, c]) => {
            const sev = classifyScore(c) || 'hard';
            const thr = run.checks[cid] ? run.checks[cid].threshold : 0.8;
            const pText = typeof c.pass_probability === 'number' ? c.pass_probability.toFixed(2) : 'fail';
            const cls = 'rule-tag ' + (sev === 'hard' ? 'rule-tag-hard' : 'rule-tag-borderline') + (activeRule === cid ? ' rule-tag-active' : '');
            const title = (sev === 'hard' ? 'Error (raw FAIL, P=' + pText + ')' : 'Borderline (P=' + pText + ' < ' + thr.toFixed(2) + ')') + ' — click to filter';
            return '<button type="button" class="' + cls + '" data-filter-rule="' + esc(cid) + '" aria-pressed="' + (activeRule === cid ? 'true' : 'false') + '" title="' + esc(title) + '">' + esc(cid) + '</button>';
          });
          if (remaining > 0) {
            tags.push('<button type="button" class="rule-tag rule-tag-more" data-expand-file="' + esc(f.path) + '" aria-expanded="false">+' + remaining + ' more</button>');
          } else if (isExpanded && failedChecks.length > MAX_VISIBLE_RULE_TAGS) {
            tags.push('<button type="button" class="rule-tag rule-tag-more" data-expand-file="' + esc(f.path) + '" aria-expanded="true">show fewer</button>');
          }
          rulesCell = '<div class="rule-tags">' + tags.join('') + '</div>';
        }

        return '<tr>'
          + '<td class="file-path-cell">' + renderShortPath(f.path, prefix) + '</td>'
          + '<td class="numeric">' + renderErrorsInline(fc) + '</td>'
          + '<td class="numeric">' + (typeof f.min_pass_probability === 'number' ? f.min_pass_probability.toFixed(2) : '—') + '</td>'
          + '<td>' + rulesCell + '</td>'
          + '</tr>';
      }).join('');

      const toggleMoreFooter = filteredFiles.length > DEFAULT_HOTSPOT_LIMIT
        ? '<div class="hotspot-footer">'
          + '<span class="numeric">Showing ' + visibleFiles.length + ' of ' + filteredFiles.length + ' matching files</span>'
          + '<button type="button" class="link-btn" data-toggle-all-files>' + (showAllFiles ? 'Show top ' + DEFAULT_HOTSPOT_LIMIT : 'Show all ' + filteredFiles.length) + '</button>'
          + '</div>'
        : '';

      const hotspotCard = '<div class="sub-card" id="hotspots-card">'
        + '<div class="panel-head">'
        + '<div><h3>Hotspot ' + (selectedMode === 'structure' ? 'targets' : 'files') + ' (' + filteredFiles.length + ' / ' + run.files.length + ')</h3>'
        + (prefix ? '<div class="muted" style="font-size:.73rem">Base: <code>' + esc(prefix) + '</code></div>' : '')
        + '</div>'
        + '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">'
        + '<input type="search" id="file-search-input" placeholder="Filter path or rule..." value="' + esc(fileSearch) + '">'
        + (selectedMode === 'file' ? '<label class="toggle"><input type="checkbox" id="failing-only-toggle"' + (failingOnly ? ' checked' : '') + '> Failing only</label>' : '')
        + '</div></div>'
        + (filteredFiles.length > 0
          ? '<div class="table-scroll"><table><thead><tr><th>Target</th><th>Errors</th><th>Min P</th><th>Failing rules</th></tr></thead><tbody>' + hotspotRows + '</tbody></table></div>' + toggleMoreFooter
          : '<p class="muted">' + (activeRule
            ? 'No files failed <code>' + esc(activeRule) + '</code> in this snapshot.'
            : (failingOnly && selectedMode === 'file' && !fileSearch && run.files.length > 0
              ? 'All ' + run.files.length + ' file(s) passed every check. Uncheck "Failing only" to inspect all files.'
              : 'No targets match the current filter.')) + '</p>')
        + '</div>';

      const moduleSetupNote = !repoObj.module_architecture
        ? '<div class="quiet-note" id="module-architecture-slot"><span>Module architecture checks are off. Add <code>modules</code> / <code>moduleRoots</code> to enable.</span></div>'
        : '';

      modeBody = '<div class="split-grid">'
        + renderRulesBreakdownCard(run, checkEntries)
        + hotspotCard
        + '</div>'
        + moduleSetupNote;
    }

    const runRows = [...series.points].reverse().map((p, revIdx) => {
      const idx = series.points.length - 1 - revIdx;
      const dh = typeof p.delta_hard_fails === 'number' ? p.delta_hard_fails : null;
      const dClass = dh === null ? 'muted' : dh < 0 ? 'num-ok' : dh > 0 ? 'num-err' : 'muted';
      const dText = dh === null ? '—' : (dh > 0 ? '+' + dh : String(dh));
      return '<tr class="run-row' + (idx === selectedRunIdx ? ' active-run' : '') + '" role="button" tabindex="0" aria-pressed="' + (idx === selectedRunIdx ? 'true' : 'false') + '" data-select-run="' + idx + '">'
        + '<td class="numeric">' + esc(shortDate(p.timestamp)) + '</td>'
        + '<td><code>' + esc(p.commit_short) + '</code>' + (p.dirty ? ' <span class="pill warn">dirty</span>' : '') + (p.branch ? ' <span class="muted">' + esc(p.branch) + '</span>' : '') + '</td>'
        + '<td class="numeric">' + (selectedMode === 'code' && p.modules.length > 0 ? p.modules_scored + '/' + p.modules.length + ' mod' : p.file_count) + '</td>'
        + '<td class="numeric">' + (p.findings.hard > 0 ? '<span class="num-err">' + p.findings.hard + '</span>' : '<span class="muted">0</span>') + '</td>'
        + '<td class="numeric muted">' + p.findings.borderline + '</td>'
        + '<td class="numeric"><span class="' + dClass + '">' + esc(dText) + '</span>' + (p.version_changed ? ' <span class="pill warn" title="' + esc(p.change_reasons.join('; ')) + '">rubric &Delta;</span>' : '') + '</td>'
        + '<td class="numeric muted">' + pct(p.calibrated_pass_rate) + '</td>'
        + '<td><code>' + esc(p.judge_version) + '</code></td>'
        + '<td class="numeric">' + esc(fmtUsd(p.cost_usd)) + '</td>'
        + '</tr>';
    }).join('');

    const historyOpen = series.points.length > 1 && series.points.length <= 10 ? ' open' : '';
    const historyDetails = '<details style="margin-top:14px"' + historyOpen + '>'
      + '<summary class="panel-summary" style="font-size:.88rem"><span><strong>Run history</strong> (' + series.points.length + ' snapshot' + (series.points.length === 1 ? '' : 's') + ')</span></summary>'
      + '<div class="table-scroll" style="margin-top:8px"><table><thead><tr><th>Timestamp</th><th>Commit / Branch</th><th>Scope</th><th>Errors</th><th>Borderline</th><th>Error &Delta;</th><th>Calibrated</th><th>Judge version</th><th>Cost</th></tr></thead><tbody>' + runRows + '</tbody></table></div>'
      + '</details>';

    container.innerHTML = detailHeader + activeRuleBanner + trendBlock + versionBanner + modeBody + historyDetails;
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
    const allPassed = latest.status === 'passed' && latest.checks_passed === latest.checks_total;
    const minMarginText = latest.min_margin !== null ? latest.min_margin.toFixed(2) : '—';
    const maxJitterText = latest.max_jitter !== null ? latest.max_jitter.toFixed(2) : '—';

    let trendSection;
    if (fx.points.length < 2) {
      trendSection = '<div class="single-run-note">'
        + '<span>First snapshot ' + esc(isoDay(latest.timestamp)) + ' · trend appears after the next run</span>'
        + '<span class="muted numeric">' + latest.fixtures_passed + '/' + latest.fixtures_total + ' fixtures · repeats ' + latest.repeats + '</span>'
        + '</div>';
    } else {
      trendSection = '<div class="chart-box">'
        + '<div class="chart-legend">'
        + '<span class="legend-item"><span class="legend-swatch" style="background:#15803d"></span>Fixture check pass rate</span>'
        + '<span class="muted numeric" style="margin-left:auto">Latest ' + esc(isoDay(latest.timestamp)) + ' · ' + latest.fixtures_passed + '/' + latest.fixtures_total + ' fixtures · repeats ' + latest.repeats + ' · min margin ' + minMarginText + ' · max jitter ' + maxJitterText + '</span>'
        + '</div>'
        + '<div class="svg-wrap">' + renderFixtureTrendSvg(fx.points) + '</div>'
        + '</div>';
    }

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
      const marginCls = c.margin === null ? 'muted' : c.margin < 0 ? 'num-err' : c.margin < 0.10 ? 'num-warn' : '';
      const jitterCls = c.jitter === null ? 'muted' : (!c.passed || c.jitter >= 0.15) ? 'num-err' : c.jitter >= 0.08 ? 'num-warn' : '';
      const repeatsCls = c.passed ? '' : 'num-err';
      return '<tr>'
        + '<td><code>' + esc(c.fixture_id) + '</code></td>'
        + '<td><code>' + esc(c.check_id) + '</code></td>'
        + '<td class="muted">' + esc(c.expected) + '</td>'
        + '<td><span class="pill ' + (c.passed ? 'pass' : 'fail') + '">' + (c.passed ? 'pass' : 'fail') + '</span></td>'
        + '<td class="numeric ' + repeatsCls + '">' + c.matches + '/' + c.repeats + '</td>'
        + '<td class="numeric">' + esc(probRange) + '</td>'
        + '<td class="numeric muted">' + (c.pass_threshold !== null ? '&ge;' + c.pass_threshold.toFixed(2) : '—') + '</td>'
        + '<td class="numeric ' + marginCls + '">' + (c.margin !== null ? (c.margin >= 0 ? '+' : '') + c.margin.toFixed(3) : '—') + '</td>'
        + '<td class="numeric ' + jitterCls + '">' + (c.jitter !== null ? c.jitter.toFixed(3) : '—') + '</td>'
        + '</tr>';
    }).join('');

    const summaryLine = '<span class="pill ' + (allPassed ? 'pass' : 'fail') + '">' + (allPassed ? 'pass' : 'fail') + '</span> '
      + '<strong>' + latest.checks_passed + '/' + latest.checks_total + ' checks pass</strong>'
      + ' · min margin ' + minMarginText + ' · max jitter ' + maxJitterText;

    container.innerHTML = trendSection
      + '<details class="fixture-details"' + (allPassed ? '' : ' open') + '>'
      + '<summary class="panel-summary"><span class="numeric">' + summaryLine + '</span><span class="muted numeric">' + (allPassed ? 'All green · click to inspect checks' : 'Failing checks expanded') + '</span></summary>'
      + '<div class="table-scroll" style="margin-top:10px"><table><thead><tr><th>Fixture</th><th>Check</th><th>Expect</th><th>Status</th><th>Repeats</th><th>P(pass)</th><th>Threshold</th><th>Margin</th><th>Jitter</th></tr></thead><tbody>' + rows + '</tbody></table></div>'
      + '</details>';
  }

  function renderAll(pushHash) {
    ensureSelection();
    renderHeatmap();
    renderRepoDetail();
    syncUrlHash(Boolean(pushHash));
  }

  function selectRuleFilter(ruleId, scrollToDetail) {
    const nextRule = activeRule === ruleId && !scrollToDetail ? '' : ruleId;
    activeRule = nextRule;
    if (selectedMode === 'code') {
      moduleSearch = nextRule;
    } else {
      fileSearch = nextRule;
    }
    showAllFiles = false;
    renderAll(true);
    if (scrollToDetail) {
      const target = document.getElementById('hotspots-card') || document.getElementById('repo-detail-panel');
      if (target && target.scrollIntoView) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }

  document.addEventListener('click', (ev) => {
    const t = ev.target;
    if (!t || !t.closest) return;

    const heatCell = t.closest('[data-heat-cell-repo]');
    if (heatCell) {
      const repo = heatCell.dataset.heatCellRepo;
      const rule = heatCell.dataset.heatCellRule;
      const mode = heatCell.dataset.heatCellMode;
      selectedRepo = repo;
      if (mode) selectedMode = mode;
      selectedRunIdx = null;
      showAllFiles = false;
      expandedFiles = new Set();
      activeRule = rule || '';
      if (selectedMode === 'code') moduleSearch = activeRule;
      else fileSearch = activeRule;
      renderAll(true);
      const target = document.getElementById('hotspots-card') || document.getElementById('repo-detail-panel');
      if (target && target.scrollIntoView) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }

    const repoBtn = t.closest('[data-pick-repo]');
    if (repoBtn) {
      const name = repoBtn.dataset.pickRepo;
      if (name) {
        selectedRepo = name;
        selectedRunIdx = null;
        showAllFiles = false;
        expandedFiles = new Set();
        const repoObj = (DATA.repos || []).find((r) => r.name === name);
        if (repoObj && repoObj.by_mode[heatmapMode]) {
          selectedMode = heatmapMode;
        }
        renderAll(true);
      }
      return;
    }

    const modeBtn = t.closest('[data-pick-mode]');
    if (modeBtn) {
      selectedMode = modeBtn.dataset.pickMode;
      selectedRunIdx = null;
      activeRule = '';
      fileSearch = '';
      moduleSearch = '';
      showAllFiles = false;
      expandedFiles = new Set();
      if (DATA.heatmaps && DATA.heatmaps[selectedMode]) {
        heatmapMode = selectedMode;
      }
      renderAll(true);
      return;
    }

    const clearRule = t.closest('[data-clear-rule]');
    if (clearRule) {
      activeRule = '';
      fileSearch = '';
      moduleSearch = '';
      renderAll(true);
      return;
    }

    const expandFileBtn = t.closest('[data-expand-file]');
    if (expandFileBtn) {
      const path = expandFileBtn.dataset.expandFile;
      if (path) {
        if (expandedFiles.has(path)) expandedFiles.delete(path);
        else expandedFiles.add(path);
        renderRepoDetail();
      }
      return;
    }

    const toggleAllBtn = t.closest('[data-toggle-all-files]');
    if (toggleAllBtn) {
      showAllFiles = !showAllFiles;
      renderRepoDetail();
      return;
    }

    const ruleBtn = t.closest('[data-filter-rule]');
    if (ruleBtn) {
      if (t.closest('.tip-card')) return;
      const ruleId = ruleBtn.dataset.filterRule;
      if (ruleId) selectRuleFilter(ruleId, false);
      return;
    }

    const metricBtn = t.closest('[data-trend-metric]');
    if (metricBtn) {
      trendMetric = metricBtn.dataset.trendMetric;
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

  document.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Enter' && ev.key !== ' ') return;
    const t = ev.target;
    if (!t || !t.closest) return;
    const tag = t.tagName ? t.tagName.toLowerCase() : '';
    if (tag === 'button' || tag === 'input' || tag === 'select' || tag === 'a' || tag === 'summary') return;
    const roleBtn = t.closest('[role="button"]');
    if (roleBtn) {
      ev.preventDefault();
      roleBtn.click();
    }
  });

  document.addEventListener('input', (ev) => {
    const t = ev.target;
    if (!t) return;
    if (t.id === 'file-search-input') {
      fileSearch = t.value;
      if (activeRule && fileSearch.trim() !== activeRule) {
        activeRule = '';
        syncUrlHash(false);
        renderHeatmap();
      }
      const pos = t.selectionStart;
      renderRepoDetail();
      const el = document.getElementById('file-search-input');
      if (el) { el.focus(); if (typeof pos === 'number') el.setSelectionRange(pos, pos); }
    } else if (t.id === 'module-search-input') {
      moduleSearch = t.value;
      if (activeRule && moduleSearch.trim() !== activeRule) {
        activeRule = '';
        syncUrlHash(false);
        renderHeatmap();
      }
      const pos = t.selectionStart;
      renderRepoDetail();
      const el = document.getElementById('module-search-input');
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
      showAllFiles = false;
      renderRepoDetail();
    } else if (t.id === 'module-failing-only-toggle') {
      moduleFailingOnly = t.checked;
      renderRepoDetail();
    } else if (t.id === 'heat-group-select') {
      heatGroup = t.value;
      renderHeatmap();
    }
  });

  window.addEventListener('hashchange', () => {
    if (lastWrittenHash !== null && window.location.hash === lastWrittenHash) {
      lastWrittenHash = null;
      return;
    }
    lastWrittenHash = null;
    applyHashState();
    ensureSelection();
    renderHeatmap();
    renderRepoDetail();
  });

  applyHashState();
  renderAll(false);
  renderFixtures();
})();
`;

export function renderDashboardHtml(model: DashboardModel): string {
  const latestTag = model.catalog.agent_tooling.latest_tag;
  const fxLatest = model.fixtures.latest;
  const versionDisplay = formatToolingVersion(model.catalog.agent_tooling.judge_version, latestTag);

  const warningsHtml = model.warnings.length > 0
    ? `<div class="warn-banner"><strong>Snapshot warnings (${model.warnings.length}):</strong> ${escapeHtml(model.warnings.join(' | '))}</div>`
    : '';

  const totalFindings = model.totals.total_findings;
  const modFindings = model.totals.module_findings;
  const hasModules = model.totals.modules_scanned > 0;
  const errorsKpiClass = totalFindings.hard > 0 ? ' kpi-danger' : '';
  const modKpiClass = modFindings.hard > 0 || model.totals.modules_errored > 0
    ? ' kpi-danger'
    : model.totals.modules_skipped > 0
      ? ' kpi-alert'
      : '';

  const scopeParts = [
    `${model.totals.file_findings.hard} file`,
    `${model.totals.structure_findings.hard} structure`,
    ...(hasModules ? [`${modFindings.hard} module`] : []),
  ];

  const moduleKpiTile = hasModules
    ? `<div class="kpi${modKpiClass}"><div class="kpi-label">Module architecture</div><div class="kpi-value${errorsTone(modFindings)}">${modFindings.hard} ${modFindings.hard === 1 ? 'error' : 'errors'}</div><div class="kpi-sub">+${modFindings.borderline} borderline · ${model.totals.modules_with_findings}/${model.totals.modules_scanned} modules${model.totals.modules_skipped > 0 ? ` · ${model.totals.modules_skipped} skipped` : ''}${model.totals.modules_errored > 0 ? ` · ${model.totals.modules_errored} err` : ''}</div></div>`
    : '';

  const qualityCols = hasModules ? 3 : 2;
  const heroSub = totalFindings.total === 0
    ? `All clean across ${model.totals.repo_count} repo${model.totals.repo_count === 1 ? '' : 's'}`
    : `+${totalFindings.borderline} borderline across ${model.totals.repo_count} repo${model.totals.repo_count === 1 ? '' : 's'}`;

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'">
<title>Rubric Quality Punch-List · agent-tooling</title><style>${STYLE}</style></head><body><main>
<header>
  <div class="title-row"><h1>Rubric Quality Punch-List</h1><span class="pill-header">Offline · Local</span></div>
  <div class="meta-bar">
    <span>agent-tooling <strong>${escapeHtml(versionDisplay)}</strong></span>
    <span>Authoritative rubrics <strong>${model.catalog.rubrics.length}</strong></span>
    <span>Recorded spend <strong>${escapeHtml(fmtUsd(model.totals.total_cost_usd))}</strong></span>
    <span>Built <strong>${escapeHtml(model.generated_at.replace('T', ' ').slice(0, 19))}Z</strong></span>
  </div>
</header>

${warningsHtml}

<section class="kpi-bar" aria-label="Dashboard overview">
  <div class="kpi-group kpi-group-quality">
    <div class="kpi-group-eyebrow">Code quality</div>
    <div class="kpi-grid" style="--kpi-cols:${qualityCols}">
      <div class="kpi${errorsKpiClass}"><div class="kpi-label">Open errors (raw FAIL)</div><div class="kpi-value${errorsTone(totalFindings)}">${totalFindings.hard}</div><div class="kpi-sub">${escapeHtml(heroSub)}</div></div>
      ${moduleKpiTile}
      <div class="kpi"><div class="kpi-label">Errors by scope</div><div class="kpi-value kpi-value-sm">${model.totals.repo_count} repo${model.totals.repo_count === 1 ? '' : 's'}</div><div class="kpi-sub">${escapeHtml(scopeParts.join(' · '))} · ${model.totals.repo_runs} snapshot${model.totals.repo_runs === 1 ? '' : 's'}</div></div>
    </div>
  </div>
  <div class="kpi-group kpi-group-tooling">
    <div class="kpi-group-eyebrow">Tooling health</div>
    <div class="kpi-grid" style="--kpi-cols:2">
      <div class="kpi${fxLatest && fxLatest.status === 'failed' ? ' kpi-danger' : ''}"><div class="kpi-label">Rubric fixtures</div><div class="kpi-value kpi-value-sm${fxLatest ? (fxLatest.status === 'passed' ? ' tone-good' : ' tone-bad') : ''}">${fxLatest ? `${fxLatest.checks_passed}/${fxLatest.checks_total}` : '—'}</div><div class="kpi-sub">${fxLatest ? `min margin ${fxLatest.min_margin !== null ? fxLatest.min_margin.toFixed(2) : '—'} · max jitter ${fxLatest.max_jitter !== null ? fxLatest.max_jitter.toFixed(2) : '—'}` : 'No fixture runs yet'}</div></div>
      <div class="kpi${model.totals.outdated_repos > 0 ? ' kpi-alert' : ''}"><div class="kpi-label">Installed judge-code</div><div class="kpi-value kpi-value-sm ${model.totals.outdated_repos === 0 ? 'tone-good' : 'tone-warn'}">${model.totals.outdated_repos === 0 ? 'Up to date' : `${model.totals.outdated_repos} outdated`}</div><div class="kpi-sub">${latestTag ? `Latest release ${escapeHtml(latestTag)}` : 'No release tag'}</div></div>
    </div>
  </div>
</section>

<section class="panel" id="heatmap-panel">
  <div class="panel-head"><h2>Cross-repo rule heatmap</h2><span class="muted">Select a repo column or rule cell to drill down</span></div>
  <div id="heatmap-root">${model.repos.length === 0 ? '<div class="empty-state">No repository snapshots found in <code>runs/*.json</code>.</div>' : ''}</div>
</section>

<section class="panel" id="repo-detail-panel">
  <div id="repo-detail-root"></div>
</section>

<section class="panel" id="fixtures-panel">
  <div class="panel-head"><h2>Rubric health (<code>rubrics/fixtures</code>)</h2><span class="muted">Fixture pass rate, calibration margins &amp; repeat jitter</span></div>
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
