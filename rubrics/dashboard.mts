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
import { formatThreshold } from '../skills/judge-code/scripts/cli/format-summary.mts';
import { DEFAULT_PASS_SCORE } from '../skills/judge-code/scripts/engine/types.mts';
import type { JudgeMode } from '../skills/judge-code/scripts/rubrics/types.mts';
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
  normalizeMaxScore,
  normalizeMeanScore,
  normalizeMinScore,
  normalizeScore,
  normalizeThreshold,
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
  type SnapshotFileCheckScore,
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
  score: number | null;
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
  min_score: number | null;
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
  min_score: number | null;
  threshold: number;
}

export interface RepoHotspotSummary {
  path: string;
  failed_count: number;
  hard_fail_count: number;
  borderline_count: number;
  min_score: number | null;
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
  calibrated_pass_rate: number;
  raw_pass_rate: number;
  all_files_pass_rate: number | null;
  mean_score: number | null;
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
  delta_mean_score: number | null;
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
    mean_score: number | null;
    min_score: number | null;
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

function normalizeCheckScoreRecord(
  checks: Record<string, SnapshotFileCheckScore> | undefined,
): Record<string, SnapshotFileCheckScore> {
  const out: Record<string, SnapshotFileCheckScore> = {};
  for (const [id, c] of Object.entries(checks ?? {})) {
    const score = normalizeScore(c);
    const kind = classifyCheckFailure(c);
    out[id] = {
      choice: c.choice,
      ...(kind === 'hard' ? { severity: 'error' as const } : kind === 'borderline' ? { severity: 'warning' as const } : {}),
      ...(c.model_choice !== undefined ? { model_choice: c.model_choice } : {}),
      score,
    };
  }
  return out;
}

function normalizeFileEntries(files: SnapshotFileEntry[] | undefined): SnapshotFileEntry[] {
  return (files ?? []).map((f) => ({
    path: f.path,
    pass_rate: f.pass_rate,
    raw_pass_rate: f.raw_pass_rate,
    mean_score: normalizeMeanScore(f),
    min_score: normalizeMinScore(f),
    failed_count: f.failed_count,
    checks: normalizeCheckScoreRecord(f.checks),
  }));
}

function normalizeCheckSummaries(
  snap: RepoSnapshot,
  normalizedFiles: SnapshotFileEntry[],
): Record<string, SnapshotCheckSummary> {
  const detailedTargets: Array<Record<string, SnapshotFileCheckScore>> = Array.isArray(snap.modules) && snap.modules.length > 0
    ? snap.modules.filter((m) => m.status === 'scored').map((m) => normalizeCheckScoreRecord(m.checks))
    : normalizedFiles.map((f) => f.checks);

  const out: Record<string, SnapshotCheckSummary> = {};
  for (const [id, summary] of Object.entries(snap.checks ?? {})) {
    const perTarget = detailedTargets
      .map((checks) => checks[id])
      .filter((c): c is SnapshotFileCheckScore => c !== undefined);
    const hasExactPerTarget = perTarget.length === summary.total && summary.total > 0;
    const rawPassed = hasExactPerTarget
      ? perTarget.filter((c) => classifyCheckFailure(c) !== 'hard').length
      : summary.raw_passed;
    const rawPassRate = hasExactPerTarget
      ? rawPassed / summary.total
      : summary.raw_pass_rate;
    out[id] = {
      threshold: normalizeThreshold(summary.threshold) ?? DEFAULT_PASS_SCORE,
      rubric_group: summary.rubric_group,
      passed: summary.passed,
      raw_passed: rawPassed,
      total: summary.total,
      pass_rate: summary.pass_rate,
      raw_pass_rate: rawPassRate,
      mean_score: normalizeMeanScore(summary),
      min_score: normalizeMinScore(summary),
    };
  }
  return out;
}

function sortHotspotFiles(files: SnapshotFileEntry[]): SnapshotFileEntry[] {
  return [...files].sort((a, b) => {
    const ca = countChecksFindings(a.checks);
    const cb = countChecksFindings(b.checks);
    return (cb.hard - ca.hard)
      || (cb.total - ca.total)
      || (b.failed_count - a.failed_count)
      || ((a.min_score ?? 100) - (b.min_score ?? 100))
      || (a.pass_rate - b.pass_rate)
      || compareCodepoint(a.path, b.path);
  });
}

function buildFailingModuleChecks(
  checks: Record<string, SnapshotFileCheckScore>,
  snapChecks: Record<string, SnapshotCheckSummary>,
  catalog: RubricCatalog,
): DashboardModuleCheckFinding[] {
  const findings: DashboardModuleCheckFinding[] = [];
  for (const [checkId, scoreEntry] of Object.entries(checks)) {
    const severity = classifyCheckFailure(scoreEntry);
    if (!severity) continue;
    const cat = catalog.checks_by_id[checkId];
    const summary = snapChecks[checkId];
    findings.push({
      check_id: checkId,
      rubric_slug: cat?.rubric_slug ?? summary?.rubric_group ?? null,
      scope: cat?.scope ?? null,
      severity,
      score: normalizeScore(scoreEntry),
      threshold: normalizeThreshold(summary?.threshold ?? cat?.pass_threshold) ?? DEFAULT_PASS_SCORE,
    });
  }
  findings.sort((a, b) =>
    (Number(b.severity === 'hard') - Number(a.severity === 'hard'))
    || ((a.score ?? 0) - (b.score ?? 0))
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
        || ((a.min_score ?? 100) - (b.min_score ?? 100))
        || compareCodepoint(a.name, b.name)
        || compareCodepoint(a.path, b.path);
    }
    return compareCodepoint(a.name, b.name) || compareCodepoint(a.path, b.path);
  });
}

function buildModuleViewsForSnapshot(
  snap: RepoSnapshot,
  normalizedChecks: Record<string, SnapshotCheckSummary>,
  normalizedFiles: SnapshotFileEntry[],
  catalog: RubricCatalog,
): DashboardModuleView[] {
  if (Array.isArray(snap.modules)) {
    return sortModuleViews(
      snap.modules.map((m) => {
        const checks = normalizeCheckScoreRecord(m.checks);
        const failing = buildFailingModuleChecks(checks, normalizedChecks, catalog);
        const totalChecks = Object.keys(checks).length;
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
          min_score: normalizeMinScore(m),
          failing_checks: failing,
        };
      }),
    );
  }

  // Backwards-compatible fallback for legacy mode === 'code' snapshots without `modules`.
  if (snap.scan.mode === 'code' && normalizedFiles.length > 0) {
    return sortModuleViews(
      normalizedFiles.map((f) => {
        const failing = buildFailingModuleChecks(f.checks, normalizedChecks, catalog);
        const totalChecks = Object.keys(f.checks).length;
        const hardCount = failing.filter((c) => c.severity === 'hard').length;
        const borderlineCount = failing.filter((c) => c.severity === 'borderline').length;
        return {
          name: f.path === '.' ? snap.repo.name : f.path,
          path: f.path,
          status: 'scored' as const,
          file_count: normalizedFiles.length === 1 ? snap.metrics.file_count : 0,
          failed_count: failing.length,
          hard_fail_count: hardCount,
          borderline_count: borderlineCount,
          passed_count: Math.max(0, totalChecks - failing.length),
          total_checks: totalChecks,
          min_score: normalizeMinScore(f),
          failing_checks: failing,
        };
      }),
    );
  }

  return [];
}

function computeSnapshotFindings(
  snap: RepoSnapshot,
  normalizedChecks: Record<string, SnapshotCheckSummary>,
  normalizedFiles: SnapshotFileEntry[],
): FindingCounts {
  const checkSummaries = Object.values(normalizedChecks);
  if (checkSummaries.length > 0) {
    return sumFindingCounts(checkSummaries.map(countSummaryFindings));
  }
  if (Array.isArray(snap.modules) && snap.modules.length > 0) {
    return sumFindingCounts(
      snap.modules
        .filter((m) => m.status === 'scored')
        .map((m) => countChecksFindings(normalizeCheckScoreRecord(m.checks))),
    );
  }
  return sumFindingCounts(normalizedFiles.map((f) => countChecksFindings(f.checks)));
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

      const points: TrendPoint[] = [];
      for (let idx = 0; idx < records.length; idx += 1) {
        const rec = records[idx];
        const snap = rec.snapshot;
        if (!latestOverall || compareCodepoint(snap.timestamp, latestOverall.timestamp) >= 0) {
          latestOverall = snap;
        }
        if (typeof snap.metrics.cost_usd === 'number' && Number.isFinite(snap.metrics.cost_usd)) {
          totalCost += snap.metrics.cost_usd;
        }
        const prevSnap = idx > 0 ? records[idx - 1].snapshot : null;
        const prevPoint = idx > 0 ? points[idx - 1] : null;
        const changeReasons = prevSnap ? summarizeVersionChange(prevSnap, snap) : [];
        const versionChanged = changeReasons.length > 0;
        const normalizedFiles = normalizeFileEntries(snap.files);
        const normalizedChecks = normalizeCheckSummaries(snap, normalizedFiles);
        const findings = computeSnapshotFindings(snap, normalizedChecks, normalizedFiles);
        const meanScore = normalizeMeanScore(snap.metrics);
        const deltaFindings = prevPoint ? findings.total - prevPoint.findings.total : null;
        const deltaCalibrated = prevPoint
          ? snap.metrics.calibrated_pass_rate - prevPoint.calibrated_pass_rate
          : null;
        const deltaRaw = prevPoint
          ? snap.metrics.raw_pass_rate - prevPoint.raw_pass_rate
          : null;
        const deltaMeanScore = prevPoint
          && typeof meanScore === 'number'
          && typeof prevPoint.mean_score === 'number'
          ? Number((meanScore - prevPoint.mean_score).toFixed(1))
          : null;

        const modules = buildModuleViewsForSnapshot(snap, normalizedChecks, normalizedFiles, catalog);
        const sortedFiles = sortHotspotFiles(normalizedFiles);
        const affectedTargets = modules.length > 0
          ? modules.filter((m) => m.status === 'scored' && m.failed_count > 0).length
          : sortedFiles.filter((f) => f.failed_count > 0).length;
        const modulesScored = modules.filter((m) => m.status === 'scored').length;
        const modulesSkipped = modules.filter((m) => m.status === 'skipped').length;
        const modulesErrored = modules.filter((m) => m.status === 'error').length;

        points.push({
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
          calibrated_pass_rate: snap.metrics.calibrated_pass_rate,
          raw_pass_rate: snap.metrics.raw_pass_rate,
          all_files_pass_rate: snap.metrics.all_files_pass_rate ?? null,
          mean_score: meanScore,
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
          delta_mean_score: deltaMeanScore,
          checks: normalizedChecks,
          files: sortedFiles,
          modules,
          modules_scored: modulesScored,
          modules_skipped: modulesSkipped,
          modules_errored: modulesErrored,
        });
      }

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
          min_score: normalizeMinScore(summary),
          threshold: normalizeThreshold(summary.threshold) ?? DEFAULT_PASS_SCORE,
        });
      }
    }
    worstRules.sort((a, b) =>
      (b.hard - a.hard)
      || (b.failed - a.failed)
      || ((a.min_score ?? 100) - (b.min_score ?? 100))
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
            || ((normalizeScore(a[1]) ?? 0) - (normalizeScore(b[1]) ?? 0))
            || compareCodepoint(a[0], b[0]),
          )
          .map(([cid]) => cid);
        return {
          path: f.path,
          failed_count: fc.total,
          hard_fail_count: fc.hard,
          borderline_count: fc.borderline,
          min_score: normalizeMinScore(f),
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
      let fallbackThreshold = DEFAULT_PASS_SCORE;
      let fallbackGroup: string | null = null;
      for (const rName of modeRepos) {
        const check = repos.find((r) => r.name === rName)!.by_mode[mode]!.latest.checks[checkId];
        if (!check || check.total === 0) continue;
        fallbackThreshold = normalizeThreshold(check.threshold) ?? DEFAULT_PASS_SCORE;
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
          mean_score: normalizeMeanScore(check),
          min_score: normalizeMinScore(check),
          threshold: fallbackThreshold,
        };
        if (check.pass_rate < worst) worst = check.pass_rate;
      }
      return {
        check_id: checkId,
        rubric_slug: catalogInfo?.rubric_slug ?? fallbackGroup,
        threshold: normalizeThreshold(catalogInfo?.pass_threshold) ?? fallbackThreshold,
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
    const isLegacyFixtureScale = snap.checks.some(
      (c) => (c.min_score === undefined && c.min_pass_probability !== undefined)
        || (typeof c.pass_threshold === 'number' && c.pass_threshold > 0 && c.pass_threshold <= 1),
    );
    const scalePoints = (val: number | null | undefined): number | null => {
      if (typeof val !== 'number' || !Number.isFinite(val)) return null;
      return isLegacyFixtureScale ? Number((val * 100).toFixed(1)) : Number(val.toFixed(1));
    };
    const normalizedChecks: FixtureCheckSnapshot[] = snap.checks.map((c) => ({
      fixture_id: c.fixture_id,
      mode: c.mode,
      rubric: c.rubric,
      check_id: c.check_id,
      expected: c.expected,
      passed: c.passed,
      matches: c.matches,
      repeats: c.repeats,
      pass_threshold: normalizeThreshold(c.pass_threshold),
      min_score: normalizeMinScore(c),
      max_score: normalizeMaxScore(c),
      mean_score: normalizeMeanScore(c),
      margin: scalePoints(c.margin),
      jitter: scalePoints(c.jitter),
    }));
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
      min_margin: scalePoints(snap.metrics.min_margin),
      mean_margin: scalePoints(snap.metrics.mean_margin),
      max_jitter: scalePoints(snap.metrics.max_jitter),
      mean_jitter: scalePoints(snap.metrics.mean_jitter),
      repeats: snap.scan.repeats,
      cost_usd: snap.metrics.cost_usd,
      elapsed_ms: snap.metrics.elapsed_ms,
      version_changed: changeReasons.length > 0,
      change_reasons: changeReasons,
      checks: normalizedChecks,
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

function findingsTone(counts: FindingCounts): string {
  if (counts.hard > 0) return ' tone-bad';
  if (counts.borderline > 0) return ' tone-warn';
  return ' tone-good';
}

function renderFindingsBadges(counts: FindingCounts): string {
  if (counts.total === 0) return '<span class="pill pass">0 clean</span>';
  const parts: string[] = [];
  if (counts.hard > 0) parts.push(`<span class="pill fail">${counts.hard} ${counts.hard === 1 ? 'error' : 'errors'}</span>`);
  if (counts.borderline > 0) parts.push(`<span class="pill warn">${counts.borderline} ${counts.borderline === 1 ? 'warning' : 'warnings'}</span>`);
  return `<div class="badge-row"><strong class="numeric${findingsTone(counts)}">${counts.total}</strong> ${parts.join(' ')}</div>`;
}

function renderDeltaFindingsBadge(delta: number | null, versionChanged: boolean): string {
  if (delta === null) return '';
  const cls = delta < 0 ? 'pass' : delta > 0 ? 'fail' : 'neutral';
  const label = delta > 0 ? `+${delta}` : String(delta);
  const title = versionChanged ? 'Crossed rubric/judge change' : 'Change in total findings vs previous run';
  return `<span class="pill ${cls}" title="${escapeHtml(title)}">${escapeHtml(label)}${versionChanged ? ' *' : ''}</span>`;
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
      .filter((c) => Math.abs((normalizeThreshold(c.pass_threshold) ?? DEFAULT_PASS_SCORE) - DEFAULT_PASS_SCORE) > 1e-9)
      .map((c) => `${c.id} (&ge;${formatThreshold(c.pass_threshold)})`);
    return `<tr>
      <td><code>${escapeHtml(r.slug)}</code></td>
      <td><code>${escapeHtml(r.id)}</code></td>
      <td><span class="pill target-${escapeHtml(r.target)}">${escapeHtml(r.target)}</span></td>
      <td class="numeric">${r.checks.length}</td>
      <td>${customThresholds.length > 0 ? escapeHtml(customThresholds.join(', ')) : `<span class="muted">all &ge;${DEFAULT_PASS_SCORE}</span>`}</td>
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
main{max-width:1440px;margin:0 auto;padding:22px 26px 64px}
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
.kpi-danger{background:#fef2f2}
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
.badge-row{display:flex;align-items:center;gap:5px;flex-wrap:wrap}
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
.punch-summary{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;margin-bottom:14px}
.punch-tile{border:1px solid var(--line);border-radius:9px;padding:10px 12px;background:#fcfdff}
.punch-tile-label{font-size:.72rem;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:var(--muted)}
.punch-tile-val{font-size:1.15rem;font-weight:700;margin:2px 0}
.punch-tile-sub{font-size:.75rem;color:var(--muted)}
.arch-card{border:1px solid #c7d2fe;border-radius:10px;padding:14px 16px;background:#fafbff;margin-bottom:16px}
.chart-box{border:1px solid var(--line);border-radius:10px;padding:12px 14px;background:#fcfdff;margin-bottom:16px}
.chart-legend{display:flex;flex-wrap:wrap;gap:14px;align-items:center;font-size:.78rem;color:var(--muted);margin-bottom:8px}
.legend-item{display:inline-flex;align-items:center;gap:6px}
.legend-swatch{display:inline-block;width:16px;height:3px;border-radius:2px}
.legend-swatch.dashed{background:repeating-linear-gradient(90deg,var(--teal) 0 5px,transparent 5px 8px)}
.legend-swatch.dashed-red{background:repeating-linear-gradient(90deg,var(--red) 0 5px,transparent 5px 8px)}
.legend-swatch.dotted{background:repeating-linear-gradient(90deg,var(--purple) 0 2px,transparent 2px 5px)}
.legend-marker{display:inline-block;width:9px;height:9px;transform:rotate(45deg);background:#f59e0b;border:1px solid #b45309}
.svg-wrap{width:100%;overflow-x:auto}
svg.trend-svg{display:block;width:100%;max-width:100%;height:auto}
.chart-point{cursor:pointer}
.chart-point:hover{stroke-width:3}
.split-grid{display:grid;grid-template-columns:1.15fr 1fr;gap:16px;align-items:start}
.sub-card{border:1px solid var(--line);border-radius:10px;padding:14px 16px;background:#fcfdff}
.bar-wrap{display:flex;align-items:center;gap:7px;min-width:108px}
.bar-track{width:52px;height:7px;background:#e6ecf5;border-radius:999px;overflow:hidden;flex-shrink:0}
.bar-fill{height:100%;border-radius:999px}
.heat-cell{display:inline-flex;flex-direction:column;align-items:flex-end;gap:1px;padding:4px 8px;border-radius:6px;min-width:92px;font-variant-numeric:tabular-nums}
.heat-cell strong{font-size:.82rem;line-height:1.2}
.heat-cell span{font-size:.71rem;opacity:.88}
.fail-chips{display:flex;flex-wrap:wrap;gap:4px}
.fail-chip{display:inline-flex;align-items:center;gap:4px;padding:1px 6px;border-radius:4px;font-size:.73rem;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.fail-chip-hard{background:#fee2e2;color:#991b1b;border:1px solid #fca5a5;font-weight:600}
.fail-chip-borderline{background:#fff7ed;color:#9a3412;border:1px solid #fdba74}
.version-banner{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:8px 12px;border-radius:8px;background:#fffbeb;border:1px solid #fde68a;color:#92400e;font-size:.82rem;margin-bottom:12px}
.warn-banner{padding:10px 14px;border-radius:8px;background:#fff7ed;border:1px solid #fed7aa;color:#9a3412;font-size:.82rem;margin-bottom:14px}
.run-row{cursor:pointer}
.run-row:hover td{background:#f8faff}
.run-row.active-run td{background:#eff4ff}
.tip-wrap{position:relative;display:inline-flex;align-items:center}
.tip-trigger{border-bottom:1px dotted #94a3b8;cursor:help}
.tip-card{display:none;position:absolute;left:0;top:calc(100% + 6px);width:min(440px,74vw);padding:10px 12px;background:#fff;border:1px solid #cbd5e1;border-radius:9px;box-shadow:0 10px 24px rgba(15,23,42,.14);z-index:50;white-space:normal;font-weight:400;line-height:1.4;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:var(--ink)}
.tip-wrap:hover .tip-card,.tip-wrap:focus-within .tip-card{display:block}
.tip-pass{background:#f0fdf4;border-left:3px solid #16a34a;padding:5px 8px;border-radius:5px;margin-top:6px;font-size:.77rem}
.tip-fail{background:#fff7ed;border-left:3px solid #ea580c;padding:5px 8px;border-radius:5px;margin-top:5px;font-size:.77rem}
.empty-state{padding:24px 16px;text-align:center;color:var(--muted);border:1px dashed var(--line);border-radius:10px;background:#fafbfd}
footer{font-size:.8rem;color:var(--muted);margin-top:24px}
[hidden]{display:none!important}
@media(max-width:1024px){.kpi-strip{grid-template-columns:repeat(2,minmax(0,1fr))}.kpi{border-bottom:1px solid var(--line)}.punch-summary{grid-template-columns:repeat(2,minmax(0,1fr))}.split-grid{grid-template-columns:1fr}}
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
  function fmtScore(v, thr) {
    if (typeof v !== 'number' || !Number.isFinite(v)) return '—';
    const rounded = Math.round(v);
    const bounds = [60];
    if (typeof thr === 'number' && Number.isFinite(thr)) bounds.push(thr);
    for (const b of bounds) {
      if (v < b && rounded >= b) {
        const floored = Math.floor(v * 10) / 10;
        return Math.min(floored, Number((b - 0.1).toFixed(1))).toFixed(1);
      }
    }
    return String(rounded);
  }
  function fmtScoreVal(v) {
    if (typeof v !== 'number' || !Number.isFinite(v)) return '—';
    const r = Number(v.toFixed(1));
    return Number.isInteger(r) ? String(r) : r.toFixed(1);
  }
  function fmtThr(v) {
    if (typeof v !== 'number' || !Number.isFinite(v)) return '—';
    const s = v > 0 && v <= 1 ? Number((v * 100).toFixed(1)) : Number(v.toFixed(1));
    return Number.isInteger(s) ? String(s) : s.toFixed(1);
  }
  function classifyScore(score) {
    if (!score || score.choice !== 'fail') return null;
    if (score.severity === 'error') return 'hard';
    if (score.severity === 'warning') return 'borderline';
    const val = typeof score.score === 'number'
      ? score.score
      : (typeof score.pass_probability === 'number' ? Number((score.pass_probability * 100).toFixed(1)) : null);
    if (val !== null) return val < 60 ? 'hard' : 'borderline';
    if (score.model_choice === 'fail') return 'hard';
    if (score.model_choice === 'borderline') return 'borderline';
    return 'hard';
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
  function heatColors(rate) {
    if (rate >= 0.999) return { bg: '#dcfce7', fg: '#14532d' };
    if (rate >= 0.85) return { bg: '#ecfccb', fg: '#365314' };
    if (rate >= 0.7) return { bg: '#fef9c3', fg: '#713f12' };
    if (rate >= 0.5) return { bg: '#ffedd5', fg: '#9a3412' };
    return { bg: '#fee2e2', fg: '#991b1b' };
  }
  function renderFindingsPills(fc) {
    if (!fc || fc.total === 0) return '<span class="pill pass">0 clean</span>';
    const parts = [];
    if (fc.hard > 0) parts.push('<span class="pill fail">' + fc.hard + (fc.hard === 1 ? ' error' : ' errors') + '</span>');
    if (fc.borderline > 0) parts.push('<span class="pill warn">' + fc.borderline + (fc.borderline === 1 ? ' warning' : ' warnings') + '</span>');
    return '<div class="badge-row"><strong class="numeric">' + fc.total + '</strong> ' + parts.join(' ') + '</div>';
  }
  function checkLabelWithTip(cid) {
    const cat = DATA.catalog && DATA.catalog.checks_by_id ? DATA.catalog.checks_by_id[cid] : null;
    if (!cat) return '<code>' + esc(cid) + '</code>';
    return '<span class="tip-wrap"><span class="tip-trigger" tabindex="0">' + esc(cid) + '</span>'
      + '<div class="tip-card"><strong>' + esc(cat.instructions) + '</strong>'
      + '<div class="tip-pass"><strong>Pass:</strong> ' + esc(cat.criteria.pass) + '</div>'
      + '<div class="tip-fail"><strong>Fail:</strong> ' + esc(cat.criteria.fail) + '</div></div></span>';
  }
  function renderFindingChip(cid, severity, score, thr) {
    const cat = DATA.catalog && DATA.catalog.checks_by_id ? DATA.catalog.checks_by_id[cid] : null;
    const cls = severity === 'hard' ? 'fail-chip fail-chip-hard' : 'fail-chip fail-chip-borderline';
    const sText = typeof score === 'number' ? fmtScore(score, thr) + '/100' : 'fail';
    const detail = severity === 'hard'
      ? 'error ' + sText + ', pass >= ' + fmtThr(thr)
      : 'warning ' + sText + ', pass >= ' + fmtThr(thr);
    const title = (severity === 'hard' ? 'Error (score < 60/100)' : 'Warning (score 60..<' + fmtThr(thr) + '/100)')
      + (cat && cat.instructions ? ' — ' + cat.instructions : '');
    return '<span class="' + cls + '" title="' + esc(title) + '">' + esc(cid) + ' (' + esc(detail) + ')</span>';
  }

  let selectedRepo = DATA.repos && DATA.repos.length > 0 ? DATA.repos[0].name : null;
  let selectedMode = null;
  let selectedRunIdx = null;
  let trendMetric = 'findings';
  let heatmapMode = DATA.modes_present && DATA.modes_present.length > 0 ? DATA.modes_present[0] : 'file';
  let fileSearch = '';
  let failingOnly = true;
  let moduleSearch = '';
  let moduleFailingOnly = false;
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

  function renderFindingsTrendSvg(points, activeIdx) {
    const W = 820, H = 225, padL = 48, padR = 24, padT = 22, padB = 34;
    const plotW = W - padL - padR;
    const plotH = H - padT - padB;
    const maxVal = Math.max(4, ...points.map((p) => p.findings ? p.findings.total : 0));
    const yMax = Math.ceil(maxVal * 1.15);
    const xAt = (i) => points.length <= 1 ? padL + plotW / 2 : padL + (i / (points.length - 1)) * plotW;
    const yAt = (v) => padT + (1 - Math.max(0, Math.min(1, v / yMax))) * plotH;

    const tickVals = [...new Set([0, Math.round(yMax / 2), yMax])];
    const gridLines = tickVals.map((g) => {
      const y = yAt(g).toFixed(1);
      return '<line x1="' + padL + '" y1="' + y + '" x2="' + (W - padR) + '" y2="' + y + '" stroke="#e2e8f0" stroke-width="1"/>'
        + '<text x="' + (padL - 8) + '" y="' + (Number(y) + 4) + '" text-anchor="end" font-size="11" fill="#64748b">' + g + '</text>';
    }).join('');

    const versionLines = points.map((p, i) => {
      if (!p.version_changed) return '';
      const x = xAt(i).toFixed(1);
      const label = esc(p.change_reasons.join(' | '));
      return '<g><line x1="' + x + '" y1="' + padT + '" x2="' + x + '" y2="' + (H - padB) + '" stroke="#f59e0b" stroke-width="1.5" stroke-dasharray="4 3"/>'
        + '<polygon points="' + x + ',' + (padT - 7) + ' ' + (Number(x) + 5) + ',' + (padT - 2) + ' ' + x + ',' + (padT + 3) + ' ' + (Number(x) - 5) + ',' + (padT - 2) + '" fill="#f59e0b" stroke="#b45309" stroke-width="1"><title>Rubric / judge change: ' + label + '</title></polygon></g>';
    }).join('');

    const polyline = (getter, stroke, dash) => {
      const coords = points.map((p, i) => xAt(i).toFixed(1) + ',' + yAt(getter(p)).toFixed(1));
      if (coords.length < 2) return '';
      return '<polyline fill="none" stroke="' + stroke + '" stroke-width="2.2" ' + (dash ? 'stroke-dasharray="' + dash + '"' : '') + ' points="' + coords.join(' ') + '"/>';
    };

    const dots = points.map((p, i) => {
      const x = xAt(i).toFixed(1);
      const yt = yAt(p.findings.total).toFixed(1);
      const yh = yAt(p.findings.hard).toFixed(1);
      const isActive = i === activeIdx;
      const tip = esc(
        shortDate(p.timestamp) + ' · ' + p.commit_short + (p.dirty ? ' (dirty)' : '')
        + '\\nFindings: ' + p.findings.total + ' (' + p.findings.hard + ' errors, ' + p.findings.borderline + ' warnings)'
        + '\\nCalibrated pass: ' + pct(p.calibrated_pass_rate) + ' | Raw pass: ' + pct(p.raw_pass_rate)
        + (p.version_changed ? '\\nVersion change: ' + p.change_reasons.join('; ') : '')
      );
      return '<g class="chart-point" data-select-run="' + i + '">'
        + (isActive ? '<line x1="' + x + '" y1="' + padT + '" x2="' + x + '" y2="' + (H - padB) + '" stroke="#3158cf" stroke-opacity="0.22" stroke-width="10"/>' : '')
        + '<circle cx="' + x + '" cy="' + yh + '" r="' + (isActive ? 4.8 : 3.5) + '" fill="#b91c1c" stroke="#fff" stroke-width="1"><title>' + tip + '</title></circle>'
        + '<circle cx="' + x + '" cy="' + yt + '" r="' + (isActive ? 6 : 4.2) + '" fill="#3158cf" stroke="#fff" stroke-width="1.5"><title>' + tip + '</title></circle>'
        + '</g>';
    }).join('');

    const step = Math.max(1, Math.ceil(points.length / 6));
    const xLabels = points.map((p, i) => {
      if (i !== 0 && i !== points.length - 1 && i % step !== 0) return '';
      const x = xAt(i).toFixed(1);
      return '<text x="' + x + '" y="' + (H - 10) + '" text-anchor="middle" font-size="10.5" fill="#64748b">' + esc(p.timestamp.slice(5, 10) + ' ' + p.commit_short) + '</text>';
    }).join('');

    return '<svg class="trend-svg" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Findings trend chart">'
      + gridLines + versionLines
      + polyline((p) => p.findings.hard, '#b91c1c', '6 3')
      + polyline((p) => p.findings.total, '#3158cf', '')
      + dots + xLabels + '</svg>';
  }

  function renderRateTrendSvg(points, activeIdx) {
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
      const ym = typeof p.mean_score === 'number' ? yAt(p.mean_score / 100).toFixed(1) : null;
      const isActive = i === activeIdx;
      const tip = esc(
        shortDate(p.timestamp) + ' · ' + p.commit_short + (p.dirty ? ' (dirty)' : '')
        + '\\nCalibrated: ' + pct(p.calibrated_pass_rate) + ' | Non-error: ' + pct(p.raw_pass_rate)
        + ' | Mean score: ' + (typeof p.mean_score === 'number' ? fmtScoreVal(p.mean_score) + '/100' : '—')
        + '\\nFindings: ' + p.findings.total + ' (' + p.findings.hard + ' errors, ' + p.findings.borderline + ' warnings)'
      );
      return '<g class="chart-point" data-select-run="' + i + '">'
        + (isActive ? '<line x1="' + x + '" y1="' + padT + '" x2="' + x + '" y2="' + (H - padB) + '" stroke="#3158cf" stroke-opacity="0.22" stroke-width="10"/>' : '')
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

    return '<svg class="trend-svg" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Pass rate trend chart">'
      + gridLines + versionLines
      + polyline((p) => p.raw_pass_rate, '#0d9488', '6 3')
      + polyline((p) => typeof p.mean_score === 'number' ? p.mean_score / 100 : null, '#7c3aed', '2 4')
      + polyline((p) => p.calibrated_pass_rate, '#3158cf', '')
      + dots + xLabels + '</svg>';
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
      const yJit = typeof p.max_jitter === 'number' ? yAt(p.max_jitter / 100).toFixed(1) : null;
      const tip = esc(shortDate(p.timestamp) + ' · ' + p.judge_version + '\\nChecks passed: ' + p.checks_passed + '/' + p.checks_total + ' (' + pct(p.check_pass_rate) + ')\\nMin margin: ' + (p.min_margin !== null ? fmtScoreVal(p.min_margin) : '—') + ' | Max jitter: ' + (p.max_jitter !== null ? fmtScoreVal(p.max_jitter) : '—'));
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
      + grid + line((p) => p.check_pass_rate, '#15803d', '') + line((p) => typeof p.max_jitter === 'number' ? p.max_jitter / 100 : null, '#ea580c', '4 3')
      + dots + labels + '</svg>';
  }

  function renderModuleArchitectureSection(repoObj, activeRun) {
    const codeRun = selectedMode === 'code' && activeRun && activeRun.modules && activeRun.modules.length > 0
      ? activeRun
      : (repoObj.by_mode.code && repoObj.by_mode.code.latest && repoObj.by_mode.code.latest.modules.length > 0
        ? repoObj.by_mode.code.latest
        : null);
    if (!codeRun) return '';

    const allModules = codeRun.modules || [];
    const filtered = allModules.filter((m) => {
      if (moduleFailingOnly && m.status === 'scored' && m.failed_count === 0) return false;
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
      const subMeta = '<div class="muted" style="font-size:.75rem"><code>' + esc(m.path) + '</code>' + (sizeBits.length ? ' · ' + esc(sizeBits.join(' · ')) : '') + '</div>';

      let statusCell;
      let detailCell;
      if (m.status === 'skipped') {
        statusCell = '<span class="pill warn">skipped: ' + esc(m.skip_reason || 'oversize') + '</span>';
        detailCell = '<span class="muted">' + esc(m.error || 'Skipped during scan') + '</span>';
      } else if (m.status === 'error') {
        statusCell = '<span class="pill fail">error</span>';
        detailCell = '<span class="tone-bad" style="font-size:.82rem">' + esc(m.error || 'Module scan failed') + '</span>';
      } else if (m.failed_count === 0) {
        statusCell = '<span class="pill pass">0 clean</span>';
        detailCell = '<span class="pill pass">all ' + m.total_checks + ' architectural checks passed</span>';
      } else {
        statusCell = renderFindingsPills({ total: m.failed_count, hard: m.hard_fail_count, borderline: m.borderline_count });
        detailCell = '<div class="fail-chips">' + m.failing_checks.map((c) =>
          renderFindingChip(c.check_id, c.severity, c.score, c.threshold)
        ).join('') + '</div>';
      }

      return '<tr>'
        + '<td><strong>' + esc(m.name) + '</strong>' + subMeta + '</td>'
        + '<td class="numeric">' + statusCell + '</td>'
        + '<td class="numeric">' + (typeof m.min_score === 'number' ? fmtScoreVal(m.min_score) : '—') + '</td>'
        + '<td>' + detailCell + '</td>'
        + '</tr>';
    }).join('');

    const summaryPills = [
      renderFindingsPills(codeRun.findings),
      '<span class="pill neutral">' + codeRun.modules_scored + '/' + allModules.length + ' scored</span>',
    ];
    if (codeRun.modules_skipped > 0) summaryPills.push('<span class="pill warn">' + codeRun.modules_skipped + ' skipped</span>');
    if (codeRun.modules_errored > 0) summaryPills.push('<span class="pill fail">' + codeRun.modules_errored + ' errored</span>');

    return '<div class="arch-card" id="module-architecture-section">'
      + '<div class="panel-head">'
      + '<div><h3>Feature / Module Architecture (' + allModules.length + ' module' + (allModules.length === 1 ? '' : 's') + ')</h3>'
      + '<div class="muted" style="font-size:.78rem">Ranked worst-first · errors (&lt;60/100) vs. warnings (60..&lt;pass bar) · ' + esc(shortDate(codeRun.timestamp)) + ' · <code>' + esc(codeRun.commit_short) + '</code></div></div>'
      + '<div class="badge-row">' + summaryPills.join(' ') + '</div>'
      + '</div>'
      + '<div class="controls" style="margin-bottom:10px">'
      + '<input type="search" id="module-search-input" placeholder="Filter module, path, or rule..." value="' + esc(moduleSearch) + '">'
      + '<label class="toggle"><input type="checkbox" id="module-failing-only-toggle"' + (moduleFailingOnly ? ' checked' : '') + '> Failing &amp; skipped only</label>'
      + '<span class="muted numeric" style="margin-left:auto">' + filtered.length + ' of ' + allModules.length + ' shown</span>'
      + '</div>'
      + (filtered.length > 0
        ? '<div class="table-scroll"><table><thead><tr><th>Module</th><th>Findings / Status</th><th>Min Score</th><th>Failing architectural checks</th></tr></thead><tbody>' + rows + '</tbody></table></div>'
        : '<p class="muted">No modules match the current filter.</p>')
      + '</div>';
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

    document.querySelectorAll('.repo-row').forEach((tr) => {
      tr.classList.toggle('selected', tr.dataset.repo === repoObj.name);
    });

    const repoTabs = DATA.repos.map((r) =>
      '<button type="button" class="tab-btn' + (r.name === repoObj.name ? ' active' : '') + '" data-pick-repo="' + esc(r.name) + '">' + esc(r.name)
      + (r.total_findings.total > 0 ? ' (' + r.total_findings.total + ')' : '') + '</button>'
    ).join('');
    const modeTabs = repoObj.modes.map((m) => {
      const mLatest = repoObj.by_mode[m].latest;
      const label = m === 'code' ? 'modules (code)' : m;
      return '<button type="button" class="tab-btn' + (m === selectedMode ? ' active' : '') + '" data-pick-mode="' + esc(m) + '">' + esc(label)
        + ' · ' + mLatest.findings.total + '</button>';
    }).join('');

    const punchTiles =
      '<div class="punch-summary">'
      + '<div class="punch-tile"><div class="punch-tile-label">Repo open findings</div><div class="punch-tile-val">' + renderFindingsPills(repoObj.total_findings) + '</div><div class="punch-tile-sub">Latest across ' + repoObj.modes.length + ' mode(s)</div></div>'
      + '<div class="punch-tile"><div class="punch-tile-label">File checks</div><div class="punch-tile-val">' + (repoObj.file_findings ? renderFindingsPills(repoObj.file_findings) : '<span class="muted">—</span>') + '</div><div class="punch-tile-sub">' + (repoObj.by_mode.file ? repoObj.by_mode.file.latest.affected_targets + '/' + repoObj.by_mode.file.latest.file_count + ' files with findings' : 'Not scanned') + '</div></div>'
      + '<div class="punch-tile"><div class="punch-tile-label">Module architecture</div><div class="punch-tile-val">' + (repoObj.module_findings ? renderFindingsPills(repoObj.module_findings) : '<span class="muted">—</span>') + '</div><div class="punch-tile-sub">' + (repoObj.module_architecture ? repoObj.module_architecture.modules_with_findings + '/' + repoObj.module_architecture.total_modules + ' modules affected' + (repoObj.module_architecture.skipped_modules > 0 ? ' · ' + repoObj.module_architecture.skipped_modules + ' skipped' : '') : 'Add modules/moduleRoots to enable') + '</div></div>'
      + '<div class="punch-tile"><div class="punch-tile-label">Worst offending rules</div><div class="punch-tile-val" style="font-size:.82rem">'
      + (repoObj.worst_rules && repoObj.worst_rules.length > 0
        ? '<div class="fail-chips">' + repoObj.worst_rules.slice(0, 3).map((wr) =>
            '<span class="fail-chip ' + (wr.hard > 0 ? 'fail-chip-hard' : 'fail-chip-borderline') + '">' + esc(wr.check_id) + ' (' + wr.failed + ')</span>'
          ).join('') + '</div>'
        : '<span class="pill pass">all rules clean</span>')
      + '</div><div class="punch-tile-sub">' + (repoObj.worst_rules ? repoObj.worst_rules.length + ' failing rule(s) total' : '') + '</div></div>'
      + '</div>';

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
      const fc = countFileFindings(f.checks);
      const failedChecks = Object.entries(f.checks)
        .filter(([, c]) => c.choice === 'fail')
        .sort((a, b) =>
          (Number(classifyScore(b[1]) === 'hard') - Number(classifyScore(a[1]) === 'hard'))
          || ((a[1].score ?? 0) - (b[1].score ?? 0))
          || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)
        );
      const chips = failedChecks.length > 0
        ? '<div class="fail-chips">' + failedChecks.map(([cid, c]) => {
            const thr = run.checks[cid] ? run.checks[cid].threshold : 80;
            return renderFindingChip(cid, classifyScore(c) || 'hard', c.score, thr);
          }).join('') + '</div>'
        : '<span class="pill pass">all checks passed</span>';
      return '<tr>'
        + '<td><code>' + esc(f.path) + '</code></td>'
        + '<td class="numeric">' + renderFindingsPills(fc) + '</td>'
        + '<td class="numeric">' + (typeof f.min_score === 'number' ? fmtScoreVal(f.min_score) : '—') + '</td>'
        + '<td>' + chips + '</td>'
        + '</tr>';
    }).join('');

    const checkEntries = Object.entries(run.checks).sort((a, b) => {
      const fa = countCheckSummaryFindings(a[1]);
      const fb = countCheckSummaryFindings(b[1]);
      return (fb.hard - fa.hard)
        || (fb.total - fa.total)
        || ((a[1].min_score ?? 100) - (b[1].min_score ?? 100))
        || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
    });
    const checkRows = checkEntries.map(([cid, c]) => {
      const fc = countCheckSummaryFindings(c);
      const thrBadge = Math.abs(c.threshold - 80) > 1e-9
        ? '<span class="pill warn">&ge;' + fmtThr(c.threshold) + '</span>'
        : '<span class="pill neutral">&ge;' + fmtThr(c.threshold) + '</span>';
      return '<tr>'
        + '<td>' + checkLabelWithTip(cid) + (c.rubric_group ? ' <span class="muted" style="font-size:.75rem">' + esc(c.rubric_group) + '</span>' : '') + '</td>'
        + '<td class="numeric">' + thrBadge + '</td>'
        + '<td class="numeric">' + (fc.total > 0 ? '<strong>' + fc.total + '/' + c.total + '</strong>' : '<span class="muted">0/' + c.total + '</span>') + '</td>'
        + '<td class="numeric">' + renderFindingsPills(fc) + '</td>'
        + '<td class="numeric">' + (typeof c.min_score === 'number' ? fmtScoreVal(c.min_score) : '—') + '</td>'
        + '<td class="numeric">' + (typeof c.mean_score === 'number' ? fmtScoreVal(c.mean_score) : '—') + '</td>'
        + '</tr>';
    }).join('');

    const runRows = [...series.points].reverse().map((p, revIdx) => {
      const idx = series.points.length - 1 - revIdx;
      const df = p.delta_findings;
      const dClass = df === null ? 'neutral' : df < 0 ? 'pass' : df > 0 ? 'fail' : 'neutral';
      const dText = df === null ? '—' : (df > 0 ? '+' + df : String(df));
      return '<tr class="run-row' + (idx === selectedRunIdx ? ' active-run' : '') + '" data-select-run="' + idx + '">'
        + '<td class="numeric">' + esc(shortDate(p.timestamp)) + '</td>'
        + '<td><code>' + esc(p.commit_short) + '</code>' + (p.dirty ? ' <span class="pill warn">dirty</span>' : '') + (p.branch ? ' <span class="muted">' + esc(p.branch) + '</span>' : '') + '</td>'
        + '<td class="numeric">' + (selectedMode === 'code' && p.modules.length > 0 ? p.modules_scored + '/' + p.modules.length + ' mod' : p.file_count) + '</td>'
        + '<td class="numeric">' + renderFindingsPills(p.findings) + '</td>'
        + '<td class="numeric"><span class="pill ' + dClass + '">' + esc(dText) + '</span>' + (p.version_changed ? ' <span class="pill warn" title="' + esc(p.change_reasons.join('; ')) + '">rubric &Delta;</span>' : '') + '</td>'
        + '<td class="numeric muted">' + pct(p.calibrated_pass_rate) + '</td>'
        + '<td><code>' + esc(p.judge_version) + '</code></td>'
        + '<td class="numeric">' + esc(fmtUsd(p.cost_usd)) + '</td>'
        + '</tr>';
    }).join('');

    const legendItems = trendMetric === 'findings'
      ? '<span class="legend-item"><span class="legend-swatch" style="background:#3158cf"></span>Total findings</span>'
        + '<span class="legend-item"><span class="legend-swatch dashed-red"></span>Errors (&lt;60/100)</span>'
        + '<span class="legend-item"><span class="legend-marker"></span>Judge or rubric hash changed</span>'
      : '<span class="legend-item"><span class="legend-swatch" style="background:#3158cf"></span>Calibrated pass rate</span>'
        + '<span class="legend-item"><span class="legend-swatch dashed"></span>Non-error rate (&ge;60)</span>'
        + '<span class="legend-item"><span class="legend-swatch dotted"></span>Mean score</span>'
        + '<span class="legend-item"><span class="legend-marker"></span>Judge or rubric hash changed</span>';

    container.innerHTML =
      '<div class="controls">'
      + '<div class="tabs" role="tablist" aria-label="Select repository">' + repoTabs + '</div>'
      + '<div class="tabs" role="tablist" aria-label="Select mode">' + modeTabs + '</div>'
      + '<span class="muted numeric" style="margin-left:auto">Run ' + (selectedRunIdx + 1) + '/' + series.points.length + ' · ' + esc(run.model) + '</span>'
      + '</div>'
      + punchTiles
      + renderModuleArchitectureSection(repoObj, run)
      + '<div class="chart-box">'
      + '<div class="chart-legend">'
      + '<div class="tabs" role="tablist" aria-label="Trend metric">'
      + '<button type="button" class="tab-btn' + (trendMetric === 'findings' ? ' active' : '') + '" data-trend-metric="findings">Findings</button>'
      + '<button type="button" class="tab-btn' + (trendMetric === 'rates' ? ' active' : '') + '" data-trend-metric="rates">Pass rates</button>'
      + '</div>'
      + legendItems
      + '<span class="muted" style="margin-left:auto">Click any point or history row to inspect</span>'
      + '</div>'
      + '<div class="svg-wrap">' + (trendMetric === 'findings' ? renderFindingsTrendSvg(series.points, selectedRunIdx) : renderRateTrendSvg(series.points, selectedRunIdx)) + '</div>'
      + '</div>'
      + versionBanner
      + '<div class="split-grid">'
      + '<div class="sub-card">'
      + '<div class="panel-head"><h3>Worst-offending rules (' + checkEntries.filter(([, c]) => c.passed < c.total).length + ' failing / ' + checkEntries.length + ')</h3><span class="muted numeric">' + esc(shortDate(run.timestamp)) + ' · ' + esc(run.commit_short) + '</span></div>'
      + '<div class="table-scroll"><table><thead><tr><th>Rule</th><th>Threshold</th><th>Failed</th><th>Errors / Warnings</th><th>Min Score</th><th>Mean Score</th></tr></thead><tbody>' + checkRows + '</tbody></table></div>'
      + '</div>'
      + '<div class="sub-card">'
      + '<div class="panel-head"><h3>Top hotspot ' + (selectedMode === 'code' ? 'modules' : 'files / targets') + ' (' + filteredFiles.length + ' shown / ' + run.files.length + ')</h3>'
      + '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">'
      + '<input type="search" id="file-search-input" placeholder="Filter path or rule..." value="' + esc(fileSearch) + '">'
      + '<label class="toggle"><input type="checkbox" id="failing-only-toggle"' + (failingOnly ? ' checked' : '') + '> Failing only</label>'
      + '</div></div>'
      + (filteredFiles.length > 0
        ? '<div class="table-scroll"><table><thead><tr><th>Target</th><th>Findings</th><th>Min Score</th><th>Failing rules</th></tr></thead><tbody>' + hotspotRows + '</tbody></table></div>'
        : '<p class="muted">' + (failingOnly && selectedMode === 'file' && !fileSearch && run.files.length > 0
          ? 'All ' + run.files.length + ' file(s) passed every check. Uncheck "Failing only" to inspect all files.'
          : 'No targets match the current filter.') + '</p>')
      + '</div>'
      + '</div>'
      + '<details style="margin-top:14px"' + (series.points.length <= 10 ? ' open' : '') + '>'
      + '<summary class="panel-summary" style="font-size:.9rem"><span><strong>Run history</strong> (' + series.points.length + ' snapshots)</span></summary>'
      + '<div class="table-scroll" style="margin-top:8px"><table><thead><tr><th>Timestamp</th><th>Commit / Branch</th><th>Scope</th><th>Findings</th><th>Delta</th><th>Calibrated</th><th>Judge version</th><th>Cost</th></tr></thead><tbody>' + runRows + '</tbody></table></div>'
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
      '<button type="button" class="tab-btn' + (m === heatmapMode ? ' active' : '') + '" data-heat-mode="' + esc(m) + '">' + esc(m === 'code' ? 'modules (code)' : m) + '</button>'
    ).join('');
    const groupOptions = '<option value="">All rubrics</option>' + groups.map((g) =>
      '<option value="' + esc(g) + '"' + (g === heatGroup ? ' selected' : '') + '>' + esc(g) + '</option>'
    ).join('');

    const headerCols = map.repos.map((r) => '<th class="numeric">' + esc(r) + '</th>').join('');
    const bodyRows = visibleRows.map((row) => {
      const label = row.instructions
        ? '<span class="tip-wrap"><span class="tip-trigger" tabindex="0">' + esc(row.check_id) + '</span><div class="tip-card"><strong>' + esc(row.instructions) + '</strong><div class="tip-pass"><strong>Pass:</strong> ' + esc(row.pass_criteria) + '</div><div class="tip-fail"><strong>Fail:</strong> ' + esc(row.fail_criteria) + '</div></div></span>'
        : '<code>' + esc(row.check_id) + '</code>';
      const thrBadge = Math.abs(row.threshold - 80) > 1e-9
        ? '<span class="pill warn">&ge;' + fmtThr(row.threshold) + '</span>'
        : '<span class="pill neutral">&ge;' + fmtThr(row.threshold) + '</span>';
      const cells = map.repos.map((rName) => {
        const c = row.by_repo[rName];
        if (!c) return '<td class="numeric muted">—</td>';
        const col = heatColors(c.pass_rate);
        const topLine = c.failed === 0 ? 'clean' : c.failed + '/' + c.total + ' fail';
        const subLine = c.failed === 0
          ? 'score ' + (typeof c.mean_score === 'number' ? fmtScoreVal(c.mean_score) : '—')
          : c.hard_failed + 'e · ' + c.borderline_failed + 'w · ' + pct(c.pass_rate, 0);
        return '<td class="numeric"><span class="heat-cell" style="background:' + col.bg + ';color:' + col.fg + '" title="Findings: ' + c.failed + '/' + c.total + ' (' + c.hard_failed + ' errors, ' + c.borderline_failed + ' warnings) | Calibrated ' + pct(c.pass_rate) + ' | Mean score ' + (typeof c.mean_score === 'number' ? fmtScoreVal(c.mean_score) + '/100' : '—') + '"><strong>' + esc(topLine) + '</strong><span>' + esc(subLine) + '</span></span></td>';
      }).join('');
      return '<tr><td>' + label + (row.rubric_slug ? ' <span class="muted" style="font-size:.75rem">' + esc(row.rubric_slug) + '</span>' : '') + '</td><td class="numeric">' + thrBadge + '</td>' + cells + '</tr>';
    }).join('');

    container.innerHTML =
      '<div class="controls">'
      + '<div class="tabs">' + modeTabs + '</div>'
      + '<select id="heat-group-select" aria-label="Filter rubric group">' + groupOptions + '</select>'
      + '<input type="search" id="heat-search-input" placeholder="Search rule ID..." value="' + esc(heatSearch) + '">'
      + '<span class="muted numeric" style="margin-left:auto">' + visibleRows.length + ' of ' + map.rows.length + ' rules</span>'
      + '</div>'
      + '<div class="table-scroll"><table><thead><tr><th>Rule</th><th>Threshold</th>' + headerCols + '</tr></thead><tbody>' + bodyRows + '</tbody></table></div>';
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
      const scoreRange = typeof c.min_score === 'number' && typeof c.max_score === 'number'
        ? (fmtScoreVal(c.min_score) === fmtScoreVal(c.max_score)
          ? fmtScoreVal(c.min_score)
          : fmtScoreVal(c.min_score) + '..' + fmtScoreVal(c.max_score))
        : '—';
      const marginClass = c.margin === null ? 'neutral' : c.margin >= 15 ? 'pass' : c.margin >= 0 ? 'warn' : 'fail';
      const jitterClass = c.jitter === null ? 'neutral' : c.jitter <= 5 ? 'pass' : c.jitter <= 15 ? 'warn' : 'fail';
      return '<tr>'
        + '<td><code>' + esc(c.fixture_id) + '</code></td>'
        + '<td><code>' + esc(c.check_id) + '</code></td>'
        + '<td><span class="pill neutral">' + esc(c.expected) + '</span></td>'
        + '<td class="numeric"><span class="pill ' + (c.passed ? 'pass' : 'fail') + '">' + c.matches + '/' + c.repeats + '</span></td>'
        + '<td class="numeric">' + esc(scoreRange) + '</td>'
        + '<td class="numeric">' + (c.pass_threshold !== null ? '&ge;' + fmtThr(c.pass_threshold) : '—') + '</td>'
        + '<td class="numeric"><span class="pill ' + marginClass + '">' + (c.margin !== null ? (c.margin >= 0 ? '+' : '') + fmtScoreVal(c.margin) : '—') + '</span></td>'
        + '<td class="numeric"><span class="pill ' + jitterClass + '">' + (c.jitter !== null ? fmtScoreVal(c.jitter) : '—') + '</span></td>'
        + '</tr>';
    }).join('');

    container.innerHTML =
      '<div class="chart-box">'
      + '<div class="chart-legend">'
      + '<span class="legend-item"><span class="legend-swatch" style="background:#15803d"></span>Fixture check pass rate</span>'
      + '<span class="legend-item"><span class="legend-swatch" style="background:#ea580c"></span>Max repeat jitter</span>'
      + '<span class="muted numeric" style="margin-left:auto">Latest: ' + esc(shortDate(latest.timestamp)) + ' · ' + latest.fixtures_passed + '/' + latest.fixtures_total + ' fixtures · ' + latest.checks_passed + '/' + latest.checks_total + ' checks · repeats=' + latest.repeats + ' · min margin=' + (latest.min_margin !== null ? fmtScoreVal(latest.min_margin) : '—') + ' · max jitter=' + (latest.max_jitter !== null ? fmtScoreVal(latest.max_jitter) : '—') + '</span>'
      + '</div>'
      + '<div class="svg-wrap">' + renderFixtureTrendSvg(fx.points) + '</div>'
      + '</div>'
      + '<div class="table-scroll"><table><thead><tr><th>Fixture</th><th>Check</th><th>Expect</th><th>Repeats</th><th>Score range</th><th>Threshold</th><th>Margin</th><th>Jitter</th></tr></thead><tbody>' + rows + '</tbody></table></div>';
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

  document.addEventListener('input', (ev) => {
    const t = ev.target;
    if (!t) return;
    if (t.id === 'file-search-input') {
      fileSearch = t.value;
      const pos = t.selectionStart;
      renderRepoDetail();
      const el = document.getElementById('file-search-input');
      if (el) { el.focus(); if (typeof pos === 'number') el.setSelectionRange(pos, pos); }
    } else if (t.id === 'module-search-input') {
      moduleSearch = t.value;
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
      renderRepoDetail();
    } else if (t.id === 'module-failing-only-toggle') {
      moduleFailingOnly = t.checked;
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
  const showModuleCol = model.modes_present.includes('code');

  const repoOverviewRows = model.repos.map((repo) => {
    const fileSeries = repo.by_mode.file;
    const structSeries = repo.by_mode.structure;
    const codeSeries = repo.by_mode.code;

    const formatModeFindingsCell = (series: RepoModeSeries | undefined, kind: JudgeMode): string => {
      if (!series) return '<span class="muted">—</span>';
      const p = series.latest;
      const delta = renderDeltaFindingsBadge(p.delta_findings, p.version_changed);
      let sub = '';
      if (kind === 'file') {
        sub = `${p.affected_targets}/${p.file_count} files`;
      } else if (kind === 'code' && repo.module_architecture) {
        const arch = repo.module_architecture;
        const bits = [`${arch.modules_with_findings}/${arch.total_modules} modules`];
        if (arch.skipped_modules > 0) bits.push(`${arch.skipped_modules} skipped`);
        if (arch.errored_modules > 0) bits.push(`${arch.errored_modules} err`);
        sub = bits.join(' · ');
      }
      return `<div><div class="badge-row">${renderFindingsBadges(p.findings)} ${delta}</div>${sub ? `<div class="muted numeric" style="font-size:.74rem;margin-top:2px">${escapeHtml(sub)}</div>` : ''}</div>`;
    };

    const worstRulesCell = repo.worst_rules.length > 0
      ? `<div class="fail-chips">${repo.worst_rules.slice(0, 2).map((wr) =>
        `<span class="fail-chip ${wr.hard > 0 ? 'fail-chip-hard' : 'fail-chip-borderline'}" title="${escapeHtml(`${wr.mode}: ${wr.hard} errors, ${wr.borderline} warnings`)}">${escapeHtml(wr.check_id)} (${wr.failed})</span>`,
      ).join('')}</div>`
      : '<span class="pill pass">clean</span>';

    const modeCells = [
      `<td>${formatModeFindingsCell(fileSeries, 'file')}</td>`,
      `<td>${formatModeFindingsCell(structSeries, 'structure')}</td>`,
      ...(showModuleCol ? [`<td>${formatModeFindingsCell(codeSeries, 'code')}</td>`] : []),
    ].join('');

    return `<tr class="repo-row" data-repo="${escapeHtml(repo.name)}">
      <td><strong>${escapeHtml(repo.name)}</strong><div class="muted" style="font-size:.75rem">${repo.total_runs} run(s) · ${escapeHtml(repo.latest_timestamp.slice(0, 10))}</div></td>
      <td><code>${escapeHtml(repo.latest_commit_short)}</code>${repo.latest_dirty ? ' <span class="pill warn">dirty</span>' : ''}${repo.latest_branch ? `<div class="muted" style="font-size:.75rem">${escapeHtml(repo.latest_branch)}</div>` : ''}</td>
      <td>${renderFindingsBadges(repo.total_findings)}</td>
      ${modeCells}
      <td>${worstRulesCell}</td>
      <td>${renderInstalledBadge(repo, latestTag)}</td>
    </tr>`;
  }).join('');

  const warningsHtml = model.warnings.length > 0
    ? `<div class="warn-banner"><strong>Snapshot warnings (${model.warnings.length}):</strong> ${escapeHtml(model.warnings.join(' | '))}</div>`
    : '';

  const totalFindings = model.totals.total_findings;
  const modFindings = model.totals.module_findings;
  const findingsKpiClass = totalFindings.hard > 0
    ? ' kpi-danger'
    : totalFindings.borderline > 0
      ? ' kpi-alert'
      : '';
  const modKpiClass = modFindings.hard > 0 || model.totals.modules_errored > 0
    ? ' kpi-danger'
    : modFindings.borderline > 0 || model.totals.modules_skipped > 0
      ? ' kpi-alert'
      : '';

  const modKpiValue = model.totals.modules_scanned > 0
    ? `${modFindings.total} finding${modFindings.total === 1 ? '' : 's'}`
    : 'Not scanned';
  const modKpiNote = model.totals.modules_scanned > 0
    ? `${model.totals.modules_with_findings}/${model.totals.modules_scanned} modules · ${modFindings.hard} errors · ${modFindings.borderline} warnings`
      + (model.totals.modules_skipped > 0 ? ` · ${model.totals.modules_skipped} skipped` : '')
      + (model.totals.modules_errored > 0 ? ` · ${model.totals.modules_errored} err` : '')
    : 'Configure modules / moduleRoots for arch checks';

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'">
<title>Rubric Quality Punch-List · agent-tooling</title><style>${STYLE}</style></head><body><main>
<header>
  <div class="title-row"><h1>Rubric Quality Punch-List</h1><span class="pill-header">Offline · Local</span></div>
  <div class="meta-bar">
    <span>agent-tooling <strong>${escapeHtml(model.catalog.agent_tooling.judge_version)}</strong></span>
    <span>Latest tag <strong>${escapeHtml(latestTag ?? 'none')}</strong></span>
    <span>Authoritative rubrics <strong>${model.catalog.rubrics.length}</strong></span>
    <span>Recorded spend <strong>${escapeHtml(fmtUsd(model.totals.total_cost_usd))}</strong></span>
    <span>Built <strong>${escapeHtml(model.generated_at.replace('T', ' ').slice(0, 19))}Z</strong></span>
  </div>
</header>

${warningsHtml}

<section class="kpi-strip" aria-label="Dashboard punch-list overview">
  <div class="kpi${findingsKpiClass}"><div class="kpi-label">Open findings</div><div class="kpi-value${findingsTone(totalFindings)}">${totalFindings.total}</div><div class="kpi-note">${totalFindings.hard} errors · ${totalFindings.borderline} warnings across ${model.totals.repo_count} repo(s)</div></div>
  <div class="kpi${modKpiClass}"><div class="kpi-label">Module architecture</div><div class="kpi-value${model.totals.modules_scanned > 0 ? findingsTone(modFindings) : ''}">${escapeHtml(modKpiValue)}</div><div class="kpi-note">${escapeHtml(modKpiNote)}</div></div>
  <div class="kpi"><div class="kpi-label">Findings by scope</div><div class="kpi-value">${model.totals.repo_count} repo(s)</div><div class="kpi-note">${model.totals.file_findings.total} file · ${model.totals.structure_findings.total} structure · ${modFindings.total} module (${model.totals.repo_runs} runs)</div></div>
  <div class="kpi${model.totals.outdated_repos > 0 ? ' kpi-alert' : ''}"><div class="kpi-label">Installed judge-code</div><div class="kpi-value ${model.totals.outdated_repos === 0 ? 'tone-good' : 'tone-warn'}">${model.totals.outdated_repos === 0 ? 'Up to date' : `${model.totals.outdated_repos} outdated`}</div><div class="kpi-note">Latest release tag: ${escapeHtml(latestTag ?? 'n/a')}</div></div>
  <div class="kpi${fxLatest && fxLatest.status === 'failed' ? ' kpi-alert' : ''}"><div class="kpi-label">Rubric fixtures</div><div class="kpi-value${fxLatest ? (fxLatest.status === 'passed' ? ' tone-good' : ' tone-bad') : ''}">${fxLatest ? `${fxLatest.checks_passed}/${fxLatest.checks_total}` : '—'}</div><div class="kpi-note">${fxLatest ? `min margin ${fxLatest.min_margin !== null ? fxLatest.min_margin.toFixed(1) : '—'} · max jitter ${fxLatest.max_jitter !== null ? fxLatest.max_jitter.toFixed(1) : '—'}` : 'No fixture runs yet'}</div></div>
</section>

<section class="panel">
  <div class="panel-head"><h2>Repositories punch-list (worst-first)</h2><span class="muted">Click any repository to inspect Feature / Module Architecture, worst-offending rules, hotspot files, and trends (* = rubric/judge change)</span></div>
  ${model.repos.length > 0
    ? `<div class="table-scroll"><table><thead><tr><th>Repository</th><th>Latest commit</th><th>Open findings</th><th>File mode</th><th>Structure mode</th>${showModuleCol ? '<th>Module architecture</th>' : ''}<th>Worst rules</th><th>Installed judge-code</th></tr></thead><tbody>${repoOverviewRows}</tbody></table></div>`
    : '<div class="empty-state">No repository snapshots found in <code>runs/*.json</code>.</div>'}
</section>

<section class="panel">
  <div class="panel-head"><h2>Repository punch-list, module architecture &amp; trends</h2></div>
  <div id="repo-detail-root"></div>
</section>

<section class="panel">
  <div class="panel-head"><h2>Cross-repo rule heatmap (latest runs, worst-first)</h2><span class="muted">Failing targets, errors/warnings split &amp; thresholds per rule</span></div>
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
