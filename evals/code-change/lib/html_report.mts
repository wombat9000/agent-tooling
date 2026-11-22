/** Build a standalone, offline HTML report from saved judge requests and scores. */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { highlightKotlinLines } from './highlight_kotlin.mts';

interface Check {
  choice: string;
  pass_probability: number;
  confidence: number;
  files_passed?: number;
  files_total?: number;
  min_pass_probability?: number;
}
interface Question {
  instructions: string;
  criteria: { pass: string; fail: string };
}
interface SavedFileResult {
  file: string;
  status: string;
  pass_rate: number | null;
  checks: Record<string, Check> | null;
  error?: string;
}
interface SavedResult {
  status: string;
  target?: string;
  scope?: string;
  file_count?: number;
  requested_model: string;
  returned_model: string | null;
  rubric: string;
  deterministic: Record<string, number>;
  quality: { pass_rate: number; all_files_pass_rate?: number; checks: Record<string, Check> } | null;
  file_results?: SavedFileResult[];
  error?: string;
}
interface SavedRequest {
  model: string;
  state: {
    task: string;
    review?: string;
    requirement: string;
    scope?: string;
    production_files?: Record<string, string>;
  };
  questions: Record<string, Question>;
}
interface Trial {
  trial: string;
  task: string;
  status: string;
  error: string | null;
  result: SavedResult | null;
  request: SavedRequest | null;
}

function readJson(path: string) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

/** Find the newest saved judgment, excluding request-only dry runs and pending batches. */
export function latestJudgment(root: string): string {
  const candidates: Array<{ directory: string; modified: number }> = [];
  if (existsSync(root)) {
    for (const group of readdirSync(root, { withFileTypes: true })) {
      if (!group.isDirectory()) continue;
      for (const entry of readdirSync(join(root, group.name), { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const directory = join(root, group.name, entry.name);
        const summary = join(directory, 'summary.json');
        const result = join(directory, 'result.json');
        if (existsSync(summary)) {
          const data = readJson(summary);
          if (data.reports?.some((trial: { status: string }) => ['scored', 'error', 'missing_report'].includes(trial.status))) {
            candidates.push({ directory, modified: statSync(summary).mtimeMs });
          }
        } else if (existsSync(result) && ['scored', 'error', 'missing_report'].includes(readJson(result).status)) {
          candidates.push({ directory, modified: statSync(result).mtimeMs });
        }
      }
    }
  }
  candidates.sort((a, b) => b.modified - a.modified || a.directory.localeCompare(b.directory));
  if (!candidates.length) throw new Error('No saved judge scores. Run pnpm eval judge --latest first.');
  return candidates[0].directory;
}

interface RunMetadata {
  condition: { label: string; kind: 'skill' | 'baseline' | 'oracle' | 'neutral' } | null;
  agent: string | null;
}

function readRunMetadata(source: string): RunMetadata {
  const name = basename(source);
  let condition: RunMetadata['condition'] = null;
  let agent: string | null = null;
  const configPath = join(source, 'config.json');
  if (existsSync(configPath)) {
    try {
      const config = readJson(configPath);
      const firstAgent = Array.isArray(config.agents) ? config.agents[0] : null;
      if (firstAgent && typeof firstAgent === 'object') {
        const agentName = typeof firstAgent.name === 'string' ? firstAgent.name : null;
        const modelName = typeof firstAgent.model_name === 'string' ? firstAgent.model_name : null;
        const effort = typeof firstAgent.kwargs?.reasoning_effort === 'string' ? firstAgent.kwargs.reasoning_effort : null;
        const skills = Array.isArray(firstAgent.skills) ? firstAgent.skills : [];
        if (agentName) {
          const details = [modelName, effort].filter(Boolean).join(', ');
          agent = details ? `${agentName} (${details})` : agentName;
        }
        if (agentName === 'oracle') condition = { label: 'Oracle', kind: 'oracle' };
        else if (skills.length > 0) condition = { label: 'Skill', kind: 'skill' };
        else if (agentName) condition = { label: 'Baseline', kind: 'baseline' };
      }
    } catch {
      // Optional metadata; fall back to folder name heuristics.
    }
  }
  if (!condition) {
    if (name.startsWith('run-skill-') || name.startsWith('canary-')) condition = { label: 'Skill', kind: 'skill' };
    else if (name.startsWith('run-baseline-')) condition = { label: 'Baseline', kind: 'baseline' };
    else if (name.startsWith('oracle-')) condition = { label: 'Oracle', kind: 'oracle' };
  }
  return { condition, agent };
}

function shortRunId(source: string): string {
  const name = basename(source);
  const match = /^(run-skill|run-baseline|oracle|canary|nop)-([0-9a-f]{8})-/i.exec(name);
  return match ? `${match[1]}-${match[2]}` : name;
}

/** Read historical rubric text from request.json, never from the current task files. */
function loadTrials(directory: string): { source: string; model: string; scope: string | null; meta: RunMetadata; trials: Trial[] } {
  const summaryPath = join(directory, 'summary.json');
  if (!statSync(directory, { throwIfNoEntry: false })?.isDirectory()
    || ![summaryPath, join(directory, 'result.json'), join(directory, 'request.json')].some((path) => existsSync(path))) {
    throw new Error(`No saved judge data in ${directory}. Choose a judge output directory or use --latest.`);
  }
  const summary = existsSync(summaryPath) ? readJson(summaryPath) : null;
  const entries = summary ? summary.reports : [{ trial: basename(directory), result_dir: directory }];
  if (!Array.isArray(entries) || !entries.length) throw new Error('No trial data to report.');
  const trials: Trial[] = entries.map((entry) => {
    const trialDirectory = resolve(entry.result_dir);
    const resultPath = join(trialDirectory, 'result.json');
    const requestPath = join(trialDirectory, 'request.json');
    const result: SavedResult | null = existsSync(resultPath) ? readJson(resultPath) : null;
    const request: SavedRequest | null = existsSync(requestPath) ? readJson(requestPath) : null;
    const status = result?.status ?? entry.status ?? 'pending';
    if (status === 'scored' && (!result?.quality || !request)) {
      throw new Error(`Scored trial is missing its request or quality data: ${entry.trial}`);
    }
    return {
      trial: String(entry.trial), task: String(entry.task ?? request?.state.task ?? 'Review'),
      status, error: result?.error ?? entry.error ?? null, result, request,
    };
  });
  const source = summary?.source_run ?? directory;
  return {
    source,
    model: summary?.model ?? trials[0].result?.requested_model ?? trials[0].request?.model ?? 'Unknown',
    scope: summary?.scope ?? trials[0].result?.scope ?? trials[0].request?.state.scope ?? null,
    meta: readRunMetadata(source),
    trials,
  };
}

/** Escape all saved content, including Markdown, before placing it in HTML or attributes. */
function escape(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]!);
}

function percent(value: number | null | undefined): string {
  return typeof value === 'number' && Number.isFinite(value) ? `${(value * 100).toFixed(1)}%` : '—';
}

function wholePercent(value: number | null | undefined): string {
  return typeof value === 'number' && Number.isFinite(value) ? `${Math.round(value * 100)}%` : '—';
}

function shortTrialLabel(name: string, index: number): string {
  const parts = name.split('__');
  if (parts.length > 1 && parts[parts.length - 1]) return parts[parts.length - 1];
  return name.length <= 16 ? name : `#${index + 1}`;
}

function labelForCheck(id: string): string {
  return id.replaceAll('_', ' ');
}

function state(trial: Trial): string {
  if (trial.status !== 'scored') return 'unscored';
  return trial.result!.quality!.pass_rate === 1 ? 'passed' : 'attention';
}

function clampProb(value: number | null | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value * 100)));
}

function probBarHtml(prob: number | null | undefined, choice?: string, minProb?: number): string {
  const pct = clampProb(prob);
  const fillClass = choice === 'pass' ? 'bar-pass' : choice === 'fail' ? 'bar-fail' : 'bar-neutral';
  const minNote = minProb !== undefined ? `<span class="sub-metric">min ${percent(minProb)}</span>` : '';
  return `<div class="prob-cell"><div class="bar-track" aria-hidden="true"><div class="bar-fill ${fillClass}" style="width:${pct}%"></div></div><span class="numeric prob-val">${percent(prob)}</span>${minNote}</div>`;
}

function lowestFileForCheck(trial: Trial, checkId: string): { file: string; prob: number } | null {
  const files = trial.result?.file_results;
  if (!files?.length) return null;
  let worst: { file: string; prob: number } | null = null;
  for (const fr of files) {
    const c = fr.checks?.[checkId];
    if (!c) continue;
    if (!worst || c.pass_probability < worst.prob) {
      worst = { file: fr.file, prob: c.pass_probability };
    }
  }
  return worst;
}

function checkMatrixHtml(trials: Trial[]): string {
  const checkIds: string[] = [];
  const questionsById = new Map<string, Question>();
  const seen = new Set<string>();
  for (const trial of trials) {
    const keys = Object.keys(trial.result?.quality?.checks ?? trial.request?.questions ?? {});
    for (const key of keys) {
      if (!seen.has(key)) {
        seen.add(key);
        checkIds.push(key);
      }
      const q = trial.request?.questions?.[key];
      if (q && !questionsById.has(key)) questionsById.set(key, q);
    }
  }
  if (!checkIds.length) return '';
  const stats = checkIds.map((id) => {
    const present = trials.map((trial, index) => ({ index, trial, check: trial.result?.quality?.checks?.[id] }));
    const scored = present.filter((entry) => entry.check !== undefined);
    const passed = scored.filter((entry) => entry.check!.choice === 'pass').length;
    const meanProb = scored.length
      ? scored.reduce((sum, entry) => sum + entry.check!.pass_probability, 0) / scored.length
      : null;
    const passRate = scored.length ? passed / scored.length : 1;
    return { id, present, scored: scored.length, passed, passRate, meanProb };
  });
  stats.sort((a, b) => a.passRate - b.passRate || (a.meanProb ?? 1) - (b.meanProb ?? 1));

  const trialHeaders = trials.map((trial, index) =>
    `<th scope="col" class="matrix-col" title="${escape(trial.trial)}"><a class="trial-jump" href="#trial-${index}" data-jump="trial-${index}">${escape(shortTrialLabel(trial.trial, index))}</a></th>`,
  ).join('');

  const rows = stats.map((row) => {
    const question = questionsById.get(row.id);
    const labelHtml = question
      ? `<span class="tip-wrap"><span class="tip-trigger" tabindex="0">${escape(labelForCheck(row.id))}</span><div class="tip-card" role="tooltip"><div class="tip-q">${escape(question.instructions)}</div><div class="tip-crit tip-pass"><strong>Pass when</strong><p>${escape(question.criteria.pass)}</p></div><div class="tip-crit tip-fail"><strong>Fail when</strong><p>${escape(question.criteria.fail)}</p></div></div></span>`
      : escape(labelForCheck(row.id));

    const cells = row.present.map(({ index, trial, check }) => {
      if (!check) return `<td class="matrix-cell"><span class="pill neutral">—</span></td>`;
      const cls = check.choice === 'pass' ? 'pass' : 'fail';
      const pFail = Math.max(0, Math.min(1, 1 - check.pass_probability));
      const worst = check.files_total !== undefined ? lowestFileForCheck(trial, row.id) : null;
      const filesLine = check.files_total !== undefined
        ? `<div class="cell-pop-row"><span>Files passed</span><strong>${check.files_passed}/${check.files_total}</strong></div>`
        : '';
      const worstLine = worst
        ? `<div class="cell-pop-row cell-pop-file"><span>Lowest</span><strong>${escape(worst.file)} (${percent(worst.prob)})</strong></div>`
        : '';
      const pop = `<div class="cell-pop" role="tooltip"><div class="cell-pop-row"><span>P(pass)</span><strong>${percent(check.pass_probability)}</strong></div><div class="cell-pop-row"><span>P(fail)</span><strong>${percent(pFail)}</strong></div><div class="cell-pop-row"><span>Confidence</span><strong>${percent(check.confidence)}</strong></div>${filesLine}${worstLine}</div>`;
      return `<td class="matrix-cell"><span class="cell-wrap"><a class="pill ${cls} trial-jump" href="#trial-${index}" data-jump="trial-${index}">${escape(check.choice)} ${wholePercent(check.pass_probability)}</a>${pop}</span></td>`;
    }).join('');
    const ratioClass = row.scored > 0 && row.passed === row.scored ? 'pass' : row.scored > 0 ? 'fail' : 'neutral';
    return `<tr>
      <td class="check-label-cell">${labelHtml}</td>
      <td class="numeric"><span class="badge ${ratioClass}">${row.passed}/${row.scored}</span></td>
      <td>${probBarHtml(row.meanProb, row.scored > 0 ? (row.passed === row.scored ? 'pass' : 'fail') : undefined)}</td>
      ${cells}
    </tr>`;
  }).join('');

  return `<section class="panel"><h2>Check × Trial matrix</h2><div class="matrix-wrap"><table class="matrix-table"><thead><tr><th scope="col">Check</th><th scope="col">Passed</th><th scope="col">Mean P(pass)</th>${trialHeaders}</tr></thead><tbody>${rows}</tbody></table></div><p class="note">Sorted by lowest pass rate first. Hover any check for rubric criteria or any cell for probabilities; click a cell to jump to that trial.</p></section>`;
}

function checkRowHtml(id: string, question: Question, check: Check | undefined, showFilesCol: boolean): string {
  const choice = check?.choice ?? 'Not scored';
  const badgeClass = choice === 'pass' ? 'pass' : choice === 'fail' ? 'fail' : 'neutral';
  const rowClass = choice === 'fail' ? 'row-fail' : '';
  const filesCell = showFilesCol
    ? `<td class="numeric">${check?.files_total !== undefined ? `Files passed <strong>${check.files_passed}/${check.files_total}</strong>` : '—'}</td>`
    : '';
  return `<tr class="${rowClass}">
    <td class="check-name-col">
      <div class="check-title">${escape(labelForCheck(id))}</div>
      <details class="criteria-toggle">
        <summary>Rubric criteria</summary>
        <div class="criteria-body">
          <p class="question">${escape(question.instructions)}</p>
          <div class="criteria"><div><h5>Pass when</h5><p>${escape(question.criteria.pass)}</p></div><div><h5>Fail when</h5><p>${escape(question.criteria.fail)}</p></div></div>
        </div>
      </details>
    </td>
    <td><span class="badge ${badgeClass}">${escape(choice)}</span></td>
    <td>${probBarHtml(check?.pass_probability, check?.choice, check?.min_pass_probability)}</td>
    <td class="numeric">${percent(check?.confidence)}</td>
    ${filesCell}
  </tr>`;
}

function checksTableHtml(questions: Record<string, Question>, checks?: Record<string, Check>): string {
  const entries = Object.entries(questions);
  if (!entries.length) return '<p class="muted">No saved rubric yet. This trial has not been judged.</p>';
  const sorted = [...entries].sort(([idA], [idB]) => {
    const a = checks?.[idA];
    const b = checks?.[idB];
    const rank = (c?: Check) => (c?.choice === 'fail' ? 0 : c?.choice === 'pass' ? 2 : 1);
    return rank(a) - rank(b) || (a?.pass_probability ?? 1) - (b?.pass_probability ?? 1);
  });
  const showFilesCol = Boolean(checks && Object.values(checks).some((c) => c.files_total !== undefined));
  const filesHead = showFilesCol ? '<th scope="col">Files</th>' : '';
  const rows = sorted.map(([id, question]) => checkRowHtml(id, question, checks?.[id], showFilesCol)).join('');
  return `<div class="table-scroll"><table class="checks-table"><thead><tr><th scope="col">Check</th><th scope="col">Verdict</th><th scope="col">P(pass)</th><th scope="col">Confidence</th>${filesHead}</tr></thead><tbody>${rows}</tbody></table></div>`;
}

function codeLinesHtml(source: string, filePath?: string): string {
  const parsed = source.split('\n').map((line, idx) => {
    const match = /^(\d+): (.*)$/.exec(line);
    return { num: match ? match[1] : String(idx + 1), code: match ? match[2] : line };
  });
  const isKotlin = Boolean(filePath && /\.kts?$/i.test(filePath));
  const rendered = isKotlin
    ? highlightKotlinLines(parsed.map((entry) => entry.code))
    : parsed.map((entry) => escape(entry.code) || ' ');
  const rows = parsed.map((entry, idx) =>
    `<div class="code-line"><span class="ln">${escape(entry.num)}</span><span class="cl">${rendered[idx]}</span></div>`,
  ).join('');
  return `<div class="code-viewer" role="region" aria-label="Source code"><div class="code-lines">${rows}</div></div>`;
}

function productionFilesViewerHtml(trial: Trial, trialIndex: number): string {
  const productionFiles = trial.request?.state.production_files;
  const fileResults = trial.result?.file_results;
  const fileMap = new Map<string, SavedFileResult>();
  for (const fr of fileResults ?? []) fileMap.set(fr.file, fr);

  const filePaths = productionFiles && Object.keys(productionFiles).length
    ? Object.keys(productionFiles)
    : (fileResults ?? []).map((fr) => fr.file);
  if (!filePaths.length) return '';

  const hasPerFile = Boolean(fileResults?.length);
  const heading = hasPerFile
    ? `<h3>Per-file scores &amp; Production files (${filePaths.length})</h3>`
    : `<h3>Production files (${filePaths.length})</h3>`;

  const tabs = filePaths.map((filePath, fileIndex) => {
    const fr = fileMap.get(filePath);
    let pill = '';
    if (fr) {
      const checks = fr.checks ?? {};
      const passed = Object.values(checks).filter((c) => c.choice === 'pass').length;
      const total = Object.keys(checks).length;
      const cls = fr.status === 'scored' ? (fr.pass_rate === 1 ? 'pass' : 'fail') : 'neutral';
      const txt = fr.status === 'scored' ? `${passed}/${total}` : fr.status;
      pill = `<span class="tab-pill ${cls}">${escape(txt)}</span>`;
    }
    const active = fileIndex === 0 ? ' active' : '';
    const panelId = `t${trialIndex}-f${fileIndex}`;
    return `<button type="button" class="file-tab${active}" role="tab" aria-selected="${fileIndex === 0 ? 'true' : 'false'}" data-tab-group="t${trialIndex}" data-tab-target="${panelId}"><span class="tab-name">${escape(filePath)}</span>${pill}</button>`;
  }).join('');

  const panels = filePaths.map((filePath, fileIndex) => {
    const fr = fileMap.get(filePath);
    const code = productionFiles?.[filePath];
    const panelId = `t${trialIndex}-f${fileIndex}`;
    const hidden = fileIndex === 0 ? '' : ' hidden';
    let fileChecksHtml = '';
    if (fr) {
      const checks = fr.checks ?? {};
      const pills = Object.entries(checks)
        .sort(([, a], [, b]) => (a.choice === 'fail' ? 0 : 1) - (b.choice === 'fail' ? 0 : 1) || a.pass_probability - b.pass_probability)
        .map(([id, c]) => `<span class="pill ${c.choice === 'pass' ? 'pass' : 'fail'}">${escape(labelForCheck(id))}: ${escape(c.choice)} ${wholePercent(c.pass_probability)}</span>`)
        .join('');
      fileChecksHtml = `${fr.error ? `<p class="error">${escape(fr.error)}</p>` : ''}${pills ? `<div class="file-checks-strip">${pills}</div>` : ''}`;
    }
    return `<div class="file-panel" id="${panelId}" data-tab-group="t${trialIndex}" role="tabpanel"${hidden}>${fileChecksHtml}${code !== undefined ? codeLinesHtml(code, filePath) : '<p class="muted">Source not saved.</p>'}</div>`;
  }).join('');

  return `<section class="code-section">${heading}<div class="file-tabs" role="tablist">${tabs}</div>${panels}</section>`;
}

function artifactSectionHtml(trial: Trial, index: number): string {
  const productionFiles = trial.request?.state.production_files;
  if ((productionFiles && Object.keys(productionFiles).length) || trial.result?.file_results?.length) {
    return productionFilesViewerHtml(trial, index);
  }
  return `<details class="context review" open><summary>Original review</summary><pre>${escape(trial.request?.state.review ?? 'No saved review.')}</pre></details>`;
}

function trialHtml(trial: Trial, index: number): string {
  const result = trial.result;
  const checks = result?.quality?.checks;
  const questions = trial.request?.questions ?? {};
  const passed = checks ? Object.values(checks).filter((check) => check.choice === 'pass').length : 0;
  const score = result?.quality
    ? `${passed}/${Object.keys(checks!).length} checks · ${percent(result.quality.pass_rate)}`
    : trial.status.replaceAll('_', ' ');
  const deterministic = result?.deterministic?.reward;
  const scopeMeta = result?.scope
    ? `<span>Scope <strong>${escape(result.scope)}</strong></span><span>Files <strong>${escape(result.file_count ?? 0)}</strong></span>`
    : '';
  const strictMeta = result?.quality?.all_files_pass_rate !== undefined
    ? `<span>All-files-pass checks <strong>${percent(result.quality.all_files_pass_rate)}</strong></span>`
    : '';
  return `<details class="trial" data-task="${escape(trial.task)}" data-state="${state(trial)}" ${index === 0 ? 'open ' : ''}id="trial-${index}">
    <summary><span class="trial-name">${escape(trial.trial)}</span><span class="badge ${state(trial) === 'passed' ? 'pass' : state(trial) === 'attention' ? 'fail' : 'neutral'}">${escape(score)}</span></summary>
    <div class="trial-body"><div class="trial-meta"><span>Rubric <strong>${escape(result?.rubric ?? 'Pending')}</strong></span><span>Deterministic reward <strong>${deterministic === undefined ? '—' : escape(deterministic)}</strong></span><span>Returned model <strong>${escape(result?.returned_model ?? '—')}</strong></span>${scopeMeta}${strictMeta}</div>
    ${trial.error ? `<p class="error">${escape(trial.error)}</p>` : ''}
    <div class="section-bar"><h3>Rubric and scores</h3>${Object.keys(questions).length ? `<button type="button" class="mini-btn" data-toggle-criteria="trial-${index}">Show all criteria</button>` : ''}</div>
    ${checksTableHtml(questions, checks)}
    ${artifactSectionHtml(trial, index)}
    ${trial.request ? `<details class="context"><summary>Task requirement</summary><pre>${escape(trial.request.state.requirement)}</pre></details>` : ''}
    </div></details>`;
}

const STYLE = `
:root{color-scheme:light;--ink:#16243b;--muted:#5c687b;--line:#dce3ed;--blue:#3158cf;--green:#116547;--green-bg:#e7f6ee;--amber:#9a3412;--amber-bg:#ffedd5;--fail-row:#fffaf5;--code-bg:#0f172a;--code-ink:#e2e8f0;--code-ln:#64748b;--code-bar:#1e293b}
*{box-sizing:border-box}
body{margin:0;background:#f4f6fa;color:var(--ink);font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
main{max-width:1360px;margin:0 auto;padding:24px 28px 64px}
header{border-top:3px solid var(--blue);padding:14px 0 16px}
.title-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
h1{font-size:1.6rem;line-height:1.2;letter-spacing:-.03em;margin:0}
.cond-badge{display:inline-flex;align-items:center;padding:3px 9px;border-radius:999px;font-size:.75rem;font-weight:700;letter-spacing:.06em;text-transform:uppercase}
.cond-skill{background:#e0e7ff;color:#1e40af}
.cond-baseline{background:#e2e8f0;color:#334155}
.cond-oracle{background:var(--green-bg);color:var(--green)}
.cond-neutral{background:#eef1f6;color:var(--muted)}
.meta-bar{display:flex;flex-wrap:wrap;gap:6px 16px;margin-top:8px;font-size:.825rem;color:var(--muted)}
.meta-bar strong{color:var(--ink);font-weight:600}
.meta-item{display:inline-flex;align-items:center;gap:4px}
h2{font-size:1.125rem;margin:0 0 12px}
h3{font-size:1rem;margin:18px 0 10px}
h5{font-size:.8125rem;margin:0 0 4px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em}
p{margin:6px 0}
.subtitle,.muted{color:var(--muted)}
.kpi-strip,.panel,.trial{background:white;border:1px solid var(--line);border-radius:12px}
.kpi-strip{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));margin-bottom:18px;overflow:hidden}
.kpi{padding:14px 18px;border-right:1px solid var(--line)}
.kpi:last-child{border-right:0}
.kpi-alert{background:#fff8f1}
.kpi-label{color:var(--muted);font-size:.78rem;font-weight:600;text-transform:uppercase;letter-spacing:.04em}
.kpi-value{font-size:1.65rem;font-weight:700;letter-spacing:-.03em;line-height:1.25;margin:2px 0}
.kpi-note{font-size:.78rem;color:var(--muted);line-height:1.35}
.tone-good{color:var(--green)}
.tone-warn{color:var(--amber)}
.tone-bad{color:#b91c1c}
.panel{padding:18px 20px;margin-bottom:18px}
.table-scroll{overflow-x:auto}
table{width:100%;border-collapse:collapse;text-align:left}
th{font-size:.8125rem;color:var(--muted);font-weight:600;white-space:nowrap}
th,td{padding:10px 12px;border-bottom:1px solid var(--line);vertical-align:top}
th:first-child,td:first-child{padding-left:0}
tbody tr:last-child td{border-bottom:0}
.numeric{font-variant-numeric:tabular-nums;white-space:nowrap}
.task-name{font-weight:600}
.note{font-size:.8125rem;color:var(--muted);margin:12px 0 0}
.filters{display:flex;gap:14px;align-items:end;flex-wrap:wrap;margin:20px 0 14px}
.field{display:flex;flex-direction:column;gap:5px;font-size:.8125rem;color:var(--muted)}
select,button{font:inherit;color:var(--ink);background:white;border:1px solid #b8c5d8;border-radius:7px;min-height:38px;padding:6px 12px}
select{appearance:none;min-width:180px;padding-right:36px;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='8'%3E%3Cpath d='m1 1 5 5 5-5' fill='none' stroke='%235c687b' stroke-width='2'/%3E%3C/svg%3E");background-position:right 12px center;background-repeat:no-repeat}
button{cursor:pointer}
button:hover{background:#edf2ff;border-color:var(--blue)}
.mini-btn{min-height:30px;padding:4px 10px;font-size:.8125rem}
:focus-visible{outline:3px solid #8da7ff;outline-offset:2px}
.trial{margin:12px 0;overflow:hidden}
.trial>summary{padding:14px 18px;display:flex;align-items:center;justify-content:space-between;gap:12px;cursor:pointer;list-style:none}
.trial>summary::-webkit-details-marker{display:none}
.trial>summary:before{content:'+';color:var(--blue);font-weight:700;width:14px}
.trial[open]>summary:before{content:'−'}
.trial-name{flex:1;font:600 .875rem/1.4 ui-monospace,SFMono-Regular,Consolas,monospace;overflow-wrap:anywhere}
.trial[open]>summary{border-bottom:1px solid var(--line);background:#f8faff}
.badge,.pill,.tab-pill{display:inline-flex;align-items:center;border-radius:5px;font-weight:600;white-space:nowrap}
.badge{padding:3px 8px;font-size:.8125rem;line-height:1.35}
.pill{padding:2px 8px;font-size:.78rem;line-height:1.4;text-decoration:none}
.tab-pill{padding:1px 6px;font-size:.75rem;line-height:1.35;margin-left:6px}
.pass{color:var(--green);background:var(--green-bg)}
.fail{color:var(--amber);background:var(--amber-bg)}
.neutral{color:var(--muted);background:#eef1f6}
.trial-body{padding:18px 20px}
.trial-meta{display:flex;gap:8px 20px;flex-wrap:wrap;font-size:.8125rem;color:var(--muted);margin-bottom:14px;padding-bottom:12px;border-bottom:1px solid var(--line)}
.trial-meta strong{color:var(--ink);font-weight:600;overflow-wrap:anywhere}
.section-bar{display:flex;align-items:center;justify-content:space-between;gap:12px;margin:6px 0 8px}
.section-bar h3{margin:0}
.matrix-wrap{overflow:visible}
.matrix-table td,.matrix-table th{vertical-align:middle}
.matrix-col,.matrix-cell{text-align:center}
.check-label-cell,.check-title{font-weight:600;text-transform:capitalize}
.tip-wrap,.cell-wrap{position:relative;display:inline-flex;align-items:center}
.tip-trigger{border-bottom:1px dotted #94a3b8;cursor:help;padding-bottom:1px}
.tip-trigger:hover,.tip-trigger:focus-visible{color:var(--blue);border-bottom-color:var(--blue)}
.tip-card{display:none;position:absolute;left:0;top:calc(100% + 8px);width:min(520px,78vw);padding:14px 16px;background:white;border:1px solid #cbd5e1;border-radius:10px;box-shadow:0 12px 28px rgba(15,23,42,.14),0 2px 6px rgba(15,23,42,.06);z-index:40;text-align:left;text-transform:none;font-weight:400;line-height:1.45;white-space:normal}
.tip-card::before{content:'';position:absolute;left:0;right:0;top:-10px;height:10px}
.tip-wrap:hover .tip-card,.tip-wrap:focus-within .tip-card{display:block}
.tip-q{font-size:.875rem;font-weight:600;color:var(--ink);margin-bottom:10px}
.tip-crit{padding:7px 10px;border-radius:6px;margin-top:6px;font-size:.8125rem}
.tip-crit strong{display:block;font-size:.72rem;text-transform:uppercase;letter-spacing:.05em;margin-bottom:2px}
.tip-crit p{margin:0;color:var(--ink);white-space:pre-wrap}
.tip-pass{background:#f0fdf4;border-left:3px solid #16a34a}
.tip-pass strong{color:var(--green)}
.tip-fail{background:#fff7ed;border-left:3px solid #ea580c}
.tip-fail strong{color:var(--amber)}
.cell-pop{display:none;position:absolute;left:50%;transform:translateX(-50%);top:calc(100% + 7px);min-width:190px;max-width:300px;padding:9px 11px;background:#0f172a;color:#e2e8f0;border-radius:8px;box-shadow:0 10px 24px rgba(15,23,42,.22);z-index:40;text-align:left;font-size:.78rem;line-height:1.45;pointer-events:none;white-space:nowrap}
.matrix-cell:last-child .cell-pop{left:auto;right:0;transform:none}
.cell-wrap:hover .cell-pop,.cell-wrap:focus-within .cell-pop{display:block}
.cell-pop-row{display:flex;justify-content:space-between;gap:14px;font-variant-numeric:tabular-nums}
.cell-pop-row span{color:#94a3b8}
.cell-pop-row strong{color:#f8fafc;font-weight:600}
.cell-pop-file{margin-top:4px;padding-top:4px;border-top:1px solid #334155;white-space:normal}
.cell-pop-file strong{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.74rem;text-align:right}
.trial-jump{color:inherit;text-decoration:none}
.trial-jump:hover{text-decoration:underline}
.prob-cell{display:flex;align-items:center;gap:8px;min-width:140px}
.bar-track{width:68px;height:7px;background:#e6ecf5;border-radius:999px;overflow:hidden;flex-shrink:0}
.bar-fill{height:100%;border-radius:999px}
.bar-pass{background:#16a34a}
.bar-fail{background:#ea580c}
.bar-neutral{background:#94a3b8}
.prob-val{font-size:.875rem;font-weight:600}
.sub-metric{font-size:.75rem;color:var(--muted);white-space:nowrap}
.checks-table tr.row-fail td{background:var(--fail-row)}
.check-name-col{min-width:260px}
.criteria-toggle{margin-top:4px}
.criteria-toggle>summary{cursor:pointer;font-size:.78rem;color:var(--blue);font-weight:500;list-style:none;display:inline-flex;align-items:center;gap:4px}
.criteria-toggle>summary::-webkit-details-marker{display:none}
.criteria-toggle>summary:before{content:'▸';font-size:.75rem}
.criteria-toggle[open]>summary:before{content:'▾'}
.criteria-body{margin-top:8px;padding:10px 12px;background:#f8fafc;border:1px solid var(--line);border-radius:8px}
.question{color:var(--ink);font-size:.875rem;margin:0 0 10px;white-space:pre-wrap}
.criteria{display:grid;grid-template-columns:1fr 1fr;gap:16px;padding-top:8px;border-top:1px solid var(--line)}
.criteria p{margin:0;font-size:.84rem;color:var(--muted);white-space:pre-wrap}
.code-section{margin:18px 0 14px}
.file-tabs{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:0;border-bottom:1px solid var(--line);padding-bottom:8px}
.file-tab{min-height:32px;padding:5px 10px;font:500 .8125rem/1.3 ui-monospace,SFMono-Regular,Consolas,monospace;border:1px solid var(--line);border-radius:7px;background:#f8fafc;color:var(--ink);display:inline-flex;align-items:center}
.file-tab:hover{background:#edf2ff;border-color:var(--blue)}
.file-tab.active{background:var(--code-bg);color:#f8fafc;border-color:var(--code-bg)}
.file-tab.active .tab-pill.pass{background:#14532d;color:#bbf7d0}
.file-tab.active .tab-pill.fail{background:#7c2d12;color:#fed7aa}
.file-panel{margin-top:8px}
.file-checks-strip{display:flex;flex-wrap:wrap;gap:6px;margin:8px 0}
.code-viewer{background:var(--code-bg);color:var(--code-ink);border-radius:9px;overflow-x:auto;padding:12px 0;font:13px/1.6 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.code-lines{display:table;width:100%}
.code-line{display:table-row}
.code-line:hover{background:rgba(255,255,255,.04)}
.ln{display:table-cell;width:1%;min-width:44px;padding:0 12px 0 14px;text-align:right;color:var(--code-ln);user-select:none;border-right:1px solid var(--code-bar);vertical-align:top}
.cl{display:table-cell;padding:0 16px 0 14px;white-space:pre;tab-size:4}
.tok-kw{color:#c084fc;font-weight:500}
.tok-ty{color:#fbbf24}
.tok-fn{color:#60a5fa}
.tok-str{color:#86efac}
.tok-num{color:#fb923c}
.tok-cm{color:#94a3b8;font-style:italic}
.tok-const{color:#67e8f9}
.tok-ann{color:#f472b6}
.context{margin:12px 0;border:1px solid var(--line);border-radius:8px}
.context>summary{cursor:pointer;padding:10px 14px;font-weight:600;font-size:.875rem;display:flex;align-items:center;justify-content:space-between;gap:10px}
.context pre{margin:0;padding:14px 16px;border-top:1px solid var(--line);background:#f8fafc;white-space:pre-wrap;overflow-wrap:anywhere;font:.84rem/1.6 ui-monospace,SFMono-Regular,Consolas,monospace}
.error{background:#fff0f0;color:#a02b32;padding:12px;border-radius:8px}
.count{font-size:.8125rem;color:var(--muted);margin-left:auto}
footer{font-size:.8125rem;color:var(--muted);margin-top:28px}
[hidden]{display:none!important}
@media(max-width:760px){main{padding:16px 14px 40px}.matrix-wrap{overflow-x:auto}.kpi-strip{grid-template-columns:repeat(2,minmax(0,1fr))}.kpi{padding:12px 14px;border-bottom:1px solid var(--line)}.kpi:nth-child(2n){border-right:0}.panel{padding:14px}.criteria{grid-template-columns:1fr;gap:12px}.trial-body{padding:14px}.count{margin-left:0}.trial-meta{flex-direction:column}}
@media print{body{background:white}main{max-width:none;padding:0}.filters,.mini-btn,.tip-card,.cell-pop{display:none!important}.panel,.trial{break-inside:avoid}.code-viewer{background:#f8fafc;color:var(--ink);border:1px solid var(--line)}.tok-kw{color:#6d28d9}.tok-ty{color:#b45309}.tok-fn{color:#1d4ed8}.tok-str{color:#15803d}.tok-num{color:#c2410c}.tok-cm{color:#64748b}.tok-const{color:#0e7490}.tok-ann{color:#be185d}}`;

const SCRIPT = `
const taskFilter=document.getElementById('task-filter');
const stateFilter=document.getElementById('state-filter');
const trials=[...document.querySelectorAll('.trial')];
function filter(){let visible=0;for(const trial of trials){trial.hidden=Boolean((taskFilter.value&&trial.dataset.task!==taskFilter.value)||(stateFilter.value&&trial.dataset.state!==stateFilter.value));if(!trial.hidden)visible++;}document.getElementById('visible-count').textContent=visible+' of '+trials.length+' trials';}
taskFilter.addEventListener('change',filter);stateFilter.addEventListener('change',filter);
document.getElementById('expand').addEventListener('click',()=>{for(const trial of trials)if(!trial.hidden)trial.open=true;});
document.getElementById('collapse').addEventListener('click',()=>{for(const trial of trials)trial.open=false;});
if(typeof document.addEventListener==='function'){
  document.addEventListener('click',(event)=>{
    const tab=event.target&&event.target.closest&&event.target.closest('.file-tab');
    if(tab){
      const group=tab.dataset.tabGroup;
      const target=tab.dataset.tabTarget;
      for(const btn of document.querySelectorAll('.file-tab[data-tab-group="'+group+'"]')){
        const active=btn===tab;
        btn.classList.toggle('active',active);
        btn.setAttribute('aria-selected',active?'true':'false');
      }
      for(const panel of document.querySelectorAll('.file-panel[data-tab-group="'+group+'"]')){
        panel.hidden=panel.id!==target;
      }
      return;
    }
    const toggle=event.target&&event.target.closest&&event.target.closest('[data-toggle-criteria]');
    if(toggle){
      const container=document.getElementById(toggle.dataset.toggleCriteria);
      if(!container)return;
      const boxes=[...container.querySelectorAll('.criteria-toggle')];
      const openAll=boxes.some((box)=>!box.open);
      for(const box of boxes)box.open=openAll;
      toggle.textContent=openAll?'Hide all criteria':'Show all criteria';
      return;
    }
    const jump=event.target&&event.target.closest&&event.target.closest('[data-jump]');
    if(jump){
      const target=document.getElementById(jump.dataset.jump);
      if(target){target.hidden=false;target.open=true;}
    }
  });
}
filter();`;

function scoreTone(rate: number | null): string {
  if (rate === null) return '';
  if (rate >= 0.9) return ' tone-good';
  if (rate >= 0.5) return ' tone-warn';
  return ' tone-bad';
}

/**
 * Write a self-contained HTML file from saved scores. Makes no API calls and leaves JSON intact.
 * All review/code/rubric content is escaped. Regeneration uses saved requests, not today's task rubric.
 */
export function writeHtmlReport(inputDirectory: string, outputFile?: string): string {
  const directory = resolve(inputDirectory);
  const output = outputFile ? resolve(outputFile) : join(directory, 'report.html');
  if (extname(output).toLowerCase() !== '.html') throw new Error('HTML output must end in .html');
  const { source, model, scope, meta, trials } = loadTrials(directory);
  const scored = trials.filter((trial) => trial.status === 'scored');
  const mean = scored.length ? scored.reduce((sum, trial) => sum + trial.result!.quality!.pass_rate, 0) / scored.length : null;
  const allPassed = scored.filter((trial) => trial.result!.quality!.pass_rate === 1).length;
  const detTotal = trials.filter((trial) => trial.result?.deterministic?.reward !== undefined).length;
  const detPassed = trials.filter((trial) => trial.result?.deterministic?.reward === 1).length;
  const errors = trials.filter((trial) => trial.status === 'error').length;
  const missing = trials.filter((trial) => trial.status === 'missing_report').length;
  const pending = trials.filter((trial) => trial.status === 'pending').length;
  const dryRuns = trials.filter((trial) => trial.status === 'dry_run').length;
  const unscored = trials.length - scored.length;
  const tasks = [...new Set(trials.map((trial) => trial.task))];
  const rubrics = [...new Set(trials.map((trial) => trial.result?.rubric).filter((r): r is string => Boolean(r)))];
  const taskRows = tasks.map((task) => {
    const group = trials.filter((trial) => trial.task === task);
    const judged = group.filter((trial) => trial.status === 'scored');
    const checks = judged.flatMap((trial) => Object.values(trial.result!.quality!.checks));
    const passed = checks.filter((check) => check.choice === 'pass').length;
    const taskMean = judged.length ? judged.reduce((sum, trial) => sum + trial.result!.quality!.pass_rate, 0) / judged.length : null;
    const deterministic = group.filter((trial) => trial.result?.deterministic?.reward === 1).length;
    return `<tr><td class="task-name">${escape(task)}</td><td class="numeric">${judged.length}/${group.length}</td><td class="numeric">${percent(taskMean)}</td><td class="numeric">${passed}/${checks.length}</td><td class="numeric">${deterministic}/${group.filter((trial) => trial.result).length}</td></tr>`;
  }).join('');
  const isCode = trials.some((trial) => trial.result?.target === 'production_code' || Boolean(trial.request?.state.production_files));
  const unitCap = isCode ? 'Trials' : 'Reviews';
  const unitLow = isCode ? 'trials' : 'reviews';

  const headingTitle = tasks.length === 1 ? tasks[0] : `Code-change ${isCode ? 'eval' : 'review'} report`;
  const condBadge = meta.condition
    ? `<span class="cond-badge cond-${meta.condition.kind}">${escape(meta.condition.label)}</span>`
    : '';
  const metaItems = [
    meta.agent ? `<span class="meta-item">Agent <strong>${escape(meta.agent)}</strong></span>` : '',
    `<span class="meta-item">Judge <strong>${escape(model)}</strong></span>`,
    scope ? `<span class="meta-item">Scope <strong>${escape(scope)}</strong></span>` : '',
    rubrics.length === 1 ? `<span class="meta-item">Rubric <strong>${escape(rubrics[0])}</strong></span>` : '',
    `<span class="meta-item" title="${escape(basename(source))}">Run <strong>${escape(shortRunId(source))}</strong></span>`,
  ].filter(Boolean).join('');

  const allPassedTone = scored.length ? scoreTone(allPassed / scored.length) : '';
  const detTone = detTotal ? scoreTone(detPassed / detTotal) : '';
  const fileCounts = scored.map((t) => t.result?.file_count).filter((n): n is number => typeof n === 'number');
  const fourthKpi = unscored > 0
    ? `<div class="kpi kpi-alert"><div class="kpi-label">Unscored ${unitLow}</div><div class="kpi-value tone-warn">${unscored}</div><div class="kpi-note">${errors} grading errors · ${missing} missing reports · ${pending} pending · ${dryRuns} dry runs</div></div>`
    : isCode && fileCounts.length
      ? (() => {
        const minF = Math.min(...fileCounts);
        const maxF = Math.max(...fileCounts);
        const range = minF === maxF ? `${minF}` : `${minF}–${maxF}`;
        const noun = maxF === 1 ? 'file' : 'files';
        return `<div class="kpi"><div class="kpi-label">Production files</div><div class="kpi-value">${range} <span class="muted" style="font-size:1rem;font-weight:500">${noun} / trial</span></div><div class="kpi-note">${scored.length}/${trials.length} scored · 0 errors</div></div>`;
      })()
      : `<div class="kpi"><div class="kpi-label">${unitCap} scored</div><div class="kpi-value tone-good">${scored.length}<span class="muted"> / ${trials.length}</span></div><div class="kpi-note">0 errors · 0 missing</div></div>`;

  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'">
  <title>${escape(headingTitle)}${meta.condition ? ` (${escape(meta.condition.label)})` : ''} · Eval report</title><style>${STYLE}</style></head><body><main>
  <header>
    <div class="title-row"><h1>${escape(headingTitle)}</h1>${condBadge}</div>
    <div class="meta-bar">${metaItems}</div>
  </header>
  <section class="kpi-strip" aria-label="Run overview">
    <div class="kpi"><div class="kpi-label">Mean trial score</div><div class="kpi-value${scoreTone(mean)}">${percent(mean)}</div><div class="kpi-note">${scored.length}/${trials.length} ${unitLow} scored</div></div>
    <div class="kpi"><div class="kpi-label">All checks passed</div><div class="kpi-value${allPassedTone}">${allPassed}<span class="muted"> / ${scored.length}</span></div><div class="kpi-note">100% rubric pass</div></div>
    <div class="kpi"><div class="kpi-label">Deterministic passes</div><div class="kpi-value${detTone}">${detTotal ? `${detPassed}<span class="muted"> / ${detTotal}</span>` : '—'}</div><div class="kpi-note">${isCode ? 'Gradle + contract tests' : 'Verifier reward'}</div></div>
    ${fourthKpi}
  </section>
  ${checkMatrixHtml(trials)}
  <section class="panel"><h2>Results by task</h2><div class="table-scroll"><table><thead><tr><th scope="col">Task</th><th scope="col">Scored</th><th scope="col">Mean score</th><th scope="col">Rubric checks passed</th><th scope="col">Deterministic passes</th></tr></thead><tbody>${taskRows}</tbody></table></div><p class="note">A trial score is the fraction of rubric questions marked pass (mean across files in per-file mode, where each aggregated check is pass only when every file passes). P(pass) and confidence are separate model signals, shown below. Unscored trials are excluded from averages. Judge accuracy and confidence thresholds are not yet calibrated.</p></section>
  <h2>Rubric and trial details</h2><div class="filters"><label class="field">Task<select id="task-filter"><option value="">All tasks</option>${tasks.map((task) => `<option value="${escape(task)}">${escape(task)}</option>`).join('')}</select></label><label class="field">Result<select id="state-filter"><option value="">All results</option><option value="attention">Some checks failed</option><option value="passed">All checks passed</option><option value="unscored">Not scored</option></select></label><button id="expand" type="button">Expand trials</button><button id="collapse" type="button">Collapse trials</button><span class="count" id="visible-count" aria-live="polite"></span></div>
  ${trials.map(trialHtml).join('')}
  <footer>Generated from saved requests and scores. Rubric text and artifacts are shown as recorded; no new judge calls were made to build this page.</footer>
  </main><script>${SCRIPT}</script></body></html>`;
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, html);
  return output;
}
